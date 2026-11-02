// ===== Tower Radar — Phase 4: GPS + compass + mock towers =====

// --- Network colours (MCC 655) ---
const NETWORKS = {
  rain:    { name: "Rain",    color: "#ff3cf0" },
  vodacom: { name: "Vodacom", color: "#ff3b3b" },
  mtn:     { name: "MTN",     color: "#ffd400" },
  telkom:  { name: "Telkom",  color: "#3ba0ff" },
  cellc:   { name: "Cell C",  color: "#ffffff" },
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

// ===== GPS =====
const statusEl = document.getElementById("status");
let hasFix = false;
let gpsStatus = "FINDING GPS…";
let compassStatus = "";

function renderStatus() {
  statusEl.textContent = [gpsStatus, compassStatus, "MOCK"].filter(Boolean).join(" · ");
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
        buildMockTowers();
      }
      gpsStatus = `GPS ±${Math.round(user.accuracy)} m`;
      renderStatus();
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

  // Towers
  let nearest = null;
  for (const t of towers) {
    t.dist = distance(user.lat, user.lon, t.lat, t.lon);
    t.bearing = bearing(user.lat, user.lon, t.lat, t.lon);
    if (!nearest || t.dist < nearest.dist) nearest = t;
    if (t.dist > range) continue;

    const [x, y] = polar(c, (t.dist / range) * plotR, t.bearing);
    ctx.fillStyle = NETWORKS[t.network].color;
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = W / 40;
    ctx.beginPath(); ctx.arc(x, y, W / 60, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Line to nearest tower
  if (nearest) {
    const len = Math.min((nearest.dist / range) * plotR, plotR);
    const [x, y] = polar(c, len, nearest.bearing);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = W / 150;
    ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(x, y); ctx.stroke();

    document.getElementById("targetName").textContent = NETWORKS[nearest.network].name;
    document.getElementById("targetDist").textContent = formatDist(nearest.dist);
    document.getElementById("targetBearing").textContent =
      `${Math.round(nearest.bearing)}° ${compassPoint(nearest.bearing)}`;

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
startGPS();
draw();
