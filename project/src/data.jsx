// Live data shim — populates window.APEX from the backend.
// Synchronous bootstrap ensures CIRCUIT/TEAMS/DRIVERS are available
// before IsoTrack / Leaderboard / etc. evaluate their top-level consts.

const BASE = `${location.protocol}//${location.host}`;

function syncGet(path) {
  try {
    const req = new XMLHttpRequest();
    req.open("GET", BASE + path, false);
    req.send();
    if (req.status === 200) return JSON.parse(req.responseText);
  } catch {}
  return null;
}

const _summary  = syncGet("/api/session/summary");
const _geometry = syncGet("/api/session/geometry");

// --- Compound int → APEX key mapping ---
const COMPOUND_MAP = { 0: "H", 1: "M", 2: "S", 3: "I", 4: "W", 5: "W", 6: "I", 7: "H" };

// --- TEAMS (mutable — colors updated from WS snapshot) ---
const TEAMS = {};
const DRIVERS = [];

if (_summary && _summary.drivers) {
  const teamsSeen = {};
  for (const d of _summary.drivers) {
    const teamKey = d.team || "Unknown";
    if (!teamsSeen[teamKey]) {
      teamsSeen[teamKey] = true;
      TEAMS[teamKey] = { name: teamKey, color: "#FF1E00", sub: "#8A0A00" };
    }
    DRIVERS.push({
      code: d.code,
      num: d.number || 0,
      name: d.full_name || d.code,
      team: teamKey,
      country: d.country || "",
    });
  }
}

// --- CIRCUIT from geometry ---
let CIRCUIT = [];
let SECTORS = [];
let DRS_ZONES = [];

if (_geometry) {
  const cx = _geometry.centerline?.x || [];
  const cy = _geometry.centerline?.y || [];
  CIRCUIT = cx.map((x, i) => ({ x, y: cy[i] || 0 }));

  DRS_ZONES = (_geometry.drs_zones || []).map(z => ({
    start: z.start_idx,
    end: z.end_idx,
  }));

  const totalLength = _geometry.total_length_m || 1;
  const n = CIRCUIT.length;
  const boundaries = _geometry.sector_boundaries_m || [];
  const sectorColors = ["#FF1E00", "#FFD93A", "#00D9FF"];

  if (boundaries.length >= 2) {
    SECTORS = [
      { idx: 0, color: sectorColors[0], name: "S1" },
      ...boundaries.slice(0, 2).map((m, i) => ({
        idx: Math.round((m / totalLength) * (n - 1)) % n,
        color: sectorColors[i + 1] || "#FFFFFF",
        name: `S${i + 2}`,
      })),
    ];
  } else if (n > 1) {
    SECTORS = [
      { idx: 0, color: "#FF1E00", name: "S1" },
      { idx: Math.floor(n / 3), color: "#FFD93A", name: "S2" },
      { idx: Math.floor(2 * n / 3), color: "#00D9FF", name: "S3" },
    ];
  }
}

// Fallbacks
if (CIRCUIT.length === 0) CIRCUIT = [{ x: 0, y: 0 }];
if (DRIVERS.length === 0) {
  DRIVERS.push({ code: "???", num: 0, name: "Loading...", team: "Loading", country: "" });
  TEAMS["Loading"] = { name: "Loading", color: "#FF1E00", sub: "#8A0A00" };
}
if (SECTORS.length === 0) {
  SECTORS = [
    { idx: 0, color: "#FF1E00", name: "S1" },
    { idx: Math.floor(CIRCUIT.length / 3), color: "#FFD93A", name: "S2" },
    { idx: Math.floor(2 * CIRCUIT.length / 3), color: "#00D9FF", name: "S3" },
  ];
}

const COMPOUNDS = {
  S:  { label: "SOFT",   color: "#FF3A3A" },
  M:  { label: "MEDIUM", color: "#FFD93A" },
  H:  { label: "HARD",   color: "#F4F4F4" },
  I:  { label: "INTER",  color: "#3AE87A" },
  W:  { label: "WET",    color: "#3A9BFF" },
};

// --- Live frame storage (written by live_state.jsx) ---
window.__LIVE_FRAME = null;

// --- Snapshot installer (called from live_state.jsx on WS snapshot) ---
function _installSnapshot(snap) {
  if (!snap) return;
  const colors = snap.driver_colors || {};
  const meta = snap.driver_meta || {};
  for (const [code, info] of Object.entries(meta)) {
    const teamKey = info.team;
    if (TEAMS[teamKey] && colors[code]) {
      TEAMS[teamKey].color = colors[code];
    }
    if (!TEAMS[teamKey] && teamKey) {
      TEAMS[teamKey] = { name: teamKey, color: colors[code] || "#FF1E00", sub: "#8A0A00" };
    }
  }
  // Update driver details from snapshot meta
  for (const [code, info] of Object.entries(meta)) {
    const existing = DRIVERS.find(d => d.code === code);
    if (existing) {
      if (info.full_name) existing.name = info.full_name;
      if (info.country) existing.country = info.country;
    } else {
      DRIVERS.push({
        code: info.code || code,
        num: info.number || 0,
        name: info.full_name || code,
        team: info.team || "Unknown",
        country: info.country || "",
      });
    }
  }
}

// --- computeStandings: transform live frame standings to component format ---
function computeStandings(t, lap, totalLaps) {
  const f = window.__LIVE_FRAME;
  if (!f?.standings) return [];
  const n = CIRCUIT.length;
  return f.standings.map((s) => {
    const d = DRIVERS.find((x) => x.code === s.code) || { code: s.code, num: 0, name: s.code, team: "Unknown", country: "" };
    const perLap = s.fraction != null
      ? s.fraction % 1
      : (s.rel_dist != null && s.rel_dist >= 0 && s.rel_dist <= 1.01 ? s.rel_dist : 0);
    const trackIdx = Math.round(perLap * (n - 1)) % n;
    return {
      pos: s.pos,
      driver: d,
      gap: s.gap_s ?? 0,
      interval: s.interval_s ?? 0,
      trackIdx,
      compound: COMPOUND_MAP[s.compound_int] || "M",
      tyreAge: s.tyre_age_laps ?? 0,
      lastLap: s.last_lap_s ?? 0,
      bestLap: s.best_lap_s ?? 0,
      lastS1: s.last_s1_s ?? null,
      lastS2: s.last_s2_s ?? null,
      lastS3: s.last_s3_s ?? null,
      pbLap: s.personal_best_lap_s ?? null,
      pbS1: s.personal_best_s1_s ?? null,
      pbS2: s.personal_best_s2_s ?? null,
      pbS3: s.personal_best_s3_s ?? null,
      stint: s.stint ?? 1,
      status: s.status || "RUN",
      pit: s.in_pit || false,
      inDRS: s.in_drs || false,
      speedKph: s.speed_kph ?? 0,
    };
  }).sort((a, b) => a.pos - b.pos);
}

// --- telemetryFor: extract driver telemetry from live frame ---
function telemetryFor(driverCode, t) {
  const f = window.__LIVE_FRAME;
  if (!f?.standings) return { speed: 0, throttle: 0, brake: 0, gear: 1, rpm: 0, drs: false, ers: 0, fuel: 0, ers_available: false, fuel_available: false };
  const s = f.standings.find((x) => x.code === driverCode);
  if (!s) return { speed: 0, throttle: 0, brake: 0, gear: 1, rpm: 0, drs: false, ers: 0, fuel: 0, ers_available: false, fuel_available: false };
  return {
    speed: Math.round(s.speed_kph || 0),
    throttle: Math.round(s.throttle_pct || 0),
    brake: Math.round(s.brake_pct || 0),
    gear: s.gear || 1,
    rpm: Math.round(s.rpm || 0),
    drs: s.in_drs || false,
    ers: 0,
    fuel: 0,
    ers_available: false,
    fuel_available: false,
  };
}

// --- lapTrace: Phase-2 placeholder (fictional) ---
const rand = (seed) => {
  let s = seed | 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 10000) / 10000;
  };
};

function lapTrace(driverCode, lap, channel = "speed") {
  const idx = DRIVERS.findIndex((d) => d.code === driverCode);
  const r = rand(idx * 13 + lap);
  const n = 200;
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const phase = x * Math.PI * 12 + idx;
    const base =
      channel === "speed"
        ? 220 + Math.sin(phase) * 95 + Math.sin(phase * 2.3) * 40
        : channel === "throttle"
        ? (Math.sin(phase) > 0 ? 95 : 10) + Math.sin(phase * 3) * 10
        : channel === "brake"
        ? Math.max(0, -Math.sin(phase) * 80) + Math.sin(phase * 4) * 15
        : Math.min(8, Math.max(1, Math.round((220 + Math.sin(phase) * 95) / 50) + 1));
    out.push(base + (r() - 0.5) * (channel === "speed" ? 6 : 3));
  }
  return out;
}

function getSessionBest() {
  return window.__LIVE_SNAPSHOT?.session_best || {};
}
function getStints(code) {
  return window.__LIVE_SNAPSHOT?.stints?.[code] || [];
}
function getPitStops(code) {
  return window.__LIVE_SNAPSHOT?.pit_stops?.[code] || [];
}

window.APEX = {
  TEAMS, DRIVERS, COMPOUNDS, CIRCUIT, SECTORS, DRS_ZONES,
  computeStandings, telemetryFor, lapTrace,
  _installSnapshot,
  getSessionBest, getStints, getPitStops,
};
