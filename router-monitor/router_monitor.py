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
def login(page, base_url, username, password):
    page.goto(base_url + "/", wait_until="domcontentloaded")
    pw_box = page.locator("input[type=password]").first
    try:
        pw_box.wait_for(state="visible", timeout=8000)
    except PWTimeout:
        return True  # no password box -> probably still logged in
    # Fill a username box if the page has one
    user_box = page.locator("input[type=text]:visible, input:not([type]):visible").first
    if user_box.count() and not user_box.input_value():
        user_box.fill(username)
    pw_box.fill(password)
    # Click a login button if we can find one, otherwise press Enter
    button = page.get_by_role("button", name=re.compile(r"log ?in|sign ?in", re.I)).first
    try:
        with page.expect_response(lambda r: "action_login" in r.url, timeout=15000):
            if button.count():
                button.click()
            else:
                pw_box.press("Enter")
    except PWTimeout:
        pass
    page.wait_for_timeout(2500)
    return page.locator("input[type=password]:visible").count() == 0


def main():
    ap = argparse.ArgumentParser(description="Live signal monitor for the Rain 'the101' router")
    ap.add_argument("--url", default=DEFAULT_URL, help="router address (default https://192.168.0.1)")
    ap.add_argument("--user", default="admin", help="router username (default admin)")
    ap.add_argument("--csv", default="signal_log.csv", help="file to save readings to")
    ap.add_argument("--show", action="store_true", help="show the browser window (for troubleshooting)")
    args = ap.parse_args()

    password = os.environ.get("ROUTER_PASSWORD") or getpass.getpass("Router password (hidden as you type): ")

    csv_path = Path(args.csv)
    new_file = not csv_path.exists()
    csv_file = open(csv_path, "a", newline="", encoding="utf-8")
    writer = csv.DictWriter(csv_file, fieldnames=CSV_FIELDS)
    if new_file:
        writer.writeheader()

    state = {"cells": None, "rows": [], "towers": [], "last": time.time()}

    def on_response(resp):
        url = resp.url
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
            return
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

        if not login(page, args.url, args.user, password):
            print(f"{RED}Login failed - check the password (run with --show to watch what happens).{RESET}")
            browser.close()
            return 1
        print(f"{GREEN}Logged in.{RESET} Reading signal every few seconds - press Ctrl + C to stop.")
        print(f"Saving to {csv_path.resolve()}\n")
        page.goto(args.url + DEVICE_INFO_ROUTE)
        state["last"] = time.time()

        try:
            while True:
                page.wait_for_timeout(1000)
                if time.time() - state["last"] > 45:
                    # No data for a while: the router probably logged us out - log in again
                    print(f"{YELLOW}No data for 45 s - logging in again...{RESET}")
                    login(page, args.url, args.user, password)
                    page.goto(args.url + DEVICE_INFO_ROUTE)
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
