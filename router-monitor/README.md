# Router Monitor

Reads live signal data from a Rain "the101" 5G router and logs it — no more typing SINR by hand.

It opens the router's page in a hidden browser, logs in like you do, opens **device info**,
and records the values that page receives every few seconds.

```
12:07:46  SINR  16.0 dB (good)  RSRP -80.0 dBm  NR n78  PCI  574  tower 0x39699C  rank 2  64QAM
          also heard (PCI:SINR)  235:4.5dB  573:-1.5dB  187:-6.0dB
```

## One-time setup (Windows)

1. Install Python from <https://www.python.org/downloads/> — on the first installer screen tick
   **"Add python.exe to PATH"**.
2. Download `router_monitor.py` and `requirements.txt` into one folder, e.g. `Documents\router-monitor`.
3. Open **Command Prompt** in that folder and run:

   ```
   pip install -r requirements.txt
   python -m playwright install chromium
   ```

## Run

```
python router_monitor.py
```

Type the router password when asked (it is hidden and never saved). Press **Ctrl + C** to stop —
you get a summary, and every reading is in `signal_log.csv` (opens in Excel).

The laptop must be on the router's WiFi.

## Options

| Option | What it does |
|---|---|
| `--show` | Shows the browser window — use it if login fails, to watch what happens |
| `--debug` | Prints every request the router page makes (for troubleshooting) |
| `--csv myfile.csv` | Save to a different file (handy: one file per spot you test) |
| `--url https://192.168.0.1` | Router address, if yours differs |

## Reading the values

| Value | Good | Meaning |
|---|---|---|
| SINR | above 10 dB | Signal quality — the number that matters most |
| RSRP | above −90 dBm | Signal strength |
| tower | — | Tower ID (`gNodeBID`). A change means the router switched towers |
| also heard | — | Other cells the router can hear, by PCI, best first |

## Notes

- Logging in here may sign you out of the router page in your normal browser (and the other way round).
- Nothing is sent anywhere — everything stays on your laptop.
