"""
Rain router signal monitor (router model: "the101").

How it works, in plain English:
  1. Opens the router's web page in a hidden Chrome window.
  2. Logs in exactly like you do (the router's own page scrambles the password).
  3. Opens "device info". That page asks the router for fresh values every few
     seconds - this program simply listens to those answers.
  4. Prints a live line per reading and saves everything to a CSV file.

Run:   python router_monitor.py
Stop:  Ctrl + C
"""

import argparse
import csv
import getpass
import json
import os
import re
import sys
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
    "neighbours",
]

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


# ---------- output ----------
def print_reading(r, cells, towers_seen):
    t = datetime.now().strftime("%H:%M:%S")
    s = r["sinr_db"]
    line = (
        f"{DIM}{t}{RESET}  {sinr_colour(s)}{BOLD}SINR {s if s is not None else '--':>5} dB{RESET} "
        f"{sinr_colour(s)}({sinr_word(s)}){RESET}  "
        f"RSRP {r['rsrp_dbm'] if r['rsrp_dbm'] is not None else '--':>5} dBm  "
        f"{r['network']} {r['band']}  PCI {r['pci'] or '--':>4}  tower {r['tower_id'] or '--'}  "
        f"rank {r['rank'] or '-'}  {r['dl_modulation'] or ''}"
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


def print_summary(rows):
    vals = [r["sinr_db"] for r in rows if r["sinr_db"] is not None]
    if not vals:
        print("\nNo readings recorded.")
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
    new_file = not csv_path.exists()
    csv_file = open(csv_path, "a", newline="", encoding="utf-8")
    writer = csv.DictWriter(csv_file, fieldnames=CSV_FIELDS)
    if new_file:
        writer.writeheader()

    state = {"cells": None, "rows": [], "towers": [], "last": time.time(), "last_info": 0, "flags": [],
             "user": args.user, "password": password}

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
        if not r or r["sinr_db"] is None and r["rsrp_dbm"] is None:
            if args.debug:
                print(f"{DIM}  device info without signal values: {str(body)[:200]}{RESET}")
            return
        state["last_info"] = time.time()
        cells = state["cells"]
        r["tac"] = cells["tac"] if cells else None
        r["timing_advance"] = cells["timing_advance"] if cells else None
        r["neighbours"] = json.dumps(cells["neighbours"]) if cells else ""
        print_reading(r, cells, state["towers"])
        if r["tower_id"] and (not state["towers"] or state["towers"][-1] != r["tower_id"]):
            state["towers"].append(r["tower_id"])
        writer.writerow({"time": datetime.now().isoformat(timespec="seconds"), **{k: r.get(k) for k in CSV_FIELDS if k != "time"}})
        csv_file.flush()
        state["rows"].append(r)
        state["last"] = time.time()

    print(f"Connecting to {args.url} ...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.show)
        context = browser.new_context(ignore_https_errors=True)  # the router uses a self-signed certificate
        page = context.new_page()
        page.on("response", on_response)

        result = login(page, args.url, args.user, password)
        if result not in ("ok", "already"):
            print(f"{RED}Login failed - {result}.{RESET}")
            browser.close()
            return 1
        print(f"{GREEN}Logged in.{RESET} Opening device info ...")
        if not open_device_info(page, args.url, state):
            save_debug(page, state)
            print("  Send the screenshot and these lines to Claude. Still listening - press Ctrl + C to stop.")
        else:
            print(f"Reading signal every few seconds - press Ctrl + C to stop.")
        print(f"Saving to {csv_path.resolve()}\n")
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
            print_summary(state["rows"])
            csv_file.close()
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
