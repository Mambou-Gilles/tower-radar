// ===== Tower Radar — Phase 1: static radar with mock towers =====

// --- Network colours (MCC 655) ---
const NETWORKS = {
  rain:    { name: "Rain",    color: "#ff3cf0" },
  vodacom: { name: "Vodacom", color: "#ff3b3b" },
  mtn:     { name: "MTN",     color: "#ffd400" },
  telkom:  { name: "Telkom",  color: "#3ba0ff" },
  cellc:   { name: "Cell C",  color: "#ffffff" },
};

// --- Fake user location (central Johannesburg) until GPS is added in Phase 3 ---
const user = { lat: -26.2041, lon: 28.0473 };

// --- Mock towers placed around the user ---
const towers = [
  { network: "rain",    lat: -26.1985, lon: 28.0521 },
  { network: "rain",    lat: -26.2132, lon: 28.0398 },
  { network: "vodacom", lat: -26.2060, lon: 28.0610 },
  { network: "mtn",     lat: -26.1950, lon: 28.0420 },
  { network: "telkom",  lat: -26.2180, lon: 28.0560 },
  { network: "cellc",   lat: -26.2005, lon: 28.0330 },
];

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

function draw() {
  const W = canvas.width;
  const c = W / 2;
  const R = c * 0.95;
  const range = RANGES[rangeIndex];

  // Background
  ctx.fillStyle = "#031a08";
  ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.fill();

  // Grid rings + cross
  ctx.strokeStyle = "rgba(57,255,106,0.35)";
  ctx.lineWidth = W / 400;
  for (let i = 1; i <= 4; i++) {
    ctx.beginPath(); ctx.arc(c, c, (R * i) / 4, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(c - R, c); ctx.lineTo(c + R, c);
  ctx.moveTo(c, c - R); ctx.lineTo(c, c + R);
  ctx.stroke();

  // North marker (fixed for now; rotates with compass in Phase 4)
  ctx.fillStyle = "#39ff6a";
  ctx.font = `${W / 25}px Courier New`;
  ctx.textAlign = "center";
  ctx.fillText("N", c, c - R + W / 20);

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

    const r = (t.dist / range) * R;
    const a = toRad(t.bearing);
    const x = c + r * Math.sin(a);
    const y = c - r * Math.cos(a);

    ctx.fillStyle = NETWORKS[t.network].color;
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = W / 40;
    ctx.beginPath(); ctx.arc(x, y, W / 60, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Arrow to nearest tower
  if (nearest) {
    const a = toRad(nearest.bearing);
    const len = Math.min((nearest.dist / range) * R, R);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = W / 150;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + len * Math.sin(a), c - len * Math.cos(a));
    ctx.stroke();

    document.getElementById("targetName").textContent = NETWORKS[nearest.network].name;
    document.getElementById("targetDist").textContent = formatDist(nearest.dist);
    document.getElementById("targetBearing").textContent =
      `${Math.round(nearest.bearing)}° ${compassPoint(nearest.bearing)}`;
  }

  // User dot
  ctx.fillStyle = "#39ff6a";
  ctx.beginPath(); ctx.arc(c, c, W / 50, 0, Math.PI * 2); ctx.fill();

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
draw();
