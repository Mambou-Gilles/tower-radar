// ===== Tower Radar — Phase 6b: per-network targets, type filter, compare =====

// --- Network colours (MCC 655) ---
const NETWORKS = {
  rain:    { name: "Rain",    color: "#ff3cf0", mnc: [73, 38, 19] },   // 73 = Rain 5G (router PLMN 65573)
  vodacom: { name: "Vodacom", color: "#ff3b3b", mnc: [1] },
  mtn:     { name: "MTN",     color: "#ffd400", mnc: [10] },
  telkom:  { name: "Telkom",  color: "#3ba0ff", mnc: [2] },
  cellc:   { name: "Cell C",  color: "#ffffff", mnc: [7] },
};

// --- User location: starts at central Johannesburg, replaced by GPS once available ---
const user = { lat: -26.2041, lon: 28.0473, accuracy: null };

// --- Mock towers, defined as offsets (in degrees) from the user ---
// ~0.001° latitude ≈ 111 m
const MOCK_OFFSETS = [
  { network: "rain",    dLat:  0.0056, dLon:  0.0048 },
  { network: "rain",    dLat: -0.0091, dLon: -0.0075 },
  { network: "vodacom", dLat: -0.0019, dLon:  0.0137 },
  { network: "mtn",     dLat:  0.0091, dLon: -0.0053 },
  { network: "telkom",  dLat: -0.0139, dLon:  0.0087 },
  { network: "cellc",   dLat:  0.0036, dLon: -0.0143 },
];

let towers = [];

function buildMockTowers() {
  towers = MOCK_OFFSETS.map((o) => ({
    network: o.network,
    lat: user.lat + o.dLat,
    lon: user.lon + o.dLon,
  }));
}
buildMockTowers();

// ===== Settings (stored only in this phone's browser) =====
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k)    { try { localStorage.removeItem(k); } catch {} },
};

const settings = Object.assign(
  { apiKey: "", networks: Object.keys(NETWORKS), target: "rain", radio: "all", router: { radio: "LTE", lac: "", cellid: "" } },
  store.get("settings", {})
);

// Friendly names for radio technologies
const RADIO_LABEL = { NR: "5G", LTE: "4G", UMTS: "3G", GSM: "2G", CDMA: "CDMA", NBIOT: "NB-IoT" };
function radioLabel(r) { return RADIO_LABEL[r] ? `${RADIO_LABEL[r]} (${r})` : r || ""; }
function matchesRadio(t) { return settings.radio === "all" || t.radio === settings.radio; }

// ===== OpenCellID data layer =====
const API = "https://opencellid.org/cell";
const BOX_HALF_M = 990;                  // ±990 m → ~3.9 km² (API limit is 4 km²)
const CACHE_DAYS = 7;
const RELOAD_AFTER_M = 400;              // re-scan when you move this far from the last scan

let dataStatus = "MOCK";
let loadedAt = null;                     // {lat, lon} of the last scan
let loading = false;
let routerCell = store.get("routerCell", null);
const dataMsgEl = document.getElementById("dataMsg");

class ApiError extends Error {}

// Accept "123456", "0x1E240" or "1E240" (hex with letters)
function parseId(v) {
  v = String(v || "").trim();
  if (!v) return null;
  if (/^0x[0-9a-f]+$/i.test(v)) return parseInt(v, 16);
  if (/^[0-9]+$/.test(v)) return parseInt(v, 10);
  if (/^[0-9a-f]+$/i.test(v)) return parseInt(v, 16);
  return null;
}

function bboxAround(lat, lon) {
  const dLat = BOX_HALF_M / 111320;
  const dLon = BOX_HALF_M / (111320 * Math.cos(toRad(lat)));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((v) => v.toFixed(6));
}

async function apiGet(path, params) {
  const qs = new URLSearchParams({ key: settings.apiKey, ...params, format: "json" });
  let res;
  try {
    res = await fetch(`${API}/${path}?${qs}`);
  } catch {
    // fetch() itself failing usually means the browser blocked it (CORS) or there's no internet
    throw new ApiError("BLOCKED");
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new ApiError(`Unexpected reply (HTTP ${res.status})`); }
  if (data.error) throw new ApiError(data.error);
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`);
  return data;
}

// Group cells into estimated sites. For LTE, ECI = eNB ID × 256 + sector,
// so cells sharing an eNB ID are antennas on the same tower.
function toSites(cells, network) {
  const groups = new Map();
  for (const c of cells) {
    const siteKey = c.radio === "LTE" ? `LTE-${Math.floor(c.cellid / 256)}` : `${c.radio}-${c.cellid}`;
    const w = Math.max(1, c.samples || 1);
    const g = groups.get(siteKey) || { network, radio: c.radio, siteKey, lat: 0, lon: 0, w: 0, cells: [] };
    g.lat += c.lat * w; g.lon += c.lon * w; g.w += w;
    g.cells.push({ cellid: c.cellid, lac: c.lac ?? c.tac, mnc: c.mnc, samples: c.samples, range: c.range });
    groups.set(siteKey, g);
  }
  return [...groups.values()].map((g) => ({
    network: g.network, radio: g.radio, siteKey: g.siteKey,
    lat: g.lat / g.w, lon: g.lon / g.w, cells: g.cells,
  }));
}

function findCached(network, lat, lon, grid) {
  const list = store.get(`cells2:${network}`, []);
  const maxAge = CACHE_DAYS * 86400000;
  return list.find((e) => (e.grid || 1) === grid && Date.now() - e.time < maxAge &&
                          distance(lat, lon, e.lat, e.lon) < RELOAD_AFTER_M);
}

function saveCache(network, lat, lon, grid, sites) {
  const list = store.get(`cells2:${network}`, []).filter((e) =>
    (e.grid || 1) !== grid || distance(lat, lon, e.lat, e.lon) >= RELOAD_AFTER_M);
  list.unshift({ lat, lon, grid, time: Date.now(), sites });
  store.set(`cells2:${network}`, list.slice(0, 12));
}

// Centres of an n×n grid of 2 km boxes around (lat, lon), nearest first
// skip = size of an inner grid already scanned (and found empty), so it isn't paid for twice
function tileCentres(lat, lon, n, skip = 0) {
  const step = 2 * BOX_HALF_M, half = (n - 1) / 2, inner = (skip - 1) / 2, out = [];
  for (let i = -half; i <= half; i++) {
    for (let j = -half; j <= half; j++) {
      if (skip && Math.abs(i) <= inner && Math.abs(j) <= inner) continue;
      out.push([lat + (i * step) / 111320, lon + (j * step) / (111320 * Math.cos(toRad(lat)))]);
    }
  }
  return out.sort((a, b) => distance(lat, lon, a[0], a[1]) - distance(lat, lon, b[0], b[1]));
}

async function scanGrid(network, lat, lon, n, skip = 0) {
  const jobs = [];
  for (const [cLat, cLon] of tileCentres(lat, lon, n, skip)) {
    for (const mnc of NETWORKS[network].mnc) jobs.push({ box: bboxAround(cLat, cLon).join(","), mnc });
  }
  const total = jobs.length;
  const seen = new Map();          // de-duplicate cells that appear in two boxes
  let done = 0;
  const worker = async () => {
    while (jobs.length) {
      const j = jobs.shift();
      const data = await apiGet("getInArea", { BBOX: j.box, mcc: 655, mnc: j.mnc, limit: 50 });
      for (const c of data.cells || []) seen.set(`${c.mnc}-${c.radio}-${c.lac}-${c.cellid}`, c);
      done++;
      if (n > 1) { dataStatus = `SCANNING ${NETWORKS[network].name.toUpperCase()} ${done}/${total}`; renderStatus(); }
    }
  };
  await Promise.all([1, 2, 3, 4].map(worker));   // 4 requests at a time
  return toSites([...seen.values()], network);
}

const GRIDS = [1, 3, 5];          // 1×1 (±1 km), 3×3 (±3 km), 5×5 (±5 km)

// widen = keep searching bigger areas until something is found
async function loadNetwork(network, lat, lon, force, widen) {
  const grids = widen ? GRIDS : [1];
  let sites = [], cached = false, grid = 1, prev = 0;
  for (grid of grids) {
    const hit = !force && findCached(network, lat, lon, grid);
    if (hit) { sites = hit.sites; cached = true; }
    else { sites = await scanGrid(network, lat, lon, grid, prev); saveCache(network, lat, lon, grid, sites); }
    if (sites.some(matchesRadio)) break;
    prev = grid;
  }
  return { sites, cached, grid };
}

// The network the user is aiming for (router cell counts as Rain)
function focusNetwork() {
  if (NETWORKS[settings.target]) return settings.target;
  return settings.target === "any" ? null : "rain";   // router / signal modes are about Rain
}

function pickTarget() {
  if (settings.target === "router") return routerCell;
  let best = null;
  for (const t of towers) {
    if (settings.target !== "any" && t.network !== settings.target) continue;
    if (!matchesRadio(t)) continue;
    const d = distance(user.lat, user.lon, t.lat, t.lon);
    if (!best || d < best.d) best = { t, d };
  }
  return best && best.t;
}

// Zoom so the target fits on the radar
function autoZoom() {
  const t = pickTarget();
  if (!t) return;
  const d = distance(user.lat, user.lon, t.lat, t.lon) * 1.15;
  const i = RANGES.findIndex((r) => r >= d);
  rangeIndex = i === -1 ? RANGES.length - 1 : i;
  updateRangeLabel();
}

async function loadTowers(force = false) {
  if (!settings.apiKey) { dataStatus = "MOCK"; renderStatus(); return; }
  if (loading) return;
  loading = true;
  dataStatus = "SCANNING…"; renderStatus();
  dataMsgEl.textContent = "";

  const lat = user.lat, lon = user.lon;
  const found = [];
  let anyCached = false;
  const focus = focusNetwork();
  const notes = [];
  try {
    // Scan the focus network first so its wider search shows progress early
    const order = [...settings.networks].sort((a, b) => (b === focus) - (a === focus));
    for (const n of order) {
      const widen = n === focus;
      const { sites, cached, grid } = await loadNetwork(n, lat, lon, force, widen);
      found.push(...sites);
      anyCached = anyCached || cached;
      if (widen) {
        const name = NETWORKS[n].name;
        const kind = settings.radio === "all" ? "" : ` ${RADIO_LABEL[settings.radio]}`;
        if (!sites.some(matchesRadio)) notes.push(`No ${name}${kind} cells recorded in OpenCellID within ~5 km — it may be under-mapped here.`);
        else if (grid > 1) notes.push(`No ${name}${kind} cells within ~1 km — searched out to ~${grid} km.`);
      }
    }
    if (focus && !settings.networks.includes(focus)) notes.push(`${NETWORKS[focus].name} is unticked in ⚙ Networks.`);
    towers = found;
    loadedAt = { lat, lon };
    dataStatus = `${anyCached ? "SAVED" : "LIVE"} ${found.length}`;
    if (!found.length) notes.push("No cells recorded near you for the selected networks.");
    dataMsgEl.textContent = notes.join(" ");
    autoZoom();
  } catch (e) {
    dataStatus = "API ERROR";
    dataMsgEl.textContent = e.message === "BLOCKED"
      ? "The browser couldn't reach OpenCellID (blocked or offline). Showing fake towers."
      : `OpenCellID: ${e.message}. Showing fake towers.`;
    buildMockTowers();
  }
  loading = false;
  renderStatus();
}

async function lookupRouterCell() {
  const r = settings.router;
  const lac = parseId(r.lac), cellid = parseId(r.cellid);
  if (!settings.apiKey || lac === null || cellid === null) { routerCell = null; store.del("routerCell"); return null; }
  let lastErr;
  for (const mnc of NETWORKS.rain.mnc) {
    try {
      const c = await apiGet("get", { mcc: 655, mnc, lac, cellid, radio: r.radio });
      if (typeof c.lat === "number") {
        routerCell = { network: "rain", isRouter: true, radio: c.radio || r.radio, lat: c.lat, lon: c.lon,
                       lac, cellid, range: c.range, samples: c.samples };
        store.set("routerCell", routerCell);
        return routerCell;
      }
    } catch (e) { lastErr = e; }
  }
  routerCell = null; store.del("routerCell");
  throw lastErr || new ApiError("Cell not found");
}

// Called on every GPS update: scan again only after moving far enough
function maybeLoad() {
  if (!settings.apiKey || loading) return;
  if (!loadedAt || distance(user.lat, user.lon, loadedAt.lat, loadedAt.lon) > RELOAD_AFTER_M) loadTowers();
}

// ===== Settings panel =====
const panel = document.getElementById("settings");
const settingsMsg = document.getElementById("settingsMsg");
const targetModeEl = document.getElementById("targetMode");

document.getElementById("networkChecks").innerHTML = Object.entries(NETWORKS).map(([id, n]) =>
  `<label><input type="checkbox" value="${id}"><span class="dot" style="background:${n.color}"></span>${n.name}</label>`
).join("");

function fillSettings() {
  document.getElementById("apiKey").value = settings.apiKey;
  document.querySelectorAll("#networkChecks input").forEach((cb) => { cb.checked = settings.networks.includes(cb.value); });
  document.getElementById("routerRadio").value = settings.router.radio;
  document.getElementById("routerLac").value = settings.router.lac;
  document.getElementById("routerCell").value = settings.router.cellid;
  settingsMsg.textContent = settings.apiKey ? "" : "Paste your token to use real tower data.";
}

document.getElementById("openSettings").onclick = () => { fillSettings(); panel.hidden = false; };
document.getElementById("closeSettings").onclick = () => { panel.hidden = true; };

document.getElementById("saveSettings").onclick = async () => {
  settings.apiKey = document.getElementById("apiKey").value.trim();
  settings.networks = [...document.querySelectorAll("#networkChecks input:checked")].map((cb) => cb.value);
  settings.router = {
    radio: document.getElementById("routerRadio").value,
    lac: document.getElementById("routerLac").value.trim(),
    cellid: document.getElementById("routerCell").value.trim(),
  };
  store.set("settings", settings);

  if (!settings.apiKey) { settingsMsg.textContent = "Saved. No token, so fake towers are shown."; buildMockTowers(); dataStatus = "MOCK"; renderStatus(); return; }

  settingsMsg.textContent = "Scanning…";
  await loadTowers(true);
  if (dataStatus === "API ERROR") { settingsMsg.textContent = dataMsgEl.textContent; return; }

  let msg = `Found ${towers.length} tower site(s) within ~1 km.`;
  if (settings.router.lac || settings.router.cellid) {
    try {
      const rc = await lookupRouterCell();
      if (rc) {
        msg += ` Router cell found ${formatDist(distance(user.lat, user.lon, rc.lat, rc.lon))} away.`;
        settings.target = "router"; targetModeEl.value = "router"; store.set("settings", settings);
      } else msg += " Router cell: enter both TAC and Cell ID.";
    } catch (e) {
      msg += ` Router cell not found in OpenCellID (${e.message === "BLOCKED" ? "blocked" : e.message}).`;
    }
  } else { routerCell = null; store.del("routerCell"); }
  settingsMsg.textContent = msg;
  setTimeout(() => { panel.hidden = true; }, 1800);
};

document.getElementById("clearCache").onclick = () => {
  Object.keys(NETWORKS).forEach((n) => { store.del(`cells:${n}`); store.del(`cells2:${n}`); });
  loadedAt = null;
  settingsMsg.textContent = "Saved tower data cleared. Next scan uses fresh data.";
};

const radioModeEl = document.getElementById("radioMode");
radioModeEl.value = settings.radio;
radioModeEl.onchange = () => {
  settings.radio = radioModeEl.value;
  store.set("settings", settings);
  if (settings.apiKey) loadTowers().then(autoZoom); else autoZoom();
};

targetModeEl.value = settings.target;
targetModeEl.onchange = () => {
  settings.target = targetModeEl.value;
  if (NETWORKS[settings.target] && !settings.networks.includes(settings.target)) settings.networks.push(settings.target);
  store.set("settings", settings);
  if (settings.target === "signal") return;
  if (settings.apiKey) loadTowers().then(autoZoom); else autoZoom();
};


// ===== Signal Test: record router SINR per direction =====
let readings = store.get("signalTests", []);   // {label, sinr, rsrp, heading, lat, lon, time}
const sigPanel = document.getElementById("signalPanel");
const sigMsg = document.getElementById("sigMsg");

function sinrColor(v) { return v >= 10 ? "#39ff6a" : v >= 3 ? "#ffcc00" : "#ff4d4d"; }
function sinrWord(v)  { return v >= 20 ? "excellent" : v >= 10 ? "good" : v >= 3 ? "fair" : "poor"; }

// Direction estimate: the best reading alone until there are 3+, then a circular
// average weighted heavily toward the better readings
function signalEstimate() {
  const rs = readings.filter((r) => r.heading !== null);
  if (!rs.length) return null;
  const best = rs.reduce((a, b) => (b.sinr > a.sinr ? b : a));
  if (rs.length < 3) return { bearing: best.heading, best, count: rs.length, weighted: false };
  const min = Math.min(...rs.map((r) => r.sinr));
  let x = 0, y = 0;
  for (const r of rs) {
    const w = (r.sinr - min) ** 2 + 0.01;
    x += w * Math.cos(toRad(r.heading));
    y += w * Math.sin(toRad(r.heading));
  }
  return { bearing: (toDeg(Math.atan2(y, x)) + 360) % 360, best, count: rs.length, weighted: true };
}

function parseNum(v) {
  v = String(v || "").trim().replace(",", ".").replace(/[^\d.\-]/g, "");
  if (v === "" || v === "-" || v === ".") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function renderReadings() {
  const list = document.getElementById("sigList");
  list.innerHTML = "";
  [...readings].map((r, i) => ({ r, i })).sort((a, b) => b.r.sinr - a.r.sinr).forEach(({ r, i }) => {
    const li = document.createElement("li");
    const sinr = document.createElement("span");
    sinr.className = "sinr"; sinr.style.color = sinrColor(r.sinr); sinr.textContent = `${r.sinr} dB`;
    const meta = document.createElement("span");
    meta.className = "meta";
    const dir = r.heading === null ? "no direction" : `${Math.round(r.heading)}° ${compassPoint(r.heading)}`;
    meta.textContent = [r.label, dir, r.rsrp !== null ? `${r.rsrp} dBm` : ""].filter(Boolean).join(" · ");
    const del = document.createElement("button");
    del.textContent = "✕"; del.setAttribute("aria-label", "Delete reading");
    del.onclick = () => { readings.splice(i, 1); store.set("signalTests", readings); renderReadings(); };
    li.append(sinr, meta, del);
    list.append(li);
  });

  const sum = document.getElementById("sigSummary");
  const est = signalEstimate();
  if (!est) { sum.textContent = readings.length ? "Readings need a compass direction to point anywhere." : "No readings yet."; return; }
  const b = est.best;
  sum.innerHTML = "";
  const line1 = document.createElement("div");
  line1.innerHTML = `Best spot: <b></b>`;
  line1.querySelector("b").textContent =
    `${b.label ? b.label + " — " : ""}${b.sinr} dB (${sinrWord(b.sinr)}) facing ${Math.round(b.heading)}° ${compassPoint(b.heading)}`;
  const line2 = document.createElement("div");
  line2.textContent = est.weighted
    ? `Tower is most likely toward ${Math.round(est.bearing)}° ${compassPoint(est.bearing)} (from ${est.count} readings).`
    : `Record ${3 - est.count} more direction(s) for a tower-direction estimate.`;
  sum.append(line1, line2);
}

let facingTimer = null;
document.getElementById("openSignal").onclick = () => {
  renderReadings();
  sigMsg.textContent = heading === null ? "No compass yet — readings will be saved without a direction." : "";
  sigPanel.hidden = false;
  facingTimer = setInterval(() => {
    document.getElementById("facingNow").textContent =
      heading === null ? "—" : `${Math.round(heading)}° ${compassPoint(heading)}`;
  }, 200);
};
document.getElementById("sigClose").onclick = () => { sigPanel.hidden = true; clearInterval(facingTimer); };

document.getElementById("sigSign").onclick = () => {
  const el = document.getElementById("sigSinr");
  el.value = el.value.trim().startsWith("-") ? el.value.trim().slice(1) : "-" + el.value.trim();
};

document.getElementById("sigRecord").onclick = () => {
  const sinr = parseNum(document.getElementById("sigSinr").value);
  let rsrp = parseNum(document.getElementById("sigRsrp").value);
  if (sinr === null) { sigMsg.textContent = "Enter the SINR value from the router first."; return; }
  if (rsrp !== null && rsrp > 0) rsrp = -rsrp;          // RSRP is always negative
  readings.push({
    label: document.getElementById("sigLabel").value.trim().slice(0, 40),
    sinr, rsrp,
    heading: heading === null ? null : Math.round(heading),
    lat: user.lat, lon: user.lon, time: Date.now(),
  });
  store.set("signalTests", readings);
  document.getElementById("sigLabel").value = "";
  document.getElementById("sigSinr").value = "";
  document.getElementById("sigRsrp").value = "";
  sigMsg.textContent = `Saved: ${sinr} dB${heading === null ? " (no direction)" : ` facing ${Math.round(heading)}° ${compassPoint(heading)}`}.`;
  if (settings.target !== "signal") { settings.target = "signal"; targetModeEl.value = "signal"; store.set("settings", settings); }
  renderReadings();
};

document.getElementById("sigClear").onclick = () => {
  if (!readings.length || !confirm("Delete all signal readings?")) return;
  readings = []; store.set("signalTests", readings); renderReadings();
};


// ===== Compare networks =====
const comparePanel = document.getElementById("comparePanel");
const COMPARE_COLS = [["NR", "5G"], ["LTE", "4G"], ["UMTS", "3G"]];

function renderCompare() {
  const table = document.getElementById("compareTable");
  const rows = [];
  const bestPer = {};          // closest distance per column, to highlight
  for (const [id, n] of Object.entries(NETWORKS)) {
    // Everything known around here: current scan + any saved wider scans (deduplicated)
    const byKey = new Map();
    for (const t of towers) if (t.network === id) byKey.set(t.siteKey || `${t.lat},${t.lon}`, t);
    for (const e of store.get(`cells2:${id}`, [])) {
      if (Date.now() - e.time > CACHE_DAYS * 86400000) continue;
      if (distance(user.lat, user.lon, e.lat, e.lon) > RELOAD_AFTER_M) continue;
      for (const t of e.sites) byKey.set(t.siteKey || `${t.lat},${t.lon}`, t);
    }
    const mine = [...byKey.values()];
    const row = { id, n, scanned: settings.networks.includes(id) || mine.length > 0, cols: {}, within1: 0 };
    for (const t of mine) {
      const d = distance(user.lat, user.lon, t.lat, t.lon);
      if (d <= 1000) row.within1++;
      if (!row.cols[t.radio] || d < row.cols[t.radio]) row.cols[t.radio] = d;
    }
    for (const [r] of COMPARE_COLS) {
      if (row.cols[r] !== undefined && (bestPer[r] === undefined || row.cols[r] < bestPer[r])) bestPer[r] = row.cols[r];
    }
    rows.push(row);
  }

  table.innerHTML = "";
  const head = table.insertRow();
  ["NETWORK", ...COMPARE_COLS.map(([, l]) => l), "SITES ≤1KM"].forEach((t) => {
    const th = document.createElement("th"); th.textContent = t; head.append(th);
  });
  for (const row of rows) {
    const tr = table.insertRow();
    const name = tr.insertCell();
    const dot = document.createElement("span");
    dot.className = "dot"; dot.style.background = row.n.color;
    name.append(dot, row.n.name);
    for (const [r] of COMPARE_COLS) {
      const td = tr.insertCell();
      if (!row.scanned) { td.textContent = "not scanned"; td.className = "none"; }
      else if (row.cols[r] === undefined) { td.textContent = "—"; td.className = "none"; }
      else {
        td.textContent = formatDist(row.cols[r]);
        if (row.cols[r] === bestPer[r]) td.className = "best";
      }
    }
    const cnt = tr.insertCell();
    cnt.textContent = row.scanned ? String(row.within1) : "—";
  }

  const notes = [];
  const unscanned = rows.filter((r) => !r.scanned).map((r) => r.n.name);
  if (unscanned.length) notes.push(`Not scanned: ${unscanned.join(", ")} — tick them in ⚙ and tap RESCAN ALL.`);
  if (!settings.apiKey) notes.push("Using fake towers — add your OpenCellID token in ⚙ for real data.");
  notes.push("Each network is searched ~1 km around you; picking it as the target searches up to ~5 km.");
  notes.push("Closer and more sites usually means a stronger, steadier signal. Positions are estimates from phone reports, and home-router networks (like Rain 5G) are under-recorded.");
  document.getElementById("compareNotes").textContent = notes.join(" ");
}

document.getElementById("openCompare").onclick = () => { renderCompare(); comparePanel.hidden = false; };
document.getElementById("compareClose").onclick = () => { comparePanel.hidden = true; };
document.getElementById("compareRescan").onclick = async () => {
  settings.networks = Object.keys(NETWORKS);
  store.set("settings", settings);
  document.getElementById("compareNotes").textContent = "Scanning all networks…";
  await loadTowers();
  renderCompare();
};

// ===== GPS =====
const statusEl = document.getElementById("status");
let hasFix = false;
let gpsStatus = "FINDING GPS…";
let compassStatus = "";

function renderStatus() {
  statusEl.textContent = [gpsStatus, compassStatus, dataStatus].filter(Boolean).join(" · ");
}

function startGPS() {
  if (!("geolocation" in navigator)) {
    gpsStatus = "NO GPS";
    renderStatus();
    return;
  }
  renderStatus();

  navigator.geolocation.watchPosition(
    (pos) => {
      user.lat = pos.coords.latitude;
      user.lon = pos.coords.longitude;
      user.accuracy = pos.coords.accuracy;

      // First fix: move the mock towers around the real location
      if (!hasFix) {
        hasFix = true;
        if (!settings.apiKey) buildMockTowers();
      }
      gpsStatus = `GPS ±${Math.round(user.accuracy)} m`;
      renderStatus();
      maybeLoad();
    },
    (err) => {
      gpsStatus = err.code === err.PERMISSION_DENIED ? "GPS DENIED" : "GPS ERROR";
      renderStatus();
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

// --- Radar ranges in metres ---
const RANGES = [500, 1500, 3000, 5000];
let rangeIndex = 1;

// ===== Math =====
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

// Haversine distance in metres
function distance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dφ = toRad(lat2 - lat1);
  const dλ = toRad(lon2 - lon1);
  const a = Math.sin(dφ / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Initial bearing in degrees (0 = North, clockwise)
function bearing(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2), dλ = toRad(lon2 - lon1);
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function compassPoint(deg) {
  const pts = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return pts[Math.round(deg / 45) % 8];
}

function formatDist(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

// ===== Compass =====
// heading = direction the top of the phone points, in degrees (0 = North, clockwise)
let heading = null;         // smoothed value used for drawing
let smoothX = 0, smoothY = 0; // smoothing works on the circle, so 359° → 0° doesn't jump to 180°
const SMOOTHING = 0.15;     // 0 = frozen, 1 = no smoothing

function screenAngle() {
  return (screen.orientation && screen.orientation.angle) || window.orientation || 0;
}

function onHeading(raw) {
  raw = (raw + screenAngle() + 360) % 360;
  const x = Math.cos(toRad(raw)), y = Math.sin(toRad(raw));
  if (heading === null) { smoothX = x; smoothY = y; }
  else {
    smoothX += (x - smoothX) * SMOOTHING;
    smoothY += (y - smoothY) * SMOOTHING;
  }
  heading = (toDeg(Math.atan2(smoothY, smoothX)) + 360) % 360;
  if (compassStatus !== "COMPASS") { compassStatus = "COMPASS"; compassBtn.hidden = true; renderStatus(); }
}

function handleOrientation(e) {
  if (typeof e.webkitCompassHeading === "number") {
    onHeading(e.webkitCompassHeading);              // iPhone: already clockwise from North
  } else if (e.absolute && typeof e.alpha === "number") {
    onHeading(360 - e.alpha);                        // Android: alpha is counter-clockwise
  }
}

const compassBtn = document.getElementById("compassBtn");
let listening = false;

function listenCompass() {
  if (listening) return;
  listening = true;
  window.addEventListener("deviceorientationabsolute", handleOrientation);
  window.addEventListener("deviceorientation", handleOrientation);
}

// 1) Try straight away — works on Android without any prompt
listenCompass();

// 2) If nothing arrives within 1.5 s, the browser wants permission (iPhone) or has no compass
setTimeout(() => {
  if (heading !== null) return;
  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {
    compassBtn.hidden = false;
  } else {
    compassStatus = "NO COMPASS"; renderStatus();
  }
}, 1500);

compassBtn.onclick = async () => {
  try {
    const res = await DeviceOrientationEvent.requestPermission();
    if (res === "granted") { compassBtn.hidden = true; }
    else { compassStatus = "COMPASS DENIED"; renderStatus(); }
  } catch { compassStatus = "COMPASS ERROR"; renderStatus(); }
};

// ===== Canvas setup =====
const canvas = document.getElementById("radar");
const ctx = canvas.getContext("2d");

function resize() {
  const size = canvas.clientWidth * window.devicePixelRatio;
  canvas.width = size;
  canvas.height = size;
}
window.addEventListener("resize", resize);
resize();

let sweep = 0;
const aimEl = document.getElementById("aim");

// Screen position for a real-world bearing, after rotating by the heading
function polar(c, r, worldBearing) {
  const a = toRad(worldBearing - (heading || 0));
  return [c + r * Math.sin(a), c - r * Math.cos(a)];
}

function draw() {
  const W = canvas.width;
  const c = W / 2;
  const R = c * 0.95;
  const plotR = R - W / 30;
  const range = RANGES[rangeIndex];

  ctx.clearRect(0, 0, W, W);
  ctx.save();
  ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.clip(); // nothing spills outside

  // Background
  ctx.fillStyle = "#031a08";
  ctx.fillRect(0, 0, W, W);

  // Grid rings
  ctx.strokeStyle = "rgba(57,255,106,0.35)";
  ctx.lineWidth = W / 400;
  for (let i = 1; i <= 4; i++) {
    ctx.beginPath(); ctx.arc(c, c, (R * i) / 4, 0, Math.PI * 2); ctx.stroke();
  }

  // Cross lines along N-S and E-W (rotate with the world)
  ctx.beginPath();
  for (const b of [0, 90]) {
    const [x1, y1] = polar(c, R, b), [x2, y2] = polar(c, R, b + 180);
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
  }
  ctx.stroke();

  // N / E / S / W letters (text stays upright)
  ctx.font = `bold ${W / 25}px Courier New`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  [["N", 0], ["E", 90], ["S", 180], ["W", 270]].forEach(([label, b]) => {
    const [x, y] = polar(c, R - W / 22, b);
    ctx.fillStyle = label === "N" ? "#ff5555" : "#39ff6a";
    ctx.fillText(label, x, y);
  });

  // Sweep line with fading trail
  for (let i = 0; i < 30; i++) {
    const a = sweep - i * 0.02;
    ctx.strokeStyle = `rgba(57,255,106,${0.6 - i * 0.02})`;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + R * Math.sin(a), c - R * Math.cos(a));
    ctx.stroke();
  }
  sweep = (sweep + 0.03) % (Math.PI * 2);

  // Towers — other networks small and faded, the one you're aiming for on top
  const focus = focusNetwork();
  let nearest = null;
  for (const t of towers) {
    t.dist = distance(user.lat, user.lon, t.lat, t.lon);
    t.bearing = bearing(user.lat, user.lon, t.lat, t.lon);
    if ((settings.target === "any" || t.network === settings.target) && matchesRadio(t)) {
      if (!nearest || t.dist < nearest.dist) nearest = t;
    }
  }
  for (const pass of [false, true]) {
    for (const t of towers) {
      const isFocus = !focus || t.network === focus;
      if (isFocus !== pass || t.dist > range || !matchesRadio(t)) continue;
      const [x, y] = polar(c, (t.dist / range) * plotR, t.bearing);
      ctx.globalAlpha = isFocus ? 1 : 0.35;
      ctx.fillStyle = NETWORKS[t.network].color;
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = isFocus ? W / 40 : 0;
      ctx.beginPath(); ctx.arc(x, y, isFocus ? W / 60 : W / 110, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }

  // Router's own cell: bigger blip with a ring
  if (routerCell) {
    routerCell.dist = distance(user.lat, user.lon, routerCell.lat, routerCell.lon);
    routerCell.bearing = bearing(user.lat, user.lon, routerCell.lat, routerCell.lon);
    if (settings.target === "router") nearest = routerCell;
    if (routerCell.dist <= range) {
      const [x, y] = polar(c, (routerCell.dist / range) * plotR, routerCell.bearing);
      ctx.fillStyle = NETWORKS.rain.color;
      ctx.beginPath(); ctx.arc(x, y, W / 45, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = W / 200;
      ctx.beginPath(); ctx.arc(x, y, W / 28, 0, Math.PI * 2); ctx.stroke();
    }
  }
  // Signal test spokes: direction you faced, length = SINR
  const est = signalEstimate();
  for (const r of readings) {
    if (r.heading === null) continue;
    const frac = Math.min(1, Math.max(0.12, (r.sinr + 5) / 30));
    const [x, y] = polar(c, frac * plotR, r.heading);
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = sinrColor(r.sinr);
    ctx.lineWidth = W / 70; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(x, y); ctx.stroke();
    ctx.globalAlpha = 1; ctx.lineCap = "butt";
    if (est && r === est.best) {
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = W / 250;
      ctx.beginPath(); ctx.arc(x, y, W / 40, 0, Math.PI * 2); ctx.stroke();
    }
  }

  if (settings.target === "signal") {
    nearest = est ? { isSignal: true, dist: range, bearing: est.bearing, est } : null;
  }

  if (!nearest) {
    const isRouter = settings.target === "router";
    if (settings.target === "signal") {
      document.getElementById("targetName").textContent = "No signal readings yet";
      document.getElementById("targetDist").textContent = "—";
      document.getElementById("targetBearing").textContent = "Tap 📶 SIGNAL TEST";
      aimEl.textContent = "";
    } else {
    const kind = settings.radio === "all" ? "" : ` ${RADIO_LABEL[settings.radio]}`;
    document.getElementById("targetName").textContent = isRouter ? "No router cell set"
      : NETWORKS[settings.target] ? `No ${NETWORKS[settings.target].name}${kind} cells found` : `No${kind} towers found`;
    document.getElementById("targetDist").textContent = "—";
    document.getElementById("targetBearing").textContent = isRouter ? "Add TAC + Cell ID in ⚙" : "";
    aimEl.textContent = "";
    }
  }

  // Line to nearest tower
  if (nearest) {
    const len = Math.min((nearest.dist / range) * plotR, plotR);
    const [x, y] = polar(c, len, nearest.bearing);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = W / 150;
    ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(x, y); ctx.stroke();

    if (nearest.isSignal) {
      const b = nearest.est.best;
      document.getElementById("targetName").textContent =
        nearest.est.weighted ? "Estimated tower direction" : "Best signal so far";
      document.getElementById("targetDist").textContent = `${b.sinr} dB`;
      document.getElementById("targetBearing").textContent =
        `${Math.round(nearest.bearing)}° ${compassPoint(nearest.bearing)} · ${nearest.est.count} reading(s)`;
    } else {
      document.getElementById("targetName").textContent = nearest.isRouter
        ? `Your router's cell · ${radioLabel(nearest.radio)}`
        : `${NETWORKS[nearest.network].name}${nearest.radio ? " · " + radioLabel(nearest.radio) : ""}`;
      document.getElementById("targetDist").textContent = formatDist(nearest.dist);
      document.getElementById("targetBearing").textContent =
        `${Math.round(nearest.bearing)}° ${compassPoint(nearest.bearing)}`;
    }

    // Aiming guidance: how far to turn, from -180 (left) to +180 (right)
    if (heading !== null) {
      const turn = ((nearest.bearing - heading + 540) % 360) - 180;
      if (Math.abs(turn) <= 10) {
        aimEl.textContent = "◎ ON TARGET";
        aimEl.className = "aim on";
      } else {
        aimEl.textContent = `TURN ${turn > 0 ? "RIGHT" : "LEFT"} ${Math.round(Math.abs(turn))}°`;
        aimEl.className = "aim";
      }
    } else {
      aimEl.textContent = "";
    }
  }

  // GPS accuracy circle
  if (user.accuracy) {
    const ar = Math.min((user.accuracy / range) * R, R);
    ctx.fillStyle = "rgba(57,255,106,0.12)";
    ctx.beginPath(); ctx.arc(c, c, ar, 0, Math.PI * 2); ctx.fill();
  }

  // User dot
  ctx.fillStyle = "#39ff6a";
  ctx.beginPath(); ctx.arc(c, c, W / 50, 0, Math.PI * 2); ctx.fill();

  ctx.restore();

  // Fixed "facing" marker at the top (where the phone points)
  if (heading !== null) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(c, c - R + W / 70);
    ctx.lineTo(c - W / 45, c - R - W / 70);
    ctx.lineTo(c + W / 45, c - R - W / 70);
    ctx.closePath();
    ctx.fill();
  }

  requestAnimationFrame(draw);
}

// ===== Zoom controls =====
function updateRangeLabel() {
  document.getElementById("rangeLabel").textContent = formatDist(RANGES[rangeIndex]);
}
document.getElementById("zoomIn").onclick = () => {
  if (rangeIndex > 0) rangeIndex--;
  updateRangeLabel();
};
document.getElementById("zoomOut").onclick = () => {
  if (rangeIndex < RANGES.length - 1) rangeIndex++;
  updateRangeLabel();
};

updateRangeLabel();
renderStatus();
startGPS();
draw();
