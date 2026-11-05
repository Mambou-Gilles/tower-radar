"""
Rain router signal monitor (router model: "the101").

How it works, in plain English:
  1. Opens the router's web page in a hidden Chrome window.
  2. Logs in exactly like you do (the router's own page scrambles the password).
  3. Opens "device info". That page asks the router for fresh values every few
     seconds - this program simply listens to those answers.
  4. Prints a live line per reading and saves everything to a CSV file.
  5. Every 5 seconds it also checks that the INTERNET works (not just the signal),
     and records every outage in outages.csv - proof for Rain support.

Run:   python router_monitor.py
Stop:  Ctrl + C
"""

import argparse
import csv
import getpass
import json
import os
import re
import socket
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

DEFAULT_URL = "https://192.168.0.1"
DEVICE_INFO_ROUTE = "/#/advancedSet/eqMsg"
CSV_FIELDS = [
    "time", "network", "band", "pci", "tower_id", "cell_id", "tac",
    "sinr_db", "ssb_sinr_db", "rsrp_dbm", "ssb_rsrp_dbm", "rsrq_db", "rssi_dbm",
    "cqi", "rank", "dl_modulation", "ul_modulation", "tx_power_dbm", "timing_advance",
    "neighbours", "internet_ok", "latency_ms",
]
OUTAGE_FIELDS = ["start", "end", "duration_s", "sinr_db_at_start", "rsrp_dbm_at_start", "tower_id", "pci", "router_status"]
# Big, always-on internet services, reached by IP address (so a DNS problem can't fool the test)
NET_TARGETS = [("1.1.1.1", 443), ("8.8.8.8", 443), ("9.9.9.9", 443)]
if os.environ.get("RM_NET_TARGETS"):    # for testing only: "host:port,host:port"
    NET_TARGETS = [(h, int(p)) for h, p in (t.rsplit(":", 1) for t in os.environ["RM_NET_TARGETS"].split(","))]
NET_EVERY_S = float(os.environ.get("RM_NET_EVERY", 5))
SLOW_MS = 300

# Make Windows terminals show colours and the ° symbol properly
if os.name == "nt":
    os.system("")
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

GREEN, YELLOW, RED, DIM, BOLD, RESET = "\033[92m", "\033[93m", "\033[91m", "\033[2m", "\033[1m", "\033[0m"


# ---------- helpers ----------
def num(value):
    """'16 dB' -> 16.0, '-80 dBm' -> -80.0, '--' -> None"""
    if value is None:
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", str(value))
    return float(m.group()) if m else None


def result_payload(body):
    """Router replies look like {"jsonrpc":"2.0","result":[0,{...}]} - return the {...} part."""
    if isinstance(body, dict) and isinstance(body.get("result"), list) and len(body["result"]) > 1:
        return body["result"][1]
    return None


def sinr_colour(v):
    if v is None:
        return DIM
    return GREEN if v >= 10 else YELLOW if v >= 3 else RED


def sinr_word(v):
    if v is None:
        return "?"
    return "excellent" if v >= 20 else "good" if v >= 10 else "fair" if v >= 3 else "poor"


# ---------- parsing the two router answers ----------
def parse_device_info(body):
    d = result_payload(body)
    if not d:
        return None
    nr, lte = d.get("NR") or {}, d.get("LTE") or {}
    tech = d.get("PS_eAct") or ""
    src = nr if tech == "NR" or num(nr.get("sinr")) is not None else lte
    pcc = src.get("pcc") or {}
    band = d.get("combo_band") or ""
    carrier = pcc.get(band) or (next(iter(pcc.values())) if isinstance(pcc, dict) and pcc else {})
    return {
        "network": tech,
        "band": band,
        "pci": carrier.get("pci"),
        "tower_id": d.get("gNodeBID"),
        "cell_id": d.get("cell_id"),
        "sinr_db": num(src.get("sinr")),
        "ssb_sinr_db": num(src.get("SSB_SINR")),
        "rsrp_dbm": num(src.get("rsrp")),
        "ssb_rsrp_dbm": num(src.get("SSB_RSRP")),
        "rsrq_db": num(src.get("rsrq")),
        "rssi_dbm": num(src.get("rssi")),
        "cqi": src.get("cqi"),
        "rank": carrier.get("rank"),
        "dl_modulation": carrier.get("dl_modulation"),
        "ul_modulation": carrier.get("ul_modulation"),
        "tx_power_dbm": num(carrier.get("tx_pwr")),
    }


def parse_cells(body):
    """The 'cell' answer is a list of replies; one of them has 'serving' + 'neighbour'."""
    replies = body if isinstance(body, list) else [body]
    for r in replies:
        p = result_payload(r)
        if p and ("serving" in p or "neighbour" in p):
            serving = (p.get("serving") or [{}])[0]
            neighbours = [
                {"pci": n.get("pci"), "sinr": num(n.get("ss_sinr")), "rsrp": num(n.get("ss_rsrp"))}
                for n in p.get("neighbour") or []
            ]
            neighbours.sort(key=lambda n: (n["sinr"] is None, -(n["sinr"] or 0)))
            return {
                "tac": serving.get("lac"),
                "timing_advance": serving.get("ta") or None,
                "serving_pci": serving.get("pci"),
                "neighbours": neighbours,
            }
    return None



# ---------- internet checker ----------
def fmt_duration(sec):
    sec = int(round(sec))
    return f"{sec // 60}m {sec % 60:02d}s" if sec >= 60 else f"{sec}s"


class InternetChecker(threading.Thread):
    """Every few seconds, try to reach big internet services. Two failures in a row = outage."""

    def __init__(self, state, outage_writer, outage_file):
        super().__init__(daemon=True)
        self.state, self.writer, self.file = state, outage_writer, outage_file
        self.ok, self.latency_ms = None, None
        self.fails_in_row = 0
        self.down_since = None
        self.down_snapshot = {}
        self.checks = self.failed = self.slow = 0
        self.latencies = []
        self.outages = []          # (start, end, seconds, sinr)
        self.stop_flag = threading.Event()

    @staticmethod
    def probe():
        best = None
        for host, port in NET_TARGETS:
            t0 = time.perf_counter()
            try:
                with socket.create_connection((host, port), timeout=2):
                    ms = (time.perf_counter() - t0) * 1000
                    best = ms if best is None else min(best, ms)
                    if ms < 150:
                        break            # fast answer - no need to try the others
            except OSError:
                continue
        return best

    def run(self):
        while not self.stop_flag.is_set():
            ms = self.probe()
            now = time.time()
            self.checks += 1
            if ms is None:
                self.failed += 1
                self.fails_in_row += 1
                self.ok, self.latency_ms = False, None
                if self.fails_in_row == 2 and self.down_since is None:
                    self.down_since = now - NET_EVERY_S
                    last = self.state.get("last_reading") or {}
                    self.down_snapshot = last
                    sinr = last.get("sinr_db")
                    print(f"{RED}{BOLD}{datetime.now():%H:%M:%S}  INTERNET DOWN{RESET}{RED}  "
                          f"(signal at that moment: SINR {sinr if sinr is not None else '--'} dB, "
                          f"router: {self.state.get('router_status', '?')}){RESET}")
            else:
                self.ok, self.latency_ms = True, round(ms)
                self.latencies.append(ms)
                if ms > SLOW_MS:
                    self.slow += 1
                self.fails_in_row = 0
                if self.down_since is not None:
                    self.end_outage(now)
            self.stop_flag.wait(NET_EVERY_S)

    def end_outage(self, now):
        secs = now - self.down_since
        snap = self.down_snapshot
        print(f"{GREEN}{BOLD}{datetime.now():%H:%M:%S}  INTERNET BACK{RESET}{GREEN} after {fmt_duration(secs)}{RESET}")
        self.outages.append((self.down_since, now, secs, snap.get("sinr_db")))
        self.writer.writerow({
            "start": datetime.fromtimestamp(self.down_since).isoformat(timespec="seconds"),
            "end": datetime.fromtimestamp(now).isoformat(timespec="seconds"),
            "duration_s": round(secs),
            "sinr_db_at_start": snap.get("sinr_db"),
            "rsrp_dbm_at_start": snap.get("rsrp_dbm"),
            "tower_id": snap.get("tower_id"),
            "pci": snap.get("pci"),
            "router_status": self.state.get("router_status_at_down", ""),
        })
        self.file.flush()
        self.down_since = None

    def stop(self):
        self.stop_flag.set()
        if self.down_since is not None:      # still down when stopped - record it
            self.end_outage(time.time())

    def tag(self):
        if self.ok is None:
            return f"{DIM}net …{RESET}"
        if not self.ok:
            return f"{RED}{BOLD}NET DOWN{RESET}"
        colour = YELLOW if self.latency_ms > SLOW_MS else DIM
        return f"{colour}net {self.latency_ms} ms{RESET}"


# ---------- output ----------
def print_reading(r, cells, towers_seen, net_tag=""):
    t = datetime.now().strftime("%H:%M:%S")
    s = r["sinr_db"]
    line = (
        f"{DIM}{t}{RESET}  {sinr_colour(s)}{BOLD}SINR {s if s is not None else '--':>5} dB{RESET} "
        f"{sinr_colour(s)}({sinr_word(s)}){RESET}  "
        f"RSRP {r['rsrp_dbm'] if r['rsrp_dbm'] is not None else '--':>5} dBm  "
        f"{r['network']} {r['band']}  PCI {r['pci'] or '--':>4}  tower {r['tower_id'] or '--'}  "
        f"rank {r['rank'] or '-'}  {r['dl_modulation'] or ''}  {net_tag}"
    )
    tower = r["tower_id"]
    if tower and towers_seen and tower != towers_seen[-1]:
        line += f"  {YELLOW}{BOLD}<< SWITCHED TOWER (was {towers_seen[-1]}){RESET}"
    print(line)
    if cells and cells["neighbours"]:
        others = "  ".join(
            f"{n['pci']}:{n['sinr'] if n['sinr'] is not None else '--'}dB" for n in cells["neighbours"][:5]
        )
        print(f"{DIM}          also heard (PCI:SINR)  {others}{RESET}")


def print_summary(rows, net=None):
    vals = [r["sinr_db"] for r in rows if r["sinr_db"] is not None]
    if net and net.checks:
        up = 100 * (net.checks - net.failed) / net.checks
        print(f"\n{BOLD}Internet{RESET} - {net.checks} checks, working {up:.1f}% of the time")
        if net.latencies:
            avg = sum(net.latencies) / len(net.latencies)
            print(f"  response time  average {avg:.0f} ms, slow (>{SLOW_MS} ms) {net.slow} times")
        if net.outages:
            total = sum(o[2] for o in net.outages)
            longest = max(o[2] for o in net.outages)
            good = [o for o in net.outages if o[3] is not None and o[3] >= 10]
            print(f"  {RED}{len(net.outages)} outage(s){RESET}, {fmt_duration(total)} down in total, longest {fmt_duration(longest)}")
            for start, end, secs, sinr in net.outages[-10:]:
                print(f"    {datetime.fromtimestamp(start):%d %b %H:%M:%S} -> {datetime.fromtimestamp(end):%H:%M:%S}"
                      f"  ({fmt_duration(secs)}, SINR {sinr if sinr is not None else '--'} dB)")
            if good:
                print(f"  {YELLOW}{len(good)} of these happened with GOOD signal (SINR 10+ dB) - that points to a problem")
                print(f"  on Rain's network, not your router's position. Send outages.csv to Rain support.{RESET}")
        else:
            print(f"  {GREEN}no outages{RESET}")
    if not vals:
        print("\nNo signal readings recorded.")
        return
    towers = {}
    for r in rows:
        towers.setdefault(r["tower_id"] or "?", []).append(r["sinr_db"])
    print(f"\n{BOLD}Summary{RESET} - {len(vals)} readings")
    print(f"  SINR  min {min(vals):.0f} dB   average {sum(vals)/len(vals):.1f} dB   max {max(vals):.0f} dB")
    for tower, v in towers.items():
        v = [x for x in v if x is not None]
        if v:
            print(f"  tower {tower}: {len(v)} readings, average SINR {sum(v)/len(v):.1f} dB")


# ---------- browser automation ----------
def real_box(page, kind):
    """The router page has hidden decoy boxes first; the real ones carry the el-input__inner style."""
    styled = page.locator(f"input.el-input__inner[type={kind}]")
    if styled.count():
        return styled.last if kind == "password" else styled.first
    return page.locator(f"input[type={kind}]:visible").last


def login(page, base_url, username, password, navigate=True):
    """Returns 'ok', 'already' or an error message."""
    if navigate and "#/login" not in page.url:
        page.goto(base_url + "/", wait_until="domcontentloaded")
    try:
        page.locator("input[type=password]").first.wait_for(state="attached", timeout=10000)
    except PWTimeout:
        return "already"  # no password box -> still logged in
    page.wait_for_timeout(800)
    if "#/login" not in page.url and not page.locator("input.el-input__inner[type=password]").count():
        return "already"
    pw_box = real_box(page, "password")
    user_box = real_box(page, "text")
    if user_box.count() and not user_box.input_value():
        user_box.fill(username)
    pw_box.click()
    pw_box.fill(password)
    # Try several ways to submit, stopping as soon as the router receives a login request
    attempts = [
        ("login button", lambda: page.get_by_role("button", name=re.compile(r"log ?in|sign ?in", re.I)).first.click(timeout=3000)),
        ("login text", lambda: page.get_by_text(re.compile(r"^\s*(log ?in|sign ?in|login)\s*$", re.I)).locator("visible=true").first.click(timeout=3000)),
        ("submit input", lambda: page.locator("input[type=submit]:visible, input[type=button]:visible").first.click(timeout=3000)),
        ("any button", lambda: page.locator("button:visible").last.click(timeout=3000)),
        ("Enter key", lambda: pw_box.press("Enter")),
    ]
    reply = None
    for name, action in attempts:
        try:
            with page.expect_response(lambda r: "action_login" in r.url, timeout=6000) as info:
                action()
            try:
                reply = info.value.json()
            except Exception:
                reply = {}
            break
        except Exception:
            continue
    if reply is None:
        save_login_debug(page)
        return "couldn't find how to submit the login form (details saved - see above)"
    page.wait_for_timeout(2500)
    if isinstance(reply, dict) and reply.get("code") not in (0, "0", None):
        return f"router refused the password (failed attempts: {reply.get('failcnt', '?')})"
    return "ok"


def save_login_debug(page):
    """Save a picture and a description of the login page, so the form can be understood."""
    shot, info = Path("login_debug.png").resolve(), Path("login_debug.txt").resolve()
    try:
        page.screenshot(path=str(shot), full_page=True)
    except Exception:
        pass
    try:
        desc = page.evaluate("""() => {
          const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const out = [];
          document.querySelectorAll('input, button, a, [role=button], [onclick], .btn, [class*=login], [class*=Login]').forEach(e => {
            if (!vis(e)) return;
            out.push([e.tagName.toLowerCase(), 'type=' + (e.type || ''), 'id=' + (e.id || ''),
                      'class=' + (typeof e.className === 'string' ? e.className : ''),
                      'placeholder=' + (e.placeholder || ''), 'text=' + (e.tagName === 'INPUT' ? (['button', 'submit'].includes(e.type) ? e.value : '') : (e.innerText || '')).trim().slice(0, 40)].join('  '));
          });
          const NL = String.fromCharCode(10);
          return location.href + NL + out.join(NL);
        }""")
        # never write the typed password into the file
        info.write_text(desc, encoding="utf-8")
    except Exception as e:
        info.write_text(f"could not describe page: {e}", encoding="utf-8")
    print(f"{YELLOW}  Saved {shot.name} and {info.name} in this folder - send both to Claude.{RESET}")


def click_text(page, pattern, timeout=4000):
    """Click the first visible element whose text matches pattern. Returns True if clicked."""
    loc = page.get_by_text(re.compile(pattern, re.I)).locator("visible=true").first
    try:
        loc.wait_for(state="visible", timeout=timeout)
        loc.click()
        page.wait_for_timeout(1200)
        return True
    except Exception:
        return False


def open_device_info(page, base_url, state, wait_s=10):
    """Open the device info page and wait until signal data arrives. Returns True on success."""
    def wait_for_data():
        start = time.time()
        while time.time() - start < wait_s:
            page.wait_for_timeout(500)
            if state["last_info"] >= start:
                return True
        return False

    def go_inside_page():
        # Change only the part after '#', exactly like the page's own menu does - no reload
        page.evaluate("route => { location.hash = route }", DEVICE_INFO_ROUTE.split("#", 1)[1])

    # Attempt 1: switch to the device info screen inside the page
    go_inside_page()
    if wait_for_data():
        return True
    # If the router sent us back to its login screen, log in right there (it then returns to device info)
    if "#/login" in page.url:
        print(f"{DIM}  the router asked to log in again ...{RESET}")
        if login(page, base_url, state["user"], state["password"], navigate=False) in ("ok", "already"):
            go_inside_page()
            if wait_for_data():
                return True
    # Attempt 2: click through the menu like a person: advanced -> system -> device info
    print(f"{DIM}  trying the menu: advanced > system > device info ...{RESET}")
    click_text(page, r"^\s*advanced\s*$")
    click_text(page, r"^\s*system\s*$", timeout=2500)
    click_text(page, r"^\s*device info\s*$")
    return wait_for_data()


def save_debug(page, state):
    shot = Path("router_debug.png").resolve()
    try:
        page.screenshot(path=str(shot), full_page=True)
    except Exception:
        shot = None
    print(f"{YELLOW}No signal data yet.{RESET}")
    print(f"  page address now: {page.url}")
    flags = sorted(set(state["flags"]))
    print(f"  requests seen   : {', '.join(flags) if flags else 'none'}")
    if shot:
        print(f"  screenshot saved: {shot}")


def main():
    ap = argparse.ArgumentParser(description="Live signal monitor for the Rain 'the101' router")
    ap.add_argument("--url", default=DEFAULT_URL, help="router address (default https://192.168.0.1)")
    ap.add_argument("--user", default="admin", help="router username (default admin)")
    ap.add_argument("--csv", default="signal_log.csv", help="file to save readings to")
    ap.add_argument("--show", action="store_true", help="show the browser window (for troubleshooting)")
    ap.add_argument("--debug", action="store_true", help="print every request the router page makes")
    args = ap.parse_args()

    password = os.environ.get("ROUTER_PASSWORD") or getpass.getpass("Router password (hidden as you type): ")

    csv_path = Path(args.csv)
    if csv_path.exists():
        # An older version wrote different columns - keep that file and start a fresh one
        with open(csv_path, encoding="utf-8") as f:
            header = f.readline().strip().split(",")
        if header != CSV_FIELDS:
            old = csv_path.with_name(f"{csv_path.stem}_before_{datetime.now():%Y%m%d_%H%M}.csv")
            csv_path.rename(old)
            print(f"{DIM}Older log kept as {old.name}{RESET}")
    new_file = not csv_path.exists()
    csv_file = open(csv_path, "a", newline="", encoding="utf-8")
    writer = csv.DictWriter(csv_file, fieldnames=CSV_FIELDS)
    if new_file:
        writer.writeheader()

    outage_path = csv_path.with_name("outages.csv")
    new_outage = not outage_path.exists()
    outage_file = open(outage_path, "a", newline="", encoding="utf-8")
    outage_writer = csv.DictWriter(outage_file, fieldnames=OUTAGE_FIELDS)
    if new_outage:
        outage_writer.writeheader()

    state = {"cells": None, "rows": [], "towers": [], "last": time.time(), "last_info": 0, "flags": [],
             "user": args.user, "password": password, "last_reading": None, "router_status": "?"}
    net = InternetChecker(state, outage_writer, outage_file)

    def on_response(resp):
        url = resp.url
        m = re.search(r"[?&]flag=([^&]+)", url)
        if m:
            state["flags"] = (state["flags"] + [m.group(1)])[-60:]
            if args.debug:
                print(f"{DIM}  [{resp.status}] {m.group(1)}{RESET}")
        if "flag=get_device_info" not in url and "flag=cell" not in url:
            return
        try:
            body = resp.json()
        except Exception:
            return
        if "flag=cell" in url:
            state["cells"] = parse_cells(body) or state["cells"]
            return
        r = parse_device_info(body)
        if r is None:
            return
        state["last"] = time.time()          # the router page is still answering
        if r["sinr_db"] is None and r["rsrp_dbm"] is None:
            # The router answered, but has no 5G/4G connection right now
            if state["router_status"] != "NO NETWORK":
                print(f"{RED}{BOLD}{datetime.now():%H:%M:%S}  ROUTER: NO NETWORK{RESET}{RED} (not connected to any tower){RESET}")
            state["router_status"] = "NO NETWORK"
            if net.down_since is not None:
                state["router_status_at_down"] = "NO NETWORK"
            if args.debug:
                print(f"{DIM}  device info without signal values: {str(body)[:200]}{RESET}")
            return
        if state["router_status"] == "NO NETWORK":
            print(f"{GREEN}{datetime.now():%H:%M:%S}  ROUTER: connected again{RESET}")
        state["router_status"] = "connected"
        if net.down_since is None:
            state["router_status_at_down"] = "connected"
        state["last_info"] = time.time()
        cells = state["cells"]
        r["tac"] = cells["tac"] if cells else None
        r["timing_advance"] = cells["timing_advance"] if cells else None
        r["neighbours"] = json.dumps(cells["neighbours"]) if cells else ""
        r["internet_ok"] = net.ok
        r["latency_ms"] = net.latency_ms
        state["last_reading"] = r
        print_reading(r, cells, state["towers"], net.tag())
        if r["tower_id"] and (not state["towers"] or state["towers"][-1] != r["tower_id"]):
            state["towers"].append(r["tower_id"])
        writer.writerow({"time": datetime.now().isoformat(timespec="seconds"), **{k: r.get(k) for k in CSV_FIELDS if k != "time"}})
        csv_file.flush()
        state["rows"].append(r)
        state["last"] = time.time()

    print(f"Connecting to {args.url} ...")
    net.start()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.show)
        context = browser.new_context(ignore_https_errors=True)  # the router uses a self-signed certificate
        page = context.new_page()
        page.on("response", on_response)

        result = login(page, args.url, args.user, password)
        if result not in ("ok", "already"):
            print(f"{RED}Login failed - {result}.{RESET}")
            browser.close()
            net.stop()
            return 1
        print(f"{GREEN}Logged in.{RESET} Opening device info ...")
        if not open_device_info(page, args.url, state):
            save_debug(page, state)
            print("  Send the screenshot and these lines to Claude. Still listening - press Ctrl + C to stop.")
        else:
            print(f"Reading signal every few seconds - press Ctrl + C to stop.")
        print(f"Saving to {csv_path.resolve()}")
        print(f"Outages go to {outage_path.resolve()}\n")
        state["last"] = time.time()

        try:
            while True:
                page.wait_for_timeout(1000)
                if time.time() - state["last"] > 60:
                    # No data for a while: the router probably logged us out - log in again
                    print(f"{YELLOW}No data for 60 s - logging in again...{RESET}")
                    result = login(page, args.url, args.user, password)
                    if result not in ("ok", "already"):
                        print(f"{RED}Login failed - {result}.{RESET}")
                    elif not open_device_info(page, args.url, state):
                        save_debug(page, state)
                    state["last"] = time.time()
        except KeyboardInterrupt:
            pass
        finally:
            net.stop()
            print_summary(state["rows"], net)
            csv_file.close()
            outage_file.close()
            try:
                browser.close()
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nStopped.")
