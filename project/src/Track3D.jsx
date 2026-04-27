// WebGL / Three.js track view. Replaces IsoTrack for the "webgl" and "follow"
// modes. Everything in this file reasons in metres once `detectUnitScale`
// normalises the incoming FastF1 coordinates.
//
// Layout order along the lifecycle:
//  1. textures.js (procedural canvas textures — asphalt, kerb, concrete)
//  2. curve + ribbon helpers (centerline, track, kerbs, DRS stripes, sectors)
//  3. car marker factory (chassis + wheels + wings + halos + lights)
//  4. atmosphere (sky dome, grandstand silhouette rim, rain particles)
//  5. POV HUD (speed/gear/throttle/brake/DRS overlay for follow cam)
//  6. Track3D component (scene build on geoVersion, animation loop reads refs)
//
// React re-renders never touch the canvas: every per-frame input (standings,
// pinned driver, view mode, weather) is pushed through a ref the animation
// loop reads from.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Quality presets — control the rendering cost/quality trade-off.
// `bloomScale` downsamples the bloom pyramid render target (1.0 = full screen,
// 0.5 = quarter-area, 0.35 ≈ eighth-area). UnrealBloomPass is the single most
// expensive pass; on mid GPUs even a 0.35 scale is visually indistinguishable
// from 1.0 because bloom is heavily blurred anyway.
//
// MSAA: on a HalfFloat HDR target at DPR ≥ 1.5, samples=2 is visually
// indistinguishable from samples=4 once post-fx (bloom + vignette + ACES) has
// run — the multisample resolve cost scales linearly with samples and is the
// largest fixed-cost pass after bloom. samples=4 is left available but no
// longer the default at "high".
// `smaa` adds a post-tonemap SMAA pass (3 cheap fullscreen passes, ~0.3-1 ms
// on desktop GPUs). Catches the shader/spec-edge crawl that geometry-only
// MSAA can't see; complements rather than replaces MSAA.
const QUALITY_PRESETS = {
  low:  { dprCap: 1.0, shadowSize: 512,  msaa: 0, bloom: false, bloomScale: 0,    smaa: false },
  med:  { dprCap: 1.5, shadowSize: 1024, msaa: 2, bloom: false, bloomScale: 0,    smaa: true  },
  high: { dprCap: 2.0, shadowSize: 2048, msaa: 2, bloom: true,  bloomScale: 0.35, smaa: true  },
};

// Track dimensions (metres).
const TRACK_WIDTH = 14;
const RUNOFF_WIDTH = 32;
const KERB_WIDTH = 2.2;
const DRS_STRIPE_WIDTH = 1.8;
const Z_EXAGGERATION = 1.4;

// Car dimensions (metres). Slightly larger than real F1 (~5×2) so the body
// reads at wider zooms, but still honest enough for the chase cam.
const CAR_LENGTH = 14.4;
const CAR_WIDTH = 5.8;
const CAR_HEIGHT = 1.1;
const WHEEL_RADIUS = 0.9;
const WHEEL_WIDTH = 0.84;
const CAR_SURFACE_CLEARANCE = 0.03;
// Fixed-size ground halo so distant cars still read as markers even when the
// body shrinks below a pixel. Does not scale with the car model.
const HALO_RADIUS = 6.5;

function detectUnitScale(circuit) {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const p of circuit) {
    const x = Number(p?.x), y = Number(p?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  if (!Number.isFinite(xmin) || !Number.isFinite(ymin)) return 1;
  const diag = Math.hypot(xmax - xmin, ymax - ymin);
  if (diag > 500000) return 0.0001;
  if (diag > 2000)   return 0.1;
  return 1;
}

// FastF1 world (X east, Y north, Z up) → Three.js (Y up, -Z forward), in
// metres, with elevation baseline removed so the track sits near y=0.
function toThree(p, zBase, scale) {
  return new THREE.Vector3(
    p.x * scale,
    ((p.z || 0) * scale - zBase) * Z_EXAGGERATION,
    -p.y * scale,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Procedural textures. Cheap to generate, avoid shipping binary assets, and
// tile cleanly because we control the pixel data directly.
// ───────────────────────────────────────────────────────────────────────────

// Real asphalt reads as a uniform dark charcoal with visible aggregate (tiny
// lighter chips embedded in bitumen) and a subtly darker racing line where
// tyres have polished the seal coat. We build that in three passes:
//  (a) near-uniform dark base with a faint low-frequency luminance variation
//      so tiling doesn't broadcast a grid pattern,
//  (b) aggregate specks of varying size/brightness — most tiny, a few larger,
//      pulling the reader's eye toward "stone in tar" rather than "noise",
//  (c) a soft darker band down the centre (UV-Y), suggesting the polished
//      racing line — keeps scale cues when the camera flies low.
// Real F1 asphalt reads as near-black charcoal with visible aggregate chips.
// Tuning notes:
//  - Base `#07070b`: under ACES tonemap + bright sun + IBL, anything lighter
//    than ~#10 lifts to a medium grey that's indistinguishable from concrete.
//    The base needs to be *very* dark so the lit surface still reads as
//    asphalt rather than paving.
//  - Aggregate count kept modest (600) so individual chips read at close
//    range but don't average into a mid-tone when the mipmap collapses at
//    distance — the old tuning (1800) washed the track out to grey.
//  - Specks themselves are dim too (luminance 22–46) — real aggregate isn't
//    white rocks, it's slightly-lighter stones embedded in bitumen.
function makeAsphaltTexture() {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  // (a) Base — dark grey asphalt, kept bright enough to survive fog +
  // post-processing compression at distance.
  ctx.fillStyle = "#2a2f3a";
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  // Tiny luminance jitter so the base isn't a dead flat colour.
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    d[i]     = Math.max(0, Math.min(255, d[i]     + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  // (b) Aggregate — scattered dim chips. Mostly sub-pixel.
  for (let i = 0; i < 600; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = Math.random() < 0.9 ? (0.3 + Math.random() * 0.7) : (1.0 + Math.random() * 1.3);
    const l = 58 + Math.random() * 42;
    ctx.fillStyle = `rgba(${l},${l},${l + 2},${0.45 + Math.random() * 0.3})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // (c) Racing line wear + edge marbles.
  // Stronger center groove plus dirty off-line shoulders near UV edges.
  const rl = ctx.createLinearGradient(0, 0, size, 0);
  rl.addColorStop(0.00, "rgba(0,0,0,0.00)");
  rl.addColorStop(0.05, "rgba(0,0,0,0.17)");
  rl.addColorStop(0.12, "rgba(0,0,0,0.08)");
  rl.addColorStop(0.43, "rgba(0,0,0,0.18)");
  rl.addColorStop(0.50, "rgba(0,0,0,0.28)");
  rl.addColorStop(0.57, "rgba(0,0,0,0.18)");
  rl.addColorStop(0.88, "rgba(0,0,0,0.08)");
  rl.addColorStop(0.95, "rgba(0,0,0,0.17)");
  rl.addColorStop(1.00, "rgba(0,0,0,0.00)");
  ctx.fillStyle = rl;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeRunoffAsphaltTexture() {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#333640";
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 12;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < 420; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 0.4 + Math.random() * 1.0;
    const l = 64 + Math.random() * 34;
    ctx.fillStyle = `rgba(${l},${l},${l + 2},${0.32 + Math.random() * 0.24})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const groove = ctx.createLinearGradient(0, 0, size, 0);
  groove.addColorStop(0.00, "rgba(0,0,0,0.00)");
  groove.addColorStop(0.07, "rgba(0,0,0,0.12)");
  groove.addColorStop(0.45, "rgba(0,0,0,0.07)");
  groove.addColorStop(0.50, "rgba(0,0,0,0.14)");
  groove.addColorStop(0.55, "rgba(0,0,0,0.07)");
  groove.addColorStop(0.93, "rgba(0,0,0,0.12)");
  groove.addColorStop(1.00, "rgba(0,0,0,0.00)");
  ctx.fillStyle = groove;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGrassTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#5b874b";
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    d[i] = Math.max(0, Math.min(255, d[i] + n * 0.4 + 5));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n * 0.7 + 8));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n * 0.35 + 3));
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < 680; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const w = 0.7 + Math.random() * 0.9;
    const h = 2.2 + Math.random() * 3.8;
    ctx.fillStyle = `rgba(72,130,62,${0.12 + Math.random() * 0.16})`;
    ctx.fillRect(x, y, w, h);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGravelTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#b79d6d";
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 24;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n * 0.9));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n * 0.65));
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < 500; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 0.45 + Math.random() * 1.0;
    const shade = 130 + Math.random() * 45;
    ctx.fillStyle = `rgba(${shade},${shade - 10},${shade - 34},${0.25 + Math.random() * 0.3})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeArmcoTexture() {
  const w = 128;
  const h = 64;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f4f4f6";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#d61d1d";
  ctx.fillRect(0, 22, w, 18);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Procedural normal map for the asphalt — gives the surface real bump under
// directional lighting and IBL reflection. Built by generating a height field
// of low-frequency noise, blurring it, then computing per-pixel normals via
// central differences (cheap Sobel-equivalent).
function makeAsphaltNormalMap() {
  const size = 256;
  const heights = new Float32Array(size * size);
  // Layer two octaves of value noise for that "coarse with fine grain" look.
  for (let i = 0; i < heights.length; i++) heights[i] = Math.random();
  // Box-blur once to soften single-pixel spikes (which would flicker badly
  // with view distance).
  const blurred = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = (x + dx + size) % size;
          const yy = (y + dy + size) % size;
          sum += heights[yy * size + xx];
          count++;
        }
      }
      blurred[y * size + x] = sum / count;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const d = img.data;
  // Strength tuned so reflections shimmer without making the surface look
  // like coarse gravel.
  const STRENGTH = 0.55;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xL = (x - 1 + size) % size, xR = (x + 1) % size;
      const yU = (y - 1 + size) % size, yD = (y + 1) % size;
      const dx = (blurred[y * size + xR] - blurred[y * size + xL]) * STRENGTH;
      const dy = (blurred[yD * size + x] - blurred[yU * size + x]) * STRENGTH;
      // Tangent-space normal: pack into (R, G, B) with Z dominant (out of
      // surface). Length-normalise so the map is valid.
      let nx = -dx, ny = -dy, nz = 1.0;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const idx = (y * size + x) * 4;
      d[idx + 0] = (nx * 0.5 + 0.5) * 255;
      d[idx + 1] = (ny * 0.5 + 0.5) * 255;
      d[idx + 2] = (nz * 0.5 + 0.5) * 255;
      d[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// Neutral-grey noise texture for paved surroundings (ground, runoff). A
// midtone (~128) base lets the material's `color` preset actually read
// through — a dark base would be multiplied with the preset colour and the
// surface would collapse to near-black, which used to make the ground
// indistinguishable from the asphalt track. Low-amplitude noise keeps the
// surface from tiling into a visible weave at grazing angles.
function makeConcreteTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#8a8a90";
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    d[i]     = Math.max(0, Math.min(255, d[i]     + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  // A handful of darker flecks — reads as grit without being structured.
  for (let i = 0; i < 220; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    ctx.fillStyle = `rgba(40,40,48,${0.15 + Math.random() * 0.2})`;
    ctx.fillRect(x, y, 1 + Math.random() * 1.5, 1 + Math.random() * 1.5);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeKerbStripeTexture() {
  const w = 32;
  const h = 128;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const band = 8;
  for (let y = 0; y < h; y += band) {
    const isRed = ((y / band) | 0) % 2 === 0;
    ctx.fillStyle = isRed ? "#ff3a24" : "#f2f3f6";
    ctx.fillRect(0, y, w, band);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Module-scope texture cache. The procedural textures are deterministic and
// circuit-independent, so regenerating the canvas pixel data on every scene
// rebuild (geoVersion/qualityVersion/todKey change) was wasted work. We cache
// the produced THREE.CanvasTexture and return a lightweight Texture wrapping
// the same `image` (canvas) for each scene — that lets each consumer set its
// own `repeat` / `wrapS` / `colorSpace` without invalidating the GPU upload
// on the shared instance.
const TEX_CACHE = {
  asphalt: null, asphaltNormal: null, runoff: null, grass: null,
  gravel: null, armco: null, concrete: null, kerb: null,
};
function cachedTex(key, factory) {
  if (!TEX_CACHE[key]) TEX_CACHE[key] = factory();
  // Wrap the cached canvas in a fresh Texture so repeat/wrap can be tuned
  // per-mesh. The image data is shared so the GPU upload (the expensive part)
  // is reused across all scenes built since module load.
  const src = TEX_CACHE[key];
  const tex = new THREE.CanvasTexture(src.image);
  tex.wrapS = src.wrapS;
  tex.wrapT = src.wrapT;
  tex.anisotropy = src.anisotropy;
  tex.colorSpace = src.colorSpace;
  return tex;
}

// Module-scope PMREM environment cache. RoomEnvironment is a fixed neutral
// studio — keyed only on the renderer's existence, not on circuit/quality.
let _pmremEnv = null;
let _pmremRendererRef = null;
function getRoomEnvironment(renderer) {
  if (_pmremEnv && _pmremRendererRef === renderer) return _pmremEnv;
  if (_pmremEnv) _pmremEnv.dispose();
  const pmrem = new THREE.PMREMGenerator(renderer);
  _pmremEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  _pmremRendererRef = renderer;
  pmrem.dispose();
  return _pmremEnv;
}

// ───────────────────────────────────────────────────────────────────────────
// Curve + ribbon geometry.
// ───────────────────────────────────────────────────────────────────────────

function buildCenterlineCurve(circuit, zBase, scale) {
  const pts = [];
  for (const raw of circuit) {
    const x = Number(raw?.x), y = Number(raw?.y), z = Number(raw?.z ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    pts.push(toThree({ x, y, z }, zBase, scale));
  }
  if (pts.length === 0) {
    pts.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0));
  } else if (pts.length === 1) {
    pts.push(pts[0].clone().add(new THREE.Vector3(1, 0, 0)));
  }
  // A duplicate closing vertex makes Catmull-Rom kink — drop it if the
  // publisher appended one.
  if (pts.length >= 3 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-3) {
    pts.pop();
  }
  const closed = pts.length >= 3;
  const curve = new THREE.CatmullRomCurve3(pts, closed, "centripetal", 0.5);
  // Arc-length divisions drive the accuracy of `getPointAt`/`getTangentAt`,
  // which sample uniformly along the curve's arc length rather than its
  // parameter t. Default (200) is too coarse for tracks up to ~7 km — bump
  // to ~`pts.length` so kerb stripes / racing-line dashes stay evenly
  // spaced through tight hairpins and long straights alike.
  curve.arcLengthDivisions = Math.max(400, pts.length * 2);
  return curve;
}

// Per-curve frame cache. Each ribbon helper used to walk the curve from
// scratch — for ~12 ribbons × 2000 segments, that's ~24k getPointAt +
// getTangentAt calls during scene build, plus the "stable right" rolling
// frame computation duplicated each time. We sample once per (curve,
// segments) and reuse the Float32 arrays for every consumer.
//
// Returns interleaved buffers:
//   points:   [x0,y0,z0, x1,y1,z1, ...]                — `(N+1) * 3`
//   tangents: [tx,ty,tz, ...]                          — `(N+1) * 3`
//   rights:   [rx,ry,rz, ...] (in track plane, world-up biased) — `(N+1) * 3`
const _frameCache = new WeakMap(); // curve → Map<segments, frames>
function sampleCurveFrames(curve, segments) {
  let bySeg = _frameCache.get(curve);
  if (!bySeg) {
    bySeg = new Map();
    _frameCache.set(curve, bySeg);
  }
  const cached = bySeg.get(segments);
  if (cached) return cached;

  const N = segments + 1;
  const points = new Float32Array(N * 3);
  const tangents = new Float32Array(N * 3);
  const rights = new Float32Array(N * 3);
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3();
  const prevRight = new THREE.Vector3();
  const tan = new THREE.Vector3();
  let havePrevRight = false;

  for (let i = 0; i < N; i++) {
    const t = i / segments;
    const p = curve.getPointAt(t);
    curve.getTangentAt(t, tan);
    havePrevRight = updateStableRight(tan, up, right, prevRight, havePrevRight);
    points[i * 3 + 0] = p.x;
    points[i * 3 + 1] = p.y;
    points[i * 3 + 2] = p.z;
    tangents[i * 3 + 0] = tan.x;
    tangents[i * 3 + 1] = tan.y;
    tangents[i * 3 + 2] = tan.z;
    rights[i * 3 + 0] = right.x;
    rights[i * 3 + 1] = right.y;
    rights[i * 3 + 2] = right.z;
  }

  const frames = { points, tangents, rights, count: N };
  bySeg.set(segments, frames);
  return frames;
}

function updateStableRight(tan, up, right, prevRight, havePrevRight) {
  right.crossVectors(tan, up);
  const len2 = right.lengthSq();
  if (len2 < 1e-10) {
    if (havePrevRight) right.copy(prevRight);
    else right.set(1, 0, 0);
  } else {
    right.multiplyScalar(1 / Math.sqrt(len2));
    if (havePrevRight && right.dot(prevRight) < 0) right.multiplyScalar(-1);
  }
  prevRight.copy(right);
  return true;
}

// Ribbon of constant half-width along the curve. `yLift` puts layered ribbons
// (runoff, track, kerbs) on separate tiny y-planes to avoid z-fighting.
// `uvRepeat` controls how many times the texture tiles along the length.
//
// Uses arc-length-uniform sampling (`getPointAt`/`getTangentAt`) so segments
// represent equal real-world distance — kerb stripes stay evenly spaced
// through hairpins instead of bunching where the parametric `t` compresses.
function buildRibbonGeometry(curve, segments, halfWidth, yLift, uvRepeat = 80) {
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const indices = [];
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3();
  const prevRight = new THREE.Vector3();
  const tan = new THREE.Vector3();
  let havePrevRight = false;

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = curve.getPointAt(t);
    curve.getTangentAt(t, tan);
    havePrevRight = updateStableRight(tan, up, right, prevRight, havePrevRight);
    positions[i * 6 + 0] = p.x - right.x * halfWidth;
    positions[i * 6 + 1] = p.y + yLift;
    positions[i * 6 + 2] = p.z - right.z * halfWidth;
    positions[i * 6 + 3] = p.x + right.x * halfWidth;
    positions[i * 6 + 4] = p.y + yLift;
    positions[i * 6 + 5] = p.z + right.z * halfWidth;
    uvs[i * 4 + 0] = 0; uvs[i * 4 + 1] = t * uvRepeat;
    uvs[i * 4 + 2] = 1; uvs[i * 4 + 3] = t * uvRepeat;
    if (i < segments) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

function buildPartialEdgeLineGeometry(curve, segments, uStart, uEnd, offset, width, yLift, uvRepeat = 1) {
  const span = uEnd >= uStart ? (uEnd - uStart) : (1 - uStart + uEnd);
  const partSegs = Math.max(4, Math.floor(segments * span));
  const positions = new Float32Array((partSegs + 1) * 2 * 3);
  const uvs = new Float32Array((partSegs + 1) * 2 * 2);
  const indices = [];
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3();
  const prevRight = new THREE.Vector3();
  const tan = new THREE.Vector3();
  let havePrevRight = false;
  const half = width * 0.5;
  for (let i = 0; i <= partSegs; i++) {
    const t = i / partSegs;
    const u = (uStart + t * span) % 1;
    const p = curve.getPointAt(u);
    curve.getTangentAt(u, tan);
    havePrevRight = updateStableRight(tan, up, right, prevRight, havePrevRight);
    const inner = offset - half;
    const outer = offset + half;
    positions[i * 6 + 0] = p.x + right.x * inner;
    positions[i * 6 + 1] = p.y + yLift;
    positions[i * 6 + 2] = p.z + right.z * inner;
    positions[i * 6 + 3] = p.x + right.x * outer;
    positions[i * 6 + 4] = p.y + yLift;
    positions[i * 6 + 5] = p.z + right.z * outer;
    uvs[i * 4 + 0] = 0; uvs[i * 4 + 1] = t * uvRepeat;
    uvs[i * 4 + 2] = 1; uvs[i * 4 + 3] = t * uvRepeat;
    if (i < partSegs) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = (i + 1) * 2;
      const d = (i + 1) * 2 + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

function buildVerticalRibbonGeometry(curve, segments, offset, width, yLift, height, uvRepeat = 1) {
  const positions = new Float32Array((segments + 1) * 4 * 3);
  const uvs = new Float32Array((segments + 1) * 4 * 2);
  const indices = [];
  const half = width * 0.5;
  const frames = sampleCurveFrames(curve, segments);
  const fp = frames.points, fr = frames.rights;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const px = fp[i * 3], py = fp[i * 3 + 1], pz = fp[i * 3 + 2];
    const rx = fr[i * 3], rz = fr[i * 3 + 2];
    const inner = offset - half;
    const outer = offset + half;
    const base = i * 12;
    positions[base + 0] = px + rx * inner;
    positions[base + 1] = py + yLift;
    positions[base + 2] = pz + rz * inner;
    positions[base + 3] = px + rx * outer;
    positions[base + 4] = py + yLift;
    positions[base + 5] = pz + rz * outer;
    positions[base + 6] = px + rx * inner;
    positions[base + 7] = py + yLift + height;
    positions[base + 8] = pz + rz * inner;
    positions[base + 9] = px + rx * outer;
    positions[base + 10] = py + yLift + height;
    positions[base + 11] = pz + rz * outer;

    const uvBase = i * 8;
    uvs[uvBase + 0] = 0; uvs[uvBase + 1] = t * uvRepeat;
    uvs[uvBase + 2] = 1; uvs[uvBase + 3] = t * uvRepeat;
    uvs[uvBase + 4] = 0; uvs[uvBase + 5] = t * uvRepeat;
    uvs[uvBase + 6] = 1; uvs[uvBase + 7] = t * uvRepeat;
    if (i < segments) {
      const a = i * 4;
      const b = (i + 1) * 4;
      indices.push(a + 0, b + 0, a + 2, a + 2, b + 0, b + 2);
      indices.push(a + 1, a + 3, b + 1, a + 3, b + 3, b + 1);
      indices.push(a + 2, b + 2, a + 3, a + 3, b + 2, b + 3);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

function buildCornerRanges(curve, sampleCount = 720) {
  const tangents = new Array(sampleCount + 1);
  for (let i = 0; i <= sampleCount; i++) {
    tangents[i] = curve.getTangentAt(i / sampleCount).clone().normalize();
  }
  const values = [];
  let maxAbs = 0;
  for (let i = 0; i < sampleCount; i++) {
    const a = tangents[i];
    const b = tangents[(i + 1) % sampleCount];
    const dot = Math.max(-1, Math.min(1, a.dot(b)));
    const angle = Math.acos(dot);
    const sign = Math.sign(a.clone().cross(b).y || 0);
    const signedCurvature = angle * (sign === 0 ? 1 : sign);
    values.push(signedCurvature);
    const absK = Math.abs(signedCurvature);
    if (absK > maxAbs) maxAbs = absK;
  }
  const threshold = Math.max(0.008, maxAbs * 0.35);
  const active = values.map((v) => Math.abs(v) >= threshold);
  const ranges = [];
  let i = 0;
  while (i < sampleCount) {
    if (!active[i]) {
      i++;
      continue;
    }
    const start = i;
    while (i < sampleCount && active[i]) i++;
    const end = i - 1;
    if (end - start + 1 < 6) continue;
    let apex = start;
    for (let j = start + 1; j <= end; j++) {
      if (Math.abs(values[j]) > Math.abs(values[apex])) apex = j;
    }
    ranges.push({
      startU: start / sampleCount,
      endU: (end + 1) / sampleCount,
      apexU: apex / sampleCount,
      sign: Math.sign(values[apex]) || 1,
    });
  }
  if (ranges.length >= 2 && active[0] && active[sampleCount - 1]) {
    const first = ranges[0];
    const last = ranges[ranges.length - 1];
    ranges[0] = {
      startU: last.startU,
      endU: first.endU,
      apexU: Math.abs(last.sign) >= Math.abs(first.sign) ? last.apexU : first.apexU,
      sign: Math.abs(last.sign) >= Math.abs(first.sign) ? last.sign : first.sign,
    };
    ranges.pop();
  }
  return ranges;
}

// Extruded ribbon — a top surface + outer side walls (no bottom cap, it's
// never seen). Gives the track real vertical thickness so it physically sits
// above the ground plane and cannot z-fight under any camera angle. The top
// face carries UVs for the asphalt albedo; side walls use a flat UV so the
// raw asphalt colour shows on the edge chamfer without tile seams.
//
// Vertex layout per ring (4 verts): 0 top-left, 1 top-right, 2 bot-left,
// 3 bot-right. Side faces are stitched between consecutive rings.
function buildExtrudedRibbonGeometry(curve, segments, halfWidth, baseY, thickness, uvRepeat = 80) {
  const vertsPerRing = 4;
  const positions = new Float32Array((segments + 1) * vertsPerRing * 3);
  const uvs = new Float32Array((segments + 1) * vertsPerRing * 2);
  const indices = [];
  const frames = sampleCurveFrames(curve, segments);
  const fp = frames.points, fr = frames.rights;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const px = fp[i * 3], py = fp[i * 3 + 1], pz = fp[i * 3 + 2];
    const rx = fr[i * 3], rz = fr[i * 3 + 2];
    const yTop = py + baseY + thickness;
    const yBot = py + baseY;
    const base = i * vertsPerRing * 3;
    // top-left
    positions[base + 0] = px - rx * halfWidth;
    positions[base + 1] = yTop;
    positions[base + 2] = pz - rz * halfWidth;
    // top-right
    positions[base + 3] = px + rx * halfWidth;
    positions[base + 4] = yTop;
    positions[base + 5] = pz + rz * halfWidth;
    // bot-left
    positions[base + 6] = px - rx * halfWidth;
    positions[base + 7] = yBot;
    positions[base + 8] = pz - rz * halfWidth;
    // bot-right
    positions[base + 9]  = px + rx * halfWidth;
    positions[base + 10] = yBot;
    positions[base + 11] = pz + rz * halfWidth;
    // UVs: top face uses (0..1, t*repeat). Side walls reuse u=0/1 plus the
    // same length coord so texturing is continuous.
    const uvBase = i * vertsPerRing * 2;
    uvs[uvBase + 0] = 0; uvs[uvBase + 1] = t * uvRepeat; // top-left
    uvs[uvBase + 2] = 1; uvs[uvBase + 3] = t * uvRepeat; // top-right
    uvs[uvBase + 4] = 0; uvs[uvBase + 5] = t * uvRepeat; // bot-left
    uvs[uvBase + 6] = 1; uvs[uvBase + 7] = t * uvRepeat; // bot-right
    if (i < segments) {
      const a = i * vertsPerRing;
      const b = (i + 1) * vertsPerRing;
      // Top face (winding so normal points +Y).
      indices.push(a + 0, a + 1, b + 0, a + 1, b + 1, b + 0);
      // Left side wall (normal points -right).
      indices.push(a + 2, a + 0, b + 2, a + 0, b + 0, b + 2);
      // Right side wall (normal points +right).
      indices.push(a + 3, b + 3, a + 1, a + 1, b + 3, b + 1);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

// Thin painted edge line (like white track boundaries) — a slab offset from
// the centerline by `offset` with a small `width`. Used for both edge
// stripes and for the runoff parallel strips. `uvRepeat` controls how many
// times a mapped texture tiles along the length.
function buildEdgeLineGeometry(curve, segments, offset, width, yLift, uvRepeat = 1) {
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const indices = [];
  const half = width * 0.5;
  const frames = sampleCurveFrames(curve, segments);
  const fp = frames.points, fr = frames.rights;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const px = fp[i * 3], py = fp[i * 3 + 1], pz = fp[i * 3 + 2];
    const rx = fr[i * 3], rz = fr[i * 3 + 2];
    const inner = offset - half, outer = offset + half;
    positions[i * 6 + 0] = px + rx * inner;
    positions[i * 6 + 1] = py + yLift;
    positions[i * 6 + 2] = pz + rz * inner;
    positions[i * 6 + 3] = px + rx * outer;
    positions[i * 6 + 4] = py + yLift;
    positions[i * 6 + 5] = pz + rz * outer;
    uvs[i * 4 + 0] = 0; uvs[i * 4 + 1] = t * uvRepeat;
    uvs[i * 4 + 2] = 1; uvs[i * 4 + 3] = t * uvRepeat;
    if (i < segments) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

// Raised, extruded kerbs with a top face + outer fascia (the inner face is
// hidden against the track surface, the underside never sees the camera).
// Colour stripes are painted by duplicating vertices at each colour boundary
// so the bands are crisp instead of gradient-interpolated.
//
// At ~2000 segments around a 5 km track, STRIPE_SEGS=2 ≈ 5 m per stripe —
// matches real F1 kerbing.
function buildKerbGeometry(curve, segments, innerOffset, outerOffset, side, kerbHeight, baseYOffset = 0.05) {
  const STRIPE_SEGS = 2;
  const red = new THREE.Color(0xff1e00);
  const white = new THREE.Color(0xf4f4f8);
  const positions = [];
  const colors = [];
  const indices = [];
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3();
  const prevRight = new THREE.Vector3();
  const tan = new THREE.Vector3();
  let havePrevRight = false;
  // Per ring at curve-step i we emit 3 vertices:
  //   0: bottom-outer (sits on track surface, hidden by ribbon)
  //   1: top-inner    (top edge nearest the racing surface)
  //   2: top-outer    (top edge nearest the runoff)
  // Stripe boundaries split the ring so each band has its own pair.
  let lastBand = -1;
  const pushRing = (t, band) => {
    const p = curve.getPointAt(t);
    curve.getTangentAt(t, tan);
    havePrevRight = updateStableRight(tan, up, right, prevRight, havePrevRight);
    const inner = side * innerOffset;
    const outer = side * outerOffset;
    const baseY = p.y + baseYOffset;
    const topY = p.y + baseYOffset + kerbHeight;
    positions.push(
      p.x + right.x * outer, baseY, p.z + right.z * outer,
      p.x + right.x * inner, topY,  p.z + right.z * inner,
      p.x + right.x * outer, topY,  p.z + right.z * outer,
    );
    const c = (band % 2 === 0) ? red : white;
    colors.push(c.r, c.g, c.b, c.r, c.g, c.b, c.r, c.g, c.b);
  };
  let ringCount = 0;
  for (let i = 0; i <= segments; i++) {
    const band = Math.floor(i / STRIPE_SEGS);
    const t = i / segments;
    if (band !== lastBand && i > 0) {
      // Insert a duplicate ring at the same t so the colour change is hard.
      pushRing(t, lastBand);
      ringCount++;
      // Stitch quads from previous ring (ringCount - 2) to this duplicate
      // (ringCount - 1).
      const a0 = (ringCount - 2) * 3;
      const a1 = (ringCount - 1) * 3;
      // top face quad: a0+1, a0+2, a1+1, a1+2
      indices.push(a0 + 1, a0 + 2, a1 + 1, a1 + 1, a0 + 2, a1 + 2);
      // outer face quad: a0+0, a0+2, a1+0, a1+2
      indices.push(a0 + 0, a0 + 2, a1 + 0, a1 + 0, a0 + 2, a1 + 2);
    }
    pushRing(t, band);
    ringCount++;
    if (i > 0 && (band === lastBand || lastBand === -1)) {
      const a0 = (ringCount - 2) * 3;
      const a1 = (ringCount - 1) * 3;
      indices.push(a0 + 1, a0 + 2, a1 + 1, a1 + 1, a0 + 2, a1 + 2);
      indices.push(a0 + 0, a0 + 2, a1 + 0, a1 + 0, a0 + 2, a1 + 2);
    }
    lastBand = band;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

// Bright green DRS zone stripe on the outer kerb edge. Index range is given
// relative to the original CIRCUIT array; we project it onto the curve's
// normalised [0, 1] parameter and build a short ribbon across that span.
function buildDRSZoneMesh(curve, segments, circuitLen, zone, side) {
  const n = Math.max(1, circuitLen - 1);
  const uStart = Math.max(0, Math.min(1, zone.startIdx / n));
  const uEnd = Math.max(0, Math.min(1, zone.endIdx / n));
  const span = uEnd >= uStart ? (uEnd - uStart) : (1 - uStart + uEnd); // allow wrap
  const zoneSegs = Math.max(12, Math.floor(span * segments));
  const positions = new Float32Array((zoneSegs + 1) * 2 * 3);
  const indices = [];
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3();
  const prevRight = new THREE.Vector3();
  const tan = new THREE.Vector3();
  let havePrevRight = false;
  const inner = side * (TRACK_WIDTH + KERB_WIDTH + 0.4);
  const outer = side * (TRACK_WIDTH + KERB_WIDTH + 0.4 + DRS_STRIPE_WIDTH);
  for (let i = 0; i <= zoneSegs; i++) {
    const tu = i / zoneSegs;
    const u = (uStart + tu * span) % 1;
    const p = curve.getPointAt(u);
    curve.getTangentAt(u, tan);
    havePrevRight = updateStableRight(tan, up, right, prevRight, havePrevRight);
    positions[i * 6 + 0] = p.x + right.x * inner;
    positions[i * 6 + 1] = p.y + 0.42;
    positions[i * 6 + 2] = p.z + right.z * inner;
    positions[i * 6 + 3] = p.x + right.x * outer;
    positions[i * 6 + 4] = p.y + 0.42;
    positions[i * 6 + 5] = p.z + right.z * outer;
    if (i < zoneSegs) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    color: 0x18ff74, transparent: true, opacity: 0.55,
    depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.renderOrder = 3;
  return mesh;
}

// A short coloured bar laid across the track at the start of a sector. Sits
// at y=0.11, just above the track surface.
function buildSectorGate(curve, circuitLen, idx, color) {
  const n = Math.max(1, circuitLen - 1);
  const u = Math.max(0, Math.min(1, idx / n));
  const p = curve.getPointAt(u);
  const tan = new THREE.Vector3();
  curve.getTangentAt(u, tan);
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(tan, up).normalize();
  const halfW = TRACK_WIDTH + KERB_WIDTH;
  const depth = 0.9;
  const positions = new Float32Array([
    p.x + right.x * -halfW - tan.x * depth * 0.5, p.y + 0.40, p.z + right.z * -halfW - tan.z * depth * 0.5,
    p.x + right.x *  halfW - tan.x * depth * 0.5, p.y + 0.40, p.z + right.z *  halfW - tan.z * depth * 0.5,
    p.x + right.x * -halfW + tan.x * depth * 0.5, p.y + 0.40, p.z + right.z * -halfW + tan.z * depth * 0.5,
    p.x + right.x *  halfW + tan.x * depth * 0.5, p.y + 0.40, p.z + right.z *  halfW + tan.z * depth * 0.5,
  ]);
  const indices = [0, 2, 1, 1, 2, 3];
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  let gateColor = 0xf4f4f8;
  if (typeof color === "string") {
    const c = color.trim().toLowerCase();
    if (c === "purple") gateColor = 0xb78cff;
    else if (c === "green") gateColor = 0x18ff74;
    else if (c === "yellow") gateColor = 0xffd84a;
    else if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
      const hex = c.slice(1);
      gateColor = Number.parseInt(
        hex.length === 3 ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}` : hex,
        16,
      );
    }
  } else if (typeof color === "number") {
    gateColor = color;
  }
  const mat = new THREE.MeshBasicMaterial({
    color: gateColor, transparent: true, opacity: 0.52,
    depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.renderOrder = 3;
  return mesh;
}

function buildStartFinishMesh(curve, halfWidth) {
  const p = curve.getPoint(0);
  const tan = new THREE.Vector3();
  curve.getTangent(0, tan);
  // Thin axis along tangent, long axis spans the track width.
  const planeGeom = new THREE.PlaneGeometry(5, halfWidth * 2, 2, 8);
  planeGeom.rotateX(-Math.PI / 2);
  const canvas = document.createElement("canvas");
  canvas.width = 8; canvas.height = 64;
  const ctx = canvas.getContext("2d");
  for (let i = 0; i < 16; i++) {
    ctx.fillStyle = i % 2 ? "#ffffff" : "#6d7382";
    ctx.fillRect(0, i * 4, 8, 4);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 4);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0.72, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(planeGeom, mat);
  mesh.position.set(p.x, p.y + 0.41, p.z);
  mesh.rotation.y = Math.atan2(-tan.z, tan.x);
  mesh.renderOrder = 3;
  return mesh;
}

function buildRacingLineMesh(curve, segments) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const p = curve.getPointAt(i / segments);
    pts.push(new THREE.Vector3(p.x, p.y + 0.39, p.z));
  }
  const geom = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineDashedMaterial({
    color: 0xd7deef, dashSize: 10, gapSize: 16, transparent: true, opacity: 0.12,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  const line = new THREE.Line(geom, mat);
  line.computeLineDistances();
  line.renderOrder = 3;
  return line;
}

// ───────────────────────────────────────────────────────────────────────────
// Car marker — GLB-based F1 model with indicator overlays. Exposes `userData`
// hooks so the animate loop can toggle brake/DRS lights and halo state cheaply.
// Local coord frame: +X is forward, +Y up, +Z right (matched to GLB via
// rotation after cloning).
// ───────────────────────────────────────────────────────────────────────────

// Shared GLTF loader — one instance for the whole module.
const gltfLoader = new GLTFLoader();

// Singleton promise: loads the base GLB model once, then clones for each car.
// The model path is relative to the HTML page (served from dist/assets/).
const CAR_MODEL_PATH = "assets/f1-car.glb";
let _baseModelPromise = null;

// Per-team material cache: each team's coloured body material is built once
// and reused for every driver on that team. Two drivers per team × 10 teams
// → 10 materials total instead of 20 deep-cloned ones. Wheels share a single
// black material across all teams. Materials must remain unique per
// transparent state because we toggle opacity for PIT/DNS — but the bulk of
// the grid stays opaque, so the cache pays off.
const _teamBodyMatCache = new Map(); // key: team color hex string → material[]
const _wheelMatCache = { mat: null };
function getWheelMaterial(template) {
  if (_wheelMatCache.mat) return _wheelMatCache.mat;
  const m = template.clone();
  if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) m.color.set(0x0a0a0a);
  _wheelMatCache.mat = m;
  return m;
}

function loadBaseCarModel() {
  if (_baseModelPromise) return _baseModelPromise;
  _baseModelPromise = new Promise((resolve, reject) => {
    gltfLoader.load(
      CAR_MODEL_PATH,
      (gltf) => {
        const model = gltf.scene;
        // Disable shadow casting on all meshes — at wide zoom levels the tiny
        // geometry aliasing in the directional shadow map produces long black
        // spike artifacts on the ground/runoff.
        model.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = false;
            child.receiveShadow = false;
          }
        });
        resolve(model);
      },
      undefined,
      (err) => {
        console.warn("GLB car model failed to load, will use fallback:", err);
        _baseModelPromise = null;
        reject(err);
      },
    );
  });
  return _baseModelPromise;
}

const SAFETY_CAR_MODEL_PATH = "assets/safety_car.glb";
let _safetyCarModelPromise = null;

function loadSafetyCarModel() {
  if (_safetyCarModelPromise) return _safetyCarModelPromise;
  _safetyCarModelPromise = new Promise((resolve, reject) => {
    gltfLoader.load(
      SAFETY_CAR_MODEL_PATH,
      (gltf) => {
        const model = gltf.scene;
        model.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = false;
            child.receiveShadow = false;
          }
        });
        resolve(model);
      },
      undefined,
      (err) => {
        console.warn("Safety car GLB failed to load, will use fallback:", err);
        _safetyCarModelPromise = null;
        reject(err);
      },
    );
  });
  return _safetyCarModelPromise;
}

// Build a fallback car from primitives (same as the old makeDriverMarker) if
// the GLB model fails to load.
function makeFallbackMarker(team) {
  const g = new THREE.Group();
  const color = new THREE.Color(team?.color || "#ff1e00");
  const bodyMat = new THREE.MeshStandardMaterial({
    color, roughness: 0.32, metalness: 0.45,
    emissive: color, emissiveIntensity: 0.06,
    envMapIntensity: 1.4,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x080810, roughness: 0.42, metalness: 0.35,
    envMapIntensity: 1.1,
  });
  const tyreMat = new THREE.MeshStandardMaterial({
    color: 0x101015, roughness: 0.92, metalness: 0.0,
    envMapIntensity: 0.4,
  });

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(CAR_LENGTH, 0.3, CAR_WIDTH * 0.9), bodyMat);
  floor.position.y = 0.25; g.add(floor);
  const sidepods = new THREE.Mesh(
    new THREE.BoxGeometry(CAR_LENGTH * 0.55, 0.55, CAR_WIDTH * 0.85), bodyMat);
  sidepods.position.set(-CAR_LENGTH * 0.05, 0.55, 0); g.add(sidepods);
  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(CAR_LENGTH * 0.45, 0.3, CAR_WIDTH * 0.3), bodyMat);
  nose.position.set(CAR_LENGTH * 0.38, 0.4, 0); g.add(nose);
  const airbox = new THREE.Mesh(
    new THREE.BoxGeometry(CAR_LENGTH * 0.2, 0.55, CAR_WIDTH * 0.3), bodyMat);
  airbox.position.set(-CAR_LENGTH * 0.1, 1.0, 0); g.add(airbox);
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.35, 0.04, 6, 12, Math.PI), darkMat);
  halo.position.set(-CAR_LENGTH * 0.02, 0.95, 0);
  halo.rotation.x = Math.PI * 0.5; halo.rotation.y = Math.PI * 0.5; g.add(halo);
  const frontWing = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.08, CAR_WIDTH * 1.1), darkMat);
  frontWing.position.set(CAR_LENGTH * 0.55, 0.25, 0); g.add(frontWing);
  const rearWingFlap = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.14, CAR_WIDTH), darkMat);
  rearWingFlap.position.set(-CAR_LENGTH * 0.55, 1.0, 0); g.add(rearWingFlap);
  const rearEndplateL = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.9, 0.08), darkMat);
  rearEndplateL.position.set(-CAR_LENGTH * 0.55, 0.58, -CAR_WIDTH * 0.5); g.add(rearEndplateL);
  const rearEndplateR = rearEndplateL.clone();
  rearEndplateR.position.z = CAR_WIDTH * 0.5; g.add(rearEndplateR);

  const wheelPositions = [
    [CAR_LENGTH * 0.3, -CAR_WIDTH * 0.55], [CAR_LENGTH * 0.3, CAR_WIDTH * 0.55],
    [-CAR_LENGTH * 0.3, -CAR_WIDTH * 0.55], [-CAR_LENGTH * 0.3, CAR_WIDTH * 0.55],
  ];
  const wheelGeom = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 18);
  wheelGeom.rotateX(Math.PI / 2);
  const wheels = [];
  for (const [wx, wz] of wheelPositions) {
    const w = new THREE.Mesh(wheelGeom, tyreMat);
    w.position.set(wx, WHEEL_RADIUS, wz); g.add(w); wheels.push(w);
  }
  for (const m of [floor, sidepods, nose, airbox, halo, frontWing,
                   rearWingFlap, rearEndplateL, rearEndplateR, ...wheels]) {
    m.castShadow = false; m.receiveShadow = false;
  }
  g.userData = {
    body: [floor, sidepods, nose, airbox, rearWingFlap, rearEndplateL, rearEndplateR, frontWing],
    bodyMats: [bodyMat, darkMat],
    wheels,
    wheelMats: [tyreMat],
    baseColor: color.clone(),
  };
  return g;
}

// Soft round shadow under each car. Cheap fake of a contact shadow — sells
// "the car is touching the ground" without paying for a real shadow map. A
// single radial-gradient texture is built once and shared as a sprite-style
// PlaneGeometry under every car. Shared geometry + material → near-zero cost.
let _blobShadowTex = null;
let _blobShadowGeom = null;
let _blobShadowMat = null;
function getBlobShadowAssets() {
  if (!_blobShadowTex) {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0.0, "rgba(0,0,0,0.55)");
    grad.addColorStop(0.5, "rgba(0,0,0,0.28)");
    grad.addColorStop(1.0, "rgba(0,0,0,0.0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    _blobShadowTex = new THREE.CanvasTexture(canvas);
    _blobShadowTex.colorSpace = THREE.SRGBColorSpace;
  }
  if (!_blobShadowGeom) {
    // Slightly elongated along X (car forward) so the blob reads as a body
    // shadow rather than a perfect circle. Lifted just above the track top.
    _blobShadowGeom = new THREE.PlaneGeometry(CAR_LENGTH * 0.95, CAR_WIDTH * 1.6);
    _blobShadowGeom.rotateX(-Math.PI / 2);
  }
  if (!_blobShadowMat) {
    _blobShadowMat = new THREE.MeshBasicMaterial({
      map: _blobShadowTex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: false,
    });
  }
  return { geom: _blobShadowGeom, mat: _blobShadowMat };
}

// Add indicator overlays (ground halo, brake/DRS lamps, compound dot) to a
// car group. These are functional indicators that sit on top of any car model.
function addIndicatorOverlays(g, color) {
  // Soft contact shadow blob — shared geometry + material across all cars.
  const blob = getBlobShadowAssets();
  const blobMesh = new THREE.Mesh(blob.geom, blob.mat);
  // Sit just above the track top (track top sits at the car group's local Y=0
  // by virtue of the surface offset applied in the animate loop). A small
  // positive Y prevents z-fighting with kerb/edge lines.
  blobMesh.position.y = 0.012;
  blobMesh.renderOrder = 2;
  g.add(blobMesh);
  g.userData.blobShadow = blobMesh;

  // DRS indicator — a thin strip on the top of the rear that lights up blue.
  const drsMat = new THREE.MeshBasicMaterial({
    color: 0x00d9ff, transparent: true, opacity: 0.0,
  });
  const drsLamp = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.08, CAR_WIDTH * 0.75), drsMat,
  );
  drsLamp.position.set(-CAR_LENGTH * 0.57, 1.12, 0);
  g.add(drsLamp);

  // Brake lights — twin red squares at the rear.
  const brakeMat = new THREE.MeshBasicMaterial({
    color: 0xff3040, transparent: true, opacity: 0.0,
  });
  const brakeGeom = new THREE.BoxGeometry(0.1, 0.1, 0.15);
  const brakeL = new THREE.Mesh(brakeGeom, brakeMat);
  brakeL.position.set(-CAR_LENGTH * 0.52, 0.35, -CAR_WIDTH * 0.2);
  g.add(brakeL);
  const brakeR = brakeL.clone();
  brakeR.position.z = CAR_WIDTH * 0.2;
  g.add(brakeR);

  // Ground halo — always-visible marker, decoupled from car dimensions.
  const haloGeom = new THREE.RingGeometry(HALO_RADIUS * 0.75, HALO_RADIUS, 36);
  haloGeom.rotateX(-Math.PI / 2);
  const haloMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.38, depthWrite: false,
  });
  const groundHalo = new THREE.Mesh(haloGeom, haloMat);
  groundHalo.position.y = 0.02;
  g.add(groundHalo);

  // Tyre compound indicator — a small coloured dot floating above the car.
  const compGeom = new THREE.SphereGeometry(0.32, 10, 8);
  const compMat = new THREE.MeshBasicMaterial({ color: 0xffd93a });
  const compound = new THREE.Mesh(compGeom, compMat);
  compound.position.set(-CAR_LENGTH * 0.05, 1.9, 0);
  g.add(compound);

  g.userData.drsLamp = drsLamp;
  g.userData.drsMat = drsMat;
  g.userData.brakeL = brakeL;
  g.userData.brakeR = brakeR;
  g.userData.brakeMat = brakeMat;
  g.userData.groundHalo = groundHalo;
  g.userData.compound = compound;
}

// Create a driver marker using the GLB model. Returns a group immediately
// with a placeholder; the GLB model is attached asynchronously once loaded.
// The userData contract is fully compatible with the animation loop.
function makeDriverMarker(team) {
  const g = new THREE.Group();
  const color = new THREE.Color(team?.color || "#ff1e00");
  g.userData = { baseColor: color.clone(), body: [], bodyMats: [], wheels: [], wheelMats: [] };

  // Add indicator overlays right away (they work independently of the car body).
  addIndicatorOverlays(g, color);

  // Kick off the async model load. Once resolved, clone the base model and
  // insert it into the group, wiring up the userData hooks the animation loop
  // depends on.
  loadBaseCarModel().then((baseModel) => {
    const clone = baseModel.clone();
    // Geometry is shared across all cars (it's identical — only colour
    // differs). Object3D.clone() already shares the underlying BufferGeometry
    // by default; we deliberately do NOT call geometry.clone() here. The
    // module-level cleanup walks the scene graph and disposes geometry once,
    // so individual scene rebuilds don't poison the shared buffers.
    //
    // Materials are shared per team via _teamBodyMatCache: each team colour
    // owns one MeshStandardMaterial reused for every driver on that team,
    // plus one global wheel material. Cars that need transparency (PIT, DNS)
    // get a fresh per-car clone the first time that state is hit.
    const teamKey = `#${color.getHexString()}`;
    let cachedBodyMats = _teamBodyMatCache.get(teamKey);
    const matMap = new Map();
    clone.traverse((child) => {
      if (!child.isMesh) return;
      if (!child.material) return;
      const matName = (child.material.name || "").toLowerCase();
      const isWheelMat = matName.includes("wheel") || matName.includes("tire") || matName.includes("tyre");
      if (isWheelMat) {
        child.material = getWheelMaterial(child.material);
        return;
      }
      // Body material: reuse the team-cached version if we have one.
      if (cachedBodyMats && cachedBodyMats.has(child.material.uuid)) {
        child.material = cachedBodyMats.get(child.material.uuid);
        return;
      }
      // Fresh team — clone and tint the material once, store in the cache.
      if (!matMap.has(child.material.uuid)) {
        const cloned = child.material.clone();
        if (cloned.isMeshStandardMaterial || cloned.isMeshPhysicalMaterial) {
          cloned.color.copy(color);
        }
        matMap.set(child.material.uuid, cloned);
      }
      child.material = matMap.get(child.material.uuid);
    });
    if (!cachedBodyMats && matMap.size > 0) {
      _teamBodyMatCache.set(teamKey, matMap);
      cachedBodyMats = matMap;
    }
    // Collect all meshes in the clone for the animation loop hooks.
    // Separate wheels from body parts so team colour is applied to the
    // body only, not the wheels. Use material name as the primary heuristic
    // (the GLB model names its wheel material "wheels"), falling back to
    // geometry aspect ratio for unnamed materials.
    const body = [];
    const bodyMats = [];
    const wheels = [];
    const wheelMats = [];
    // If all wheels share a single mesh, we can't spin them individually —
    // store a flag so the animation loop skips the spin on GLB models.
    let wheelsAreSeparateMeshes = true;
    clone.traverse((child) => {
      if (!child.isMesh) return;
      const matName = (child.material?.name || "").toLowerCase();
      const isWheelByMat = matName.includes("wheel") || matName.includes("tire") || matName.includes("tyre");
      let isWheelByGeom = false;
      if (!isWheelByMat && child.geometry) {
        child.geometry.computeBoundingBox();
        const sz = child.geometry.boundingBox.getSize(new THREE.Vector3());
        const maxDim = Math.max(sz.x, sz.y, sz.z, 0.01);
        const minDim = Math.min(sz.x, sz.y, sz.z, 0.01);
        isWheelByGeom = (minDim / maxDim) > 0.45 && (maxDim / minDim) < 2.5;
      }
      if (isWheelByMat || isWheelByGeom) {
        wheels.push(child);
        if (child.material && !wheelMats.includes(child.material)) {
          wheelMats.push(child.material);
        }
        return;
      }
      body.push(child);
      if (child.material && !bodyMats.includes(child.material)) {
        bodyMats.push(child.material);
      }
    });
    // If fewer than 4 wheel meshes were found, the GLB likely merged some
    // wheels together — rotating those meshes would tumble the whole set
    // like a helicopter rather than spinning each wheel individually.
    if (wheels.length < 4) wheelsAreSeparateMeshes = false;
    // Body/wheel materials are already team-tinted / wheel-blackened by the
    // cache resolver above — no per-instance recolouring needed.
    // Scale the GLB model to match the scene's car dimensions. The model's
    // native size is unknown until loaded, so we normalise it to fit within
    // the CAR_LENGTH × CAR_WIDTH bounding box.
    const bbox = new THREE.Box3().setFromObject(clone);
    const size = bbox.getSize(new THREE.Vector3());
    const scaleX = CAR_LENGTH / Math.max(size.x, 0.01);
    const scaleZ = CAR_WIDTH / Math.max(size.z, 0.01);
    const scale = Math.min(scaleX, scaleZ);
    clone.scale.setScalar(scale);
    // Rotate 180° so the model faces +X (forward). The GLB's default
    // forward is -X, so a Y-axis flip aligns it with the scene convention.
    clone.rotation.y = Math.PI;
    // Recompute bbox after scaling/rotation to centre the model in X/Z and
    // anchor Y to the wheel contact plane.
    clone.updateMatrixWorld(true);
    const bbox2 = new THREE.Box3().setFromObject(clone);
    const center = bbox2.getCenter(new THREE.Vector3());
    clone.position.x -= center.x;
    clone.position.z -= center.z;
    // Anchor the clone so the lowest wheel point sits at local Y=0. This is a
    // geometry-derived contact plane (no magic offsets), so placement on track
    // only needs one global clearance value.
    let contactY = Infinity;
    if (wheels.length > 0) {
      for (const wheel of wheels) {
        const wheelBox = new THREE.Box3().setFromObject(wheel);
        if (wheelBox.min.y < contactY) contactY = wheelBox.min.y;
      }
    }
    if (!Number.isFinite(contactY)) contactY = bbox2.min.y;
    clone.position.y -= contactY;

    g.add(clone);
    g.userData.body = body;
    g.userData.bodyMats = bodyMats;
    g.userData.wheels = wheels;
    g.userData.wheelMats = wheelMats;
    g.userData.wheelsAreSeparateMeshes = wheelsAreSeparateMeshes;
  }).catch(() => {
    // GLB failed — use the primitive fallback.
    const fallback = makeFallbackMarker(team);
    // Move fallback children into the main group (preserve existing indicators).
    while (fallback.children.length > 0) {
      const child = fallback.children[0];
      fallback.remove(child);
      g.add(child);
    }
    // Overwrite userData with fallback's full set.
    g.userData.body = fallback.userData.body;
    g.userData.bodyMats = fallback.userData.bodyMats;
    g.userData.wheels = fallback.userData.wheels;
    g.userData.wheelMats = fallback.userData.wheelMats || [];
    g.userData.wheelsAreSeparateMeshes = true;
  });

  return g;
}


// Safety car marker — yellow GLB model scaled to match F1 car dimensions.
// Uses same placement contract as driver markers (fraction → curve position).
function makeSafetyCarMarker() {
  const SC_COLOR = new THREE.Color(0xffcc00);
  const g = new THREE.Group();
  g.userData = { body: [], bodyMats: [], wheels: [], wheelsAreSeparateMeshes: false };

  // Ground halo in yellow so it's distinct from driver rings.
  const haloGeom = new THREE.RingGeometry(HALO_RADIUS * 0.75, HALO_RADIUS * 1.1, 36);
  haloGeom.rotateX(-Math.PI / 2);
  const haloMat = new THREE.MeshBasicMaterial({
    color: SC_COLOR, transparent: true, opacity: 0.55, depthWrite: false,
  });
  const groundHalo = new THREE.Mesh(haloGeom, haloMat);
  groundHalo.position.y = 0.02;
  g.add(groundHalo);
  g.userData.groundHalo = groundHalo;
  g.userData.haloMat = haloMat;

  loadSafetyCarModel().then((baseModel) => {
    const clone = baseModel.clone();
    // Clone geometry so disposing the active scene doesn't poison cached base.
    clone.traverse((child) => {
      if (child.isMesh && child.geometry) {
        child.geometry = child.geometry.clone();
      }
    });
    const matMap = new Map();
    clone.traverse((child) => {
      if (!child.isMesh) return;
      if (child.material && !matMap.has(child.material)) {
        matMap.set(child.material, child.material.clone());
      }
      child.material = matMap.get(child.material);
    });

    // Safety car (Mercedes AMG GT) is ~4.7 m long in real life — slightly
    // smaller than an F1 car. Use the same scene-unit scale as F1 cars but
    // target SC_LENGTH instead of CAR_LENGTH.
    const SC_LENGTH = CAR_LENGTH * 0.75;
    const SC_WIDTH  = CAR_WIDTH  * 0.75;
    const bbox = new THREE.Box3().setFromObject(clone);
    const size = bbox.getSize(new THREE.Vector3());
    // GLB forward is +Z, so fit against Z axis for length and X for width.
    const scaleZ = SC_LENGTH / Math.max(size.z, 0.01);
    const scaleX = SC_WIDTH  / Math.max(size.x, 0.01);
    clone.scale.setScalar(Math.min(scaleZ, scaleX));
    // Rotate +90° so GLB's +Z forward maps to scene's +X forward.
    clone.rotation.y = Math.PI / 2;

    clone.updateMatrixWorld(true);
    const bbox2 = new THREE.Box3().setFromObject(clone);
    const center = bbox2.getCenter(new THREE.Vector3());
    clone.position.x -= center.x;
    clone.position.z -= center.z;

    // Anchor lowest point to Y=0 (same as driver markers).
    clone.position.y -= bbox2.min.y;

    const body = [];
    const bodyMats = [];
    clone.traverse((child) => {
      if (!child.isMesh) return;
      body.push(child);
      if (child.material && !bodyMats.includes(child.material)) bodyMats.push(child.material);
    });

    g.add(clone);
    g.userData.body = body;
    g.userData.bodyMats = bodyMats;
  }).catch(() => {
    // Fallback: yellow box.
    const mat = new THREE.MeshStandardMaterial({ color: SC_COLOR, roughness: 0.4, metalness: 0.3 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(CAR_LENGTH, 1.4, CAR_WIDTH * 0.8), mat);
    box.position.y = 0.7;
    g.add(box);
    g.userData.body = [box];
    g.userData.bodyMats = [mat];
  });

  return g;
}

function makeLabelLayer(mount) {
  const layer = document.createElement("div");
  Object.assign(layer.style, {
    position: "absolute", inset: "0", pointerEvents: "none",
    fontFamily: "JetBrains Mono, monospace",
  });
  mount.appendChild(layer);
  return layer;
}

function makeLabel(code, teamColor) {
  const el = document.createElement("div");
  const codeEl = document.createElement("span");
  codeEl.textContent = code;
  const statusEl = document.createElement("span");
  statusEl.style.display = "none";
  statusEl.style.padding = "0 4px";
  statusEl.style.borderRadius = "999px";
  statusEl.style.fontSize = "9px";
  statusEl.style.fontWeight = "800";
  statusEl.style.letterSpacing = "0.1em";
  statusEl.style.textTransform = "uppercase";
  el.appendChild(codeEl);
  el.appendChild(statusEl);
  el._codeEl = codeEl;
  el._statusEl = statusEl;
  Object.assign(el.style, {
    position: "absolute",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "10px", fontWeight: "700", letterSpacing: "0.08em",
    color: "#f4f4f8",
    background: "rgba(11,11,17,0.85)",
    border: `1px solid ${teamColor}`,
    padding: "1px 4px",
    transform: "translate(-50%, -130%)",
    whiteSpace: "nowrap",
  });
  return el;
}

function setLabelStatus(label, status, reason) {
  if (!label?._statusEl) return;
  const badge = String(status || "").trim().toUpperCase();
  label.title = reason || label._codeEl?.textContent || "";
  if (!badge) {
    label._statusEl.style.display = "none";
    label._statusEl.textContent = "";
    return;
  }

  label._statusEl.textContent = badge;
  label._statusEl.style.display = "inline-flex";
  label._statusEl.style.alignItems = "center";
  label._statusEl.style.background = "rgba(11,11,17,0.92)";

  if (badge === "DNS") {
    label._statusEl.style.color = "#d7dbe6";
    label._statusEl.style.border = "1px solid rgba(215,219,230,0.24)";
    return;
  }

  label._statusEl.style.color = badge === "ACC" ? "#ffd6d1" : "#ffd9c2";
  label._statusEl.style.border = badge === "ACC"
    ? "1px solid rgba(255,30,0,0.45)"
    : "1px solid rgba(255,122,26,0.4)";
}

// ───────────────────────────────────────────────────────────────────────────
// Atmosphere — sky, grandstand rim, rain.
// ───────────────────────────────────────────────────────────────────────────

// Time-of-day presets. F1 has day, twilight and night races, so we key a
// handful of scene parameters (sky gradient, sun intensity/angle, hemi fill,
// fog, post FX) off the circuit name. Unknown circuits default to "day".
const TOD_PRESETS = {
  day: {
    sceneBg: 0xc8dff0,
    sky: {
      // Richer blue zenith, slightly warmer horizon, and a soft golden glow
      // band so the horizon reads as sun-lit air rather than haze washout.
      // Sun lowered to ~40° elevation so its disc + halo are visible in frame.
      zenith: 0x2e6db5, horizon: 0xb8d4e8, ground: 0x7a8090,
      sunColor: 0xffe8b0, sunDisc: 2.2, hazeTint: 1.0, starStrength: 0.0,
      horizonGlow: 0xffd080, horizonGlowStrength: 0.28, cloudStrength: 0.55,
    },
    sun: { dir: [0.55, 0.65, -0.45], color: 0xfff0cc, intensity: 2.1 },
    hemi: { sky: 0xbcd4ff, ground: 0x6a6d78, intensity: 0.9 },
    fog: { color: 0xbdcedd, densityScale: 0.5 },
    ground: { color: 0x6c9b58 },
    runoff: { color: 0x3a3a42 },
    trackTint: 0xf2f3fa,
    exposure: 0.95,
    bloom: { strength: 0.22, threshold: 0.95, radius: 0.55 },
    vignette: { base: 0.28, tint: 0x0a0b10 },
    kerb: { emissive: 0x000000, emissiveIntensity: 0.0 },
    stadiumLights: null,
  },
  dusk: {
    sceneBg: 0x1a1826,
    sky: {
      zenith: 0x121933, horizon: 0x703845, ground: 0x100f18,
      sunColor: 0xffb889, sunDisc: 3.4, hazeTint: 1.45, starStrength: 0.22,
      horizonGlow: 0xff9a66, horizonGlowStrength: 0.55,
    },
    sun: { dir: [0.45, 0.55, -0.7], color: 0xffc194, intensity: 1.6 },
    hemi: { sky: 0xa39abb, ground: 0x3b2f3a, intensity: 0.55 },
    fog: { color: 0x23202c, densityScale: 0.9 },
    ground: { color: 0x4f6f3f },
    runoff: { color: 0x2a2a31 },
    trackTint: 0xe8eaf2,
    exposure: 0.98,
    bloom: { strength: 0.32, threshold: 0.88, radius: 0.55 },
    vignette: { base: 0.38, tint: 0x07080e },
    kerb: { emissive: 0x0a0000, emissiveIntensity: 0.05 },
    stadiumLights: null,
  },
  night: {
    sceneBg: 0x05060c,
    sky: {
      zenith: 0x04060c, horizon: 0x14182a, ground: 0x04050a,
      sunColor: 0xffd9a8, sunDisc: 0.0, hazeTint: 1.0, starStrength: 1.0,
      // Warm city-glow band along the horizon — what really sells a night
      // stadium race, pushes the black wall away from the viewer.
      horizonGlow: 0xffb070, horizonGlowStrength: 0.4,
    },
    // Under stadium lights → key comes from high overhead, cool white.
    sun: { dir: [0.25, 0.95, -0.15], color: 0xe8ecff, intensity: 1.1 },
    hemi: { sky: 0x2c395a, ground: 0x0a0a10, intensity: 0.4 },
    fog: { color: 0x08090e, densityScale: 1.0 },
    ground: { color: 0x3c5832 },
    runoff: { color: 0x1f1f25 },
    trackTint: 0xd8dbe6,
    exposure: 1.0,
    bloom: { strength: 0.4, threshold: 0.78, radius: 0.6 },
    vignette: { base: 0.4, tint: 0x04050a },
    kerb: { emissive: 0x140000, emissiveIntensity: 0.12 },
    // Stadium light ring: 8 floodlight pylons around the bbox, each a
    // low-intensity cool-white PointLight. Kept cheap — no shadows — since the
    // sun directional already carries the cast-shadow budget.
    stadiumLights: { count: 8, color: 0xf0f4ff, intensity: 0.8, heightFactor: 0.35, radiusFactor: 1.1 },
  },
};

// Weather overlay — mutates the active TOD preset in-place so that "night +
// rain" doesn't need its own preset. Applied once after TOD lookup.
const WET_OVERLAY = {
  // Keep wet mood readable. Avoid near-black fog/terrain collapse in rain.
  fogDensityMult: 1.12,
  fogTint: 0x6f8399,       // lighter cool grey-blue, closer to sky/fog dry palette
  groundDarken: 0.92,      // near-dry so terrain stays visible
  runoffDarken: 0.76,
  trackDarken: 0.74,
  bloomStrengthAdd: 0.1,
  bloomThresholdDrop: 0.08,
};

function mulHex(hex, k) {
  const r = Math.max(0, Math.min(255, Math.round(((hex >> 16) & 0xff) * k)));
  const g = Math.max(0, Math.min(255, Math.round(((hex >> 8) & 0xff) * k)));
  const b = Math.max(0, Math.min(255, Math.round((hex & 0xff) * k)));
  return (r << 16) | (g << 8) | b;
}

function mulHexLumaFloor(hex, k, minLuma = 0) {
  let r = Math.max(0, Math.min(255, Math.round(((hex >> 16) & 0xff) * k)));
  let g = Math.max(0, Math.min(255, Math.round(((hex >> 8) & 0xff) * k)));
  let b = Math.max(0, Math.min(255, Math.round((hex & 0xff) * k)));
  if (minLuma > 0) {
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma <= 1e-3) {
      r = g = b = Math.round(Math.max(0, Math.min(255, minLuma)));
    } else if (luma < minLuma) {
      const s = minLuma / luma;
      r = Math.max(0, Math.min(255, Math.round(r * s)));
      g = Math.max(0, Math.min(255, Math.round(g * s)));
      b = Math.max(0, Math.min(255, Math.round(b * s)));
    }
  }
  return (r << 16) | (g << 8) | b;
}

function detectTimeOfDay(circuitName) {
  const name = (circuitName || "").toLowerCase();
  if (!name) return "day";
  // Known night races (lit by stadium lighting).
  if (/singapore|marina bay|jeddah|saudi|bahrain|sakhir|qatar|lusail|las vegas/.test(name)) {
    return "night";
  }
  // Twilight / late-afternoon races.
  if (/abu dhabi|yas marina/.test(name)) {
    return "dusk";
  }
  return "day";
}

// Procedural sky: zenith → horizon → ground gradient, soft sun disc + glow,
// and sparse procedural stars (strength driven by the time-of-day preset, so
// day races render a clean sky). Full sphere (BackSide) so the chase camera
// can pitch up freely.
function buildSkyDome(radius, sunDir, preset) {
  const geom = new THREE.SphereGeometry(radius, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith:    { value: new THREE.Color(preset.sky.zenith) },
      uHorizon:   { value: new THREE.Color(preset.sky.horizon) },
      uGround:    { value: new THREE.Color(preset.sky.ground) },
      uSunDir:    { value: sunDir.clone().normalize() },
      uSunColor:  { value: new THREE.Color(preset.sky.sunColor) },
      uSunSize:   { value: 0.9985 },
      uSunDisc:   { value: preset.sky.sunDisc },
      uHazeTint:  { value: preset.sky.hazeTint },
      uHorizonGlow: { value: new THREE.Color(preset.sky.horizonGlow || 0x000000) },
      uHorizonGlowStrength: { value: preset.sky.horizonGlowStrength || 0.0 },
      uCloudStrength: { value: preset.sky.cloudStrength ?? 0.0 },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uGround;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uSunSize;
      uniform float uSunDisc;
      uniform float uHazeTint;
      uniform vec3 uHorizonGlow;
      uniform float uHorizonGlowStrength;
      uniform float uCloudStrength;

      // Cheap 2-octave hash-based cloud layer. No textures, no uniforms beyond
      // the strength scalar. Uses the normalised sphere direction so the clouds
      // are fixed in sky-space (they don't swim as the camera moves).
      float hash(vec2 p) {
        p = fract(p * vec2(127.1, 311.7));
        p += dot(p, p + 43.21);
        return fract(p.x * p.y);
      }
      float smoothNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i),           hash(i + vec2(1,0)), u.x),
          mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x),
          u.y
        );
      }
      float clouds(vec3 d) {
        // Project upper hemisphere onto a flat plane then tile.
        if (d.y < 0.04) return 0.0;
        vec2 uv = d.xz / (d.y + 0.15) * 1.4;
        float n = smoothNoise(uv * 2.2) * 0.62
                + smoothNoise(uv * 4.8) * 0.28
                + smoothNoise(uv * 9.5) * 0.10;
        // Threshold so we get puffy breaks rather than a uniform layer.
        float c = smoothstep(0.48, 0.72, n);
        // Fade clouds toward the horizon so they don't slice the gradient.
        float horizonFade = smoothstep(0.04, 0.20, d.y);
        return c * horizonFade;
      }

      void main() {
        vec3 d = normalize(vDir);
        float t = clamp(d.y, -1.0, 1.0);
        // Sky-vertical gradient — tighter smoothstep keeps the deep zenith blue
        // from washing out too quickly toward the horizon.
        vec3 sky = (t > 0.0)
          ? mix(uHorizon, uZenith, smoothstep(0.0, 0.50, t))
          : mix(uHorizon, uGround, smoothstep(0.0, -0.25, t));
        // Haze concentrated at the horizon — reduced multiplier so the gradient
        // survives in the upper sky.
        float haze = exp(-abs(t) * 5.5);
        sky = mix(sky, uHorizon * uHazeTint, haze * 0.28);
        // Horizon glow band.
        float glow = pow(max(0.0, 1.0 - abs(t)), 8.0);
        sky += uHorizonGlow * (glow * uHorizonGlowStrength);
        // Procedural cloud layer (day only via uCloudStrength).
        if (uCloudStrength > 0.001) {
          float c = clouds(d);
          // Lit side of clouds picks up a little sun warmth.
          float sunLit = max(0.0, dot(d, normalize(uSunDir))) * 0.3 + 0.7;
          vec3 cloudColor = mix(vec3(0.82, 0.86, 0.90), vec3(1.0, 0.98, 0.94) * sunLit, 0.5);
          sky = mix(sky, cloudColor, c * uCloudStrength);
        }
        // Sun disc + bloom-friendly glow (disabled at night via uSunDisc=0).
        if (uSunDisc > 0.001) {
          float sd = max(0.0, dot(d, normalize(uSunDir)));
          float disc = smoothstep(uSunSize, uSunSize + 0.0008, sd);
          float halo = pow(sd, 64.0) * 0.40 + pow(sd, 6.0) * 0.08;
          sky += uSunColor * (disc * uSunDisc + halo);
        }
        gl_FragColor = vec4(sky, 1.0);
      }
    `,
  });
  return new THREE.Mesh(geom, mat);
}

// Procedural star field as a Points cloud on the upper hemisphere. Uniform
// spherical distribution (no grid banding), per-point size + brightness
// variation, and per-point twinkle phase animated in the shader. Cheap: ~1500
// points, one draw call, no depth write so it composes cleanly over the sky.
function buildStarField(radius, count = 1500, strength = 1.0) {
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const brightness = new Float32Array(count);
  const phases = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Uniform on the upper hemisphere: reject points with y < 0.05 so stars
    // never render inside the ground plane / below the horizon silhouette.
    let x = 0, y = 0, z = 0;
    do {
      x = Math.random() * 2 - 1;
      y = Math.random() * 2 - 1;
      z = Math.random() * 2 - 1;
      const len = Math.sqrt(x * x + y * y + z * z);
      if (len < 0.01 || len > 1) continue;
      x /= len; y /= len; z /= len;
    } while (y < 0.05);
    positions[i * 3 + 0] = x * radius;
    positions[i * 3 + 1] = y * radius;
    positions[i * 3 + 2] = z * radius;
    // Heavy-tailed size distribution so a handful of stars read as brighter.
    const r = Math.random();
    sizes[i] = 0.6 + r * r * 2.8;
    brightness[i] = 0.35 + Math.random() * 0.65;
    phases[i] = Math.random() * Math.PI * 2;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geom.setAttribute("aBrightness", new THREE.BufferAttribute(brightness, 1));
  geom.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uStrength: { value: strength },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: `
      attribute float aSize;
      attribute float aBrightness;
      attribute float aPhase;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vBrightness;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        // Scale with pixel ratio so stars look consistent across displays.
        gl_PointSize = aSize * uPixelRatio;
        // Twinkle: per-point phase + a slow global modulation.
        float tw = 0.75 + 0.25 * sin(uTime * 1.3 + aPhase);
        vBrightness = aBrightness * tw;
      }
    `,
    fragmentShader: `
      uniform float uStrength;
      varying float vBrightness;
      void main() {
        // Round soft point with a tight core + gentle halo.
        vec2 uv = gl_PointCoord - 0.5;
        float r2 = dot(uv, uv);
        if (r2 > 0.25) discard;
        float core = smoothstep(0.25, 0.0, r2);
        float halo = smoothstep(0.25, 0.05, r2) * 0.35;
        float a = (core + halo) * vBrightness * uStrength;
        gl_FragColor = vec4(vec3(0.92, 0.95, 1.0) * a, a);
      }
    `,
  });
  const pts = new THREE.Points(geom, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -1;
  return pts;
}

// Stadium floodlight ring for night races. A ring of PointLights around the
// bbox perimeter plus matching emissive pylon cap meshes so the bloom pass
// has obvious bright dots to smear. Shadowless — the sun directional carries
// the shadow budget.
function buildStadiumLights(center, extent, yBase, config) {
  const g = new THREE.Group();
  const lights = [];
  const height = extent * config.heightFactor;
  const radius = extent * config.radiusFactor;
  // Pylons + caps batched into one InstancedMesh each so the whole ring is
  // 2 draw calls (plus the PointLights, which can't be instanced).
  const pylonGeom = new THREE.BoxGeometry(4, height, 4);
  const pylonMat = new THREE.MeshBasicMaterial({ color: 0x181a20 });
  const pylonInst = new THREE.InstancedMesh(pylonGeom, pylonMat, config.count);
  const capGeom = new THREE.BoxGeometry(18, 3, 6);
  const capMat = new THREE.MeshBasicMaterial({ color: 0xf4f7ff, toneMapped: false });
  const capInst = new THREE.InstancedMesh(capGeom, capMat, config.count);
  const dummy = new THREE.Object3D();
  const lightRange = extent * 1.4;
  for (let i = 0; i < config.count; i++) {
    const a = (i / config.count) * Math.PI * 2 + 0.15;
    const px = center.x + Math.cos(a) * radius;
    const pz = center.z + Math.sin(a) * radius;
    // Pylon: vertical box at the perimeter.
    dummy.position.set(px, yBase + height * 0.5, pz);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    pylonInst.setMatrixAt(i, dummy.matrix);
    // Cap: oriented to face the centre.
    const capPos = new THREE.Vector3(px, yBase + height, pz);
    dummy.position.copy(capPos);
    dummy.lookAt(center.x, yBase + height, center.z);
    dummy.updateMatrix();
    capInst.setMatrixAt(i, dummy.matrix);
    const pl = new THREE.PointLight(config.color, config.intensity, lightRange, 1.6);
    pl.position.set(px, yBase + height * 0.95, pz);
    g.add(pl);
    lights.push(pl);
  }
  pylonInst.instanceMatrix.needsUpdate = true;
  capInst.instanceMatrix.needsUpdate = true;
  g.add(pylonInst);
  g.add(capInst);
  g.userData.lights = lights;
  return g;
}

// Rolling-hills horizon silhouette built as a single radial fan: smoother and
// reads better through fog than a wall of cubes. Two layered rings — closer
// hills slightly warmer/lighter, distant ones nearly the sky tone for depth.
function buildHorizonHills(center, extent, yBase) {
  const g = new THREE.Group();
  const layers = [
    { radius: extent * 1.4,  hMin: 14, hMax: 70,  color: 0x141520, segs: 192 },
    { radius: extent * 2.6,  hMin: 28, hMax: 120, color: 0x0f1018, segs: 144 },
    { radius: extent * 4.2,  hMin: 60, hMax: 200, color: 0x0a0b13, segs: 96  },
  ];
  for (const L of layers) {
    const N = L.segs;
    // (N+1) outer ring verts + 1 center vert; we still build it as a flat ring
    // anchored at yBase, so the inner edge sits on the ground.
    const outer = new Float32Array((N + 1) * 3);
    const inner = new Float32Array((N + 1) * 3);
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      // Two-octave sin-noise for a soft hilly profile.
      const n = 0.5 + 0.5 * Math.sin(a * 3.7 + L.radius * 0.001)
                * Math.cos(a * 1.9 + L.radius * 0.0017);
      const n2 = 0.5 + 0.5 * Math.sin(a * 11.3) * 0.6;
      const h = L.hMin + (L.hMax - L.hMin) * (n * 0.7 + n2 * 0.3);
      const cosA = Math.cos(a), sinA = Math.sin(a);
      // inner vertex at yBase
      inner[i * 3 + 0] = center.x + cosA * L.radius;
      inner[i * 3 + 1] = yBase;
      inner[i * 3 + 2] = center.z + sinA * L.radius;
      // outer (top) vertex pushed up by `h`
      outer[i * 3 + 0] = center.x + cosA * L.radius;
      outer[i * 3 + 1] = yBase + h;
      outer[i * 3 + 2] = center.z + sinA * L.radius;
    }
    const positions = new Float32Array((N + 1) * 6);
    positions.set(inner, 0);
    positions.set(outer, (N + 1) * 3);
    const indices = [];
    for (let i = 0; i < N; i++) {
      const a = i, b = i + 1, c = (N + 1) + i, d = (N + 1) + i + 1;
      indices.push(a, c, b, b, c, d);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color: L.color, fog: true });
    g.add(new THREE.Mesh(geom, mat));
  }
  return g;
}

// Closer-in grandstand silhouette: low boxes scattered on the inner ring.
// Only ~24 of them so they read as accents, not a fence.
//
// Single InstancedMesh: 22 boxes batched into one draw call instead of 22.
// Per-instance matrix carries position/rotation/scale; per-instance colour
// gives the accent mix without unique materials.
function buildGrandstands(center, extent, yBase) {
  const radius = extent * 1.15;
  const count = 22;
  const baseColor = new THREE.Color(0x1c1d28);
  const accentColor = new THREE.Color(0x322438);
  // Unit box; each instance scales it to (w, h, d).
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const inst = new THREE.InstancedMesh(geom, mat, count);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.1;
    const r = radius * (0.92 + Math.random() * 0.18);
    const h = 8 + Math.random() * 14;
    const w = 50 + Math.random() * 90;
    const d = 22 + Math.random() * 30;
    dummy.position.set(
      center.x + Math.cos(a) * r,
      yBase + h * 0.5,
      center.z + Math.sin(a) * r,
    );
    dummy.rotation.set(0, -a + Math.PI * 0.5 + (Math.random() - 0.5) * 0.4, 0);
    dummy.scale.set(w, h, d);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
    inst.setColorAt(i, Math.random() > 0.7 ? accentColor : baseColor);
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  return inst;
}

const TRACKSIDE_WORLD_UP = new THREE.Vector3(0, 1, 0);
const TRACKSIDE_SIGN_TEX_CACHE = new Map();

function sampleTrackFrameAt(curve, u, point, tangent, right, up) {
  curve.getPointAt(u, point);
  curve.getTangentAt(u, tangent).normalize();
  right.crossVectors(tangent, TRACKSIDE_WORLD_UP);
  const len2 = right.lengthSq();
  if (len2 < 1e-10) right.set(1, 0, 0);
  else right.multiplyScalar(1 / Math.sqrt(len2));
  up.crossVectors(right, tangent).normalize();
  if (up.y < 0) {
    right.multiplyScalar(-1);
    up.multiplyScalar(-1);
  }
}

function getTracksideSignTexture(label, {
  bg = "#F4F4F6",
  fg = "#11131A",
  border = "#11131A",
  accent = null,
} = {}) {
  const key = `${label}|${bg}|${fg}|${border}|${accent || ""}`;
  if (TRACKSIDE_SIGN_TEX_CACHE.has(key)) return TRACKSIDE_SIGN_TEX_CACHE.get(key);

  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 160;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (accent) {
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, canvas.width, 20);
  }
  ctx.strokeStyle = border;
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
  ctx.fillStyle = fg;
  ctx.font = `900 ${accent ? 78 : 92}px "Arial Black", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, canvas.width * 0.5, canvas.height * (accent ? 0.58 : 0.54));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  TRACKSIDE_SIGN_TEX_CACHE.set(key, tex);
  return tex;
}

function makeTracksidePlacard(label, {
  width = 2.2,
  height = 1.5,
  postHeight = 2.8,
  postColor = 0x676d79,
  bg = "#F4F4F6",
  fg = "#11131A",
  border = "#11131A",
  accent = null,
} = {}) {
  const g = new THREE.Group();
  const postMat = new THREE.MeshStandardMaterial({
    color: postColor,
    roughness: 0.82,
    metalness: 0.12,
  });
  const postGeom = new THREE.BoxGeometry(0.12, postHeight, 0.12);
  const leftPost = new THREE.Mesh(postGeom, postMat);
  const rightPost = new THREE.Mesh(postGeom, postMat);
  const postSpread = width * 0.28;
  leftPost.position.set(-postSpread, postHeight * 0.5, 0);
  rightPost.position.set(postSpread, postHeight * 0.5, 0);
  g.add(leftPost);
  g.add(rightPost);

  const back = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, 0.08),
    new THREE.MeshStandardMaterial({
      color: 0x10141c,
      roughness: 0.78,
      metalness: 0.08,
    }),
  );
  back.position.set(0, postHeight - height * 0.2, 0);
  g.add(back);

  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.92, height * 0.86),
    new THREE.MeshBasicMaterial({
      map: getTracksideSignTexture(label, { bg, fg, border, accent }),
      transparent: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  face.position.set(0, back.position.y, 0.045);
  g.add(face);
  g.userData.face = face;
  return g;
}

function makeMarshalPanel(color) {
  const g = new THREE.Group();
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x5f6571,
    roughness: 0.82,
    metalness: 0.1,
  });
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.11, 2.4, 0.11), postMat);
  post.position.y = 1.2;
  g.add(post);

  const box = new THREE.Mesh(
    new THREE.BoxGeometry(1.25, 0.8, 0.18),
    new THREE.MeshStandardMaterial({
      color: 0x0d1118,
      roughness: 0.72,
      metalness: 0.12,
    }),
  );
  box.position.set(0, 2.2, 0);
  g.add(box);

  const lamp = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.26),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  );
  lamp.position.set(0, 2.2, 0.1);
  g.add(lamp);
  return g;
}

function buildTerrainGeometry(curve, center, extent, floorY) {
  const size = extent * 6;
  const segs = Math.max(56, Math.min(112, Math.round(extent / 18)));
  const geom = new THREE.PlaneGeometry(size, size, segs, segs);
  geom.rotateX(-Math.PI / 2);

  const sampleSegs = Math.max(180, Math.min(480, Math.round(extent * 0.16)));
  const frames = sampleCurveFrames(curve, sampleSegs);
  const fp = frames.points;
  const count = frames.count;
  const influenceRadius = Math.max(90, extent * 0.24);
  const pos = geom.attributes.position;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const worldX = center.x + x;
    const worldZ = center.z + z;

    let bestD2 = Infinity;
    let nearestY = floorY;
    for (let j = 0; j < count; j++) {
      const dx = worldX - fp[j * 3 + 0];
      const dz = worldZ - fp[j * 3 + 2];
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        nearestY = fp[j * 3 + 1];
      }
    }

    const dist = Math.sqrt(bestD2);
    const radial = Math.min(1, Math.hypot(x, z) / (size * 0.5));
    const base = floorY - radial * radial * 10;
    const nearTrack = nearestY - 1.35 - Math.min(8, dist * 0.08);
    const t = Math.max(0, Math.min(1, 1 - dist / influenceRadius));
    const blend = t * t * (3 - 2 * t);
    const undulation =
      (Math.sin(worldX * 0.0055 + worldZ * 0.003) * 0.45 +
       Math.sin(worldZ * 0.0085 - worldX * 0.004) * 0.28) * (0.25 + radial * 0.75);
    pos.setY(i, base * (1 - blend) + nearTrack * blend + undulation);
  }

  geom.computeVertexNormals();
  return geom;
}

function buildRain(bbox) {
  const COUNT = 3000;
  const positions = new Float32Array(COUNT * 3);
  const velocities = new Float32Array(COUNT * 3);
  const spanX = bbox.sx * 1.4, spanZ = bbox.sz * 1.4;
  const ceiling = Math.max(120, bbox.sy + 80);
  for (let i = 0; i < COUNT; i++) {
    positions[i * 3 + 0] = bbox.cx + (Math.random() - 0.5) * spanX;
    positions[i * 3 + 1] = bbox.cy + Math.random() * ceiling + 20;
    positions[i * 3 + 2] = bbox.cz + (Math.random() - 0.5) * spanZ;
    velocities[i * 3 + 0] = 0;
    velocities[i * 3 + 1] = -(60 + Math.random() * 40);
    velocities[i * 3 + 2] = 0;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xb8cfe4, size: 0.9, transparent: true, opacity: 0.7,
    depthWrite: false,
  });
  const pts = new THREE.Points(geom, mat);
  pts.userData = { velocities, bbox, count: COUNT, ceiling };
  pts.visible = false;
  return pts;
}

function advanceRain(rain, dt, windVec) {
  if (!rain.visible) return;
  const positions = rain.geometry.attributes.position.array;
  const vels = rain.userData.velocities;
  const bbox = rain.userData.bbox;
  const ceiling = rain.userData.ceiling;
  const spanX = bbox.sx * 1.4, spanZ = bbox.sz * 1.4;
  for (let i = 0; i < rain.userData.count; i++) {
    positions[i * 3 + 0] += (vels[i * 3 + 0] + windVec.x) * dt;
    positions[i * 3 + 1] += vels[i * 3 + 1] * dt;
    positions[i * 3 + 2] += (vels[i * 3 + 2] + windVec.z) * dt;
    if (positions[i * 3 + 1] < bbox.cy - 5) {
      positions[i * 3 + 0] = bbox.cx + (Math.random() - 0.5) * spanX;
      positions[i * 3 + 1] = bbox.cy + ceiling * 0.9 + Math.random() * 40;
      positions[i * 3 + 2] = bbox.cz + (Math.random() - 0.5) * spanZ;
    }
  }
  rain.geometry.attributes.position.needsUpdate = true;
}

// ───────────────────────────────────────────────────────────────────────────
// POV HUD — shown only when cameraMode === "follow". Displays speed, gear,
// throttle/brake bars, DRS and compound for the pinned driver.
// ───────────────────────────────────────────────────────────────────────────

function buildPovHud(mount) {
  let hidden = false;

  // Tiny pill shown when HUD is hidden — click to restore.
  const pill = document.createElement("div");
  Object.assign(pill.style, {
    position: "absolute", right: "12px", bottom: "44px",
    display: "none",
    fontFamily: "JetBrains Mono, monospace",
    fontSize: "9px", fontWeight: 800, letterSpacing: "0.18em",
    color: "rgba(180,180,200,0.7)",
    padding: "4px 10px",
    background: "linear-gradient(135deg, rgba(11,11,17,0.6) 0%, rgba(20,22,34,0.5) 50%, rgba(11,11,17,0.6) 100%)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderTopColor: "rgba(255,255,255,0.12)",
    borderRadius: "4px",
    backdropFilter: "blur(12px) saturate(1.4)",
    WebkitBackdropFilter: "blur(12px) saturate(1.4)",
    boxShadow: "0 2px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.06)",
    cursor: "pointer", pointerEvents: "auto",
    zIndex: 4, userSelect: "none",
  });
  pill.textContent = "SHOW HUD [H]";
  pill.addEventListener("click", () => { hidden = false; syncVisibility(); });
  mount.appendChild(pill);

  const root = document.createElement("div");
  Object.assign(root.style, {
    position: "absolute", left: "50%", bottom: "54px",
    transform: "translateX(-50%)",
    display: "none",
    fontFamily: "JetBrains Mono, monospace",
    color: "#f4f4f8",
    padding: "10px 16px",
    background: "linear-gradient(135deg, rgba(11,11,17,0.65) 0%, rgba(20,22,34,0.55) 50%, rgba(11,11,17,0.65) 100%)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderTopColor: "rgba(255,255,255,0.12)",
    borderRadius: "8px",
    backdropFilter: "blur(16px) saturate(1.4)",
    WebkitBackdropFilter: "blur(16px) saturate(1.4)",
    boxShadow: "0 4px 20px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06), 0 0 0 1px rgba(255,30,0,0.2)",
    pointerEvents: "none",
    zIndex: 4,
    minWidth: "360px",
    textAlign: "center",
  });
  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;gap:18px;">
      <div style="text-align:left;">
        <div style="font-size:9px;color:rgba(180,180,200,0.55);letter-spacing:0.18em;">CODE</div>
        <div data-hud="code" style="font-size:18px;font-weight:800;letter-spacing:0.04em;">—</div>
      </div>
      <div>
        <div style="font-size:9px;color:rgba(180,180,200,0.55);letter-spacing:0.18em;">SPEED</div>
        <div style="display:flex;align-items:baseline;gap:6px;justify-content:center;">
          <div data-hud="speed" style="font-size:30px;font-weight:800;font-variant-numeric:tabular-nums;">000</div>
          <div style="font-size:10px;color:rgba(180,180,200,0.6);letter-spacing:0.14em;">KPH</div>
        </div>
      </div>
      <div>
        <div style="font-size:9px;color:rgba(180,180,200,0.55);letter-spacing:0.18em;">GEAR</div>
        <div data-hud="gear" style="font-size:30px;font-weight:800;color:#ff1e00;font-variant-numeric:tabular-nums;">—</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;min-width:120px;">
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="font-size:8px;color:rgba(180,180,200,0.55);letter-spacing:0.18em;width:24px;">THR</div>
          <div style="height:6px;background:rgba(255,255,255,0.08);flex:1;">
            <div data-hud="thr" style="height:100%;background:#1eff6a;width:0%;transition:width 60ms linear;"></div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="font-size:8px;color:rgba(180,180,200,0.55);letter-spacing:0.18em;width:24px;">BRK</div>
          <div style="height:6px;background:rgba(255,255,255,0.08);flex:1;">
            <div data-hud="brk" style="height:100%;background:#ff1e00;width:0%;transition:width 60ms linear;"></div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="font-size:8px;color:rgba(180,180,200,0.55);letter-spacing:0.18em;width:24px;">RPM</div>
          <div style="height:6px;background:rgba(255,255,255,0.08);flex:1;">
            <div data-hud="rpm" style="height:100%;background:linear-gradient(90deg,#1eff6a 0%,#ffb400 60%,#ff1e00 100%);width:0%;transition:width 60ms linear;"></div>
          </div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
        <div data-hud="drs" style="
          font-size:10px;font-weight:800;letter-spacing:0.18em;
          padding:2px 7px;
          background:rgba(0,217,255,0.08);
          color:rgba(0,217,255,0.35);
          border:1px solid rgba(0,217,255,0.2);
        ">DRS</div>
        <div data-hud="tyre" style="
          font-size:10px;font-weight:800;letter-spacing:0.18em;
          padding:2px 7px;
          background:rgba(255,217,58,0.1);
          color:#ffd93a;
          border:1px solid rgba(255,217,58,0.3);
        ">—</div>
      </div>
      <div data-hud="hide" style="
        font-size:8px;font-weight:700;letter-spacing:0.14em;
        padding:2px 6px;
        color:rgba(180,180,200,0.4);
        border:1px solid rgba(255,255,255,0.06);
        border-radius:3px;
        cursor:pointer;
        pointer-events:auto;
        user-select:none;
      " title="Hide HUD [H]">HIDE</div>
    </div>
  `;
  mount.appendChild(root);

  // Toggle logic
  const syncVisibility = () => {
    if (hidden) {
      root.style.display = "none";
      pill.style.display = "block";
    } else {
      root.style.display = "block";
      pill.style.display = "none";
    }
  };
  const hideBtn = root.querySelector("[data-hud=hide]");
  if (hideBtn) hideBtn.addEventListener("click", () => { hidden = true; syncVisibility(); });

  const q = (sel) => root.querySelector(sel);
  return {
    root,
    pill,
    code: q("[data-hud=code]"),
    speed: q("[data-hud=speed]"),
    gear: q("[data-hud=gear]"),
    thr: q("[data-hud=thr]"),
    brk: q("[data-hud=brk]"),
    rpm: q("[data-hud=rpm]"),
    drs: q("[data-hud=drs]"),
    tyre: q("[data-hud=tyre]"),
    isHidden: () => hidden,
    toggle: () => { hidden = !hidden; syncVisibility(); },
    show: () => { hidden = false; syncVisibility(); },
    hide: () => { hidden = true; syncVisibility(); },
  };
}

function updatePovHud(hud, standing, compoundInfo) {
  if (!standing) { hud.root.style.display = "none"; hud.pill.style.display = "none"; return; }
  if (hud.isHidden()) { hud.root.style.display = "none"; hud.pill.style.display = "block"; return; }
  hud.root.style.display = "block";
  hud.pill.style.display = "none";
  hud.code.textContent = standing.driver.code;
  hud.speed.textContent = String(Math.round(standing.speedKph || 0)).padStart(3, "0");
  // Read telemetry directly off the (enriched) standing object — it preserves
  // the raw frame fields, so we skip an extra `.find()` per frame.
  const gear = standing.gear ?? null;
  const throttlePct = standing.throttle_pct ?? 0;
  const brakePct = standing.brake_pct ?? 0;
  const rpm = standing.rpm ?? 0;
  const drsOn = !!standing.in_drs;
  hud.gear.textContent = standing.status === "PIT" ? "P" : (gear == null ? "—" : String(gear));
  hud.thr.style.width = `${Math.max(0, Math.min(100, throttlePct))}%`;
  hud.brk.style.width = `${Math.max(0, Math.min(100, brakePct))}%`;
  if (hud.rpm) {
    const rpmNorm = Math.max(0, Math.min(100, (rpm - 4000) / 110));
    hud.rpm.style.width = `${rpmNorm}%`;
  }
  hud.drs.style.background = drsOn ? "rgba(0,217,255,0.3)" : "rgba(0,217,255,0.08)";
  hud.drs.style.color = drsOn ? "#00d9ff" : "rgba(0,217,255,0.35)";
  hud.drs.style.borderColor = drsOn ? "#00d9ff" : "rgba(0,217,255,0.2)";
  if (compoundInfo) {
    hud.tyre.textContent = `${compoundInfo.label} · ${standing.tyreAge}L`;
    hud.tyre.style.background = `${compoundInfo.color}22`;
    hud.tyre.style.color = compoundInfo.color;
    hud.tyre.style.borderColor = `${compoundInfo.color}66`;
  }
}


// ───────────────────────────────────────────────────────────────────────────
// Main component.
// ───────────────────────────────────────────────────────────────────────────

function Track3D({
  standings,
  pinned,
  secondary,
  onPickDriver,
  showLabels = true,
  cameraMode = "orbit",
  weather = null,
  circuitName = "",
  safetyCar = null,
}) {
  const mountRef = React.useRef(null);
  const hudToggleRef = React.useRef(null);
  const liveRef = React.useRef({ standings, pinned, secondary, cameraMode, weather, showLabels, safetyCar });
  liveRef.current = { standings, pinned, secondary, cameraMode, weather, showLabels, safetyCar };
  // Expose HUD toggle on window so the hotkey handler can reach it.
  React.useEffect(() => {
    window.APEX_HUD_TOGGLE = hudToggleRef;
    return () => { delete window.APEX_HUD_TOGGLE; };
  }, []);
  // Rebuild scene when the circuit changes (TOD preset is baked at setup).
  const todKey = detectTimeOfDay(circuitName);

  const [geoVersion, setGeoVersion] = React.useState(() => window.APEX?.geometryVersion || 0);
  React.useEffect(() => {
    const onGeometryVersion = (e) => {
      setGeoVersion(e.detail?.version ?? (window.APEX?.geometryVersion || 0));
    };
    window.addEventListener("apex:geometry-version", onGeometryVersion);
    return () => window.removeEventListener("apex:geometry-version", onGeometryVersion);
  }, []);

  const [qualityVersion, setQualityVersion] = React.useState(0);
  React.useEffect(() => {
    if (!window.APEX.QUALITY) window.APEX.QUALITY = "high";
    window.APEX.setQuality = (name) => {
      if (!QUALITY_PRESETS[name]) return;
      window.APEX.QUALITY = name;
      setQualityVersion((v) => v + 1);
    };
    return () => { delete window.APEX.setQuality; };
  }, []);

  React.useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const circuit = window.APEX.CIRCUIT;
    if (circuit.length < 2) return;

    // --- Quality preset ---
    const qp = QUALITY_PRESETS[window.APEX.QUALITY] || QUALITY_PRESETS.high;

    // --- Scene + lights ---
    const preset = TOD_PRESETS[todKey] || TOD_PRESETS.day;
    const search = new URLSearchParams(window.location.search);
    const debugLayerColors = search.get("trackDebug") === "1";
    const disableToneMapping = search.get("trackToneMap") === "off";
    const showTrackHelpers = search.get("trackHelpers") === "1";
    const groundBaseColor = debugLayerColors ? 0x00ff00 : preset.ground.color;
    const groundWetColor = debugLayerColors ? groundBaseColor : mulHexLumaFloor(preset.ground.color, WET_OVERLAY.groundDarken, 76);
    const runoffDryColor = debugLayerColors ? 0x0060ff : preset.runoff.color;
    const runoffWetColor = debugLayerColors ? runoffDryColor : mulHexLumaFloor(preset.runoff.color, WET_OVERLAY.runoffDarken, 56);
    const vergeDryColor = 0x2d7a3a;
    const vergeWetColor = debugLayerColors ? vergeDryColor : mulHexLumaFloor(vergeDryColor, WET_OVERLAY.groundDarken, 76);
    const trackDryColor = debugLayerColors ? 0xff00ff : preset.trackTint;
    const trackWetColor = debugLayerColors ? trackDryColor : mulHex(preset.trackTint, WET_OVERLAY.trackDarken);
    const fogDryColor = preset.fog.color;
    const fogWetColor = WET_OVERLAY.fogTint;
    const scene = new THREE.Scene();
    // Match background to the sky horizon so any gap (first frame, skydome
    // miss) blends seamlessly rather than flashing a different tone.
    scene.background = new THREE.Color(preset.sky.horizon);

    // Hemisphere fills shadowed undersides with a cool sky tint vs warm
    // ground bounce. Sun is the key light (shadow-caster, configured below
    // once we know the bbox).
    const hemi = new THREE.HemisphereLight(preset.hemi.sky, preset.hemi.ground, preset.hemi.intensity);
    scene.add(hemi);
    // Sun direction reused by the skydome so the on-sky disc and cast shadows
    // agree. Angle/colour driven by the time-of-day preset.
    const sunDir = new THREE.Vector3(
      preset.sun.dir[0], preset.sun.dir[1], preset.sun.dir[2],
    ).normalize();
    const sun = new THREE.DirectionalLight(preset.sun.color, preset.sun.intensity);
    scene.add(sun);
    scene.add(sun.target);

    // --- Curve ---
    const scale = detectUnitScale(circuit);
    let zMin = Infinity;
    for (const p of circuit) {
      const z = Number(p?.z ?? 0);
      if (Number.isFinite(z) && z < zMin) zMin = z;
    }
    if (!Number.isFinite(zMin)) zMin = 0;
    const curve = buildCenterlineCurve(circuit, zMin * scale, scale);
    const segments = Math.min(2000, Math.max(400, circuit.length * 2));

    const bb = new THREE.Box3();
    const samplePts = curve.getPoints(segments);
    for (const p of samplePts) bb.expandByPoint(p);
    const center = bb.getCenter(new THREE.Vector3());
    const size = bb.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.z, 100);
    const curveLength = curve.getLength();
    const bboxInfo = {
      cx: center.x, cy: center.y, cz: center.z,
      sx: Math.max(size.x, 300), sy: Math.max(size.y, 20), sz: Math.max(size.z, 300),
    };

    scene.fog = new THREE.FogExp2(preset.fog.color, preset.fog.densityScale / extent);

    // Sun position: place it relative to the bbox so DirectionalLight's
    // shadow frustum has something to anchor to. Fold the sun down toward the
    // horizon for golden-hour rim light on the cars.
    const sunDistance = extent * 2.0;
    sun.position.set(
      center.x + sunDir.x * sunDistance,
      bb.min.y + sunDir.y * sunDistance,
      center.z + sunDir.z * sunDistance,
    );
    sun.target.position.copy(center);
    // Shadows are off because no mesh in the scene has `castShadow = true` —
    // the cars deliberately disable casting (the directional shadow map
    // produced black spike artefacts at wide zoom levels). Keeping the shadow
    // pass enabled would still render an empty depth map every frame at
    // qp.shadowSize², which is pure waste. Re-enable here if you ever start
    // casting from the cars or trackside objects.
    sun.castShadow = false;

    const sky = buildSkyDome(extent * 4, sunDir, preset);
    sky.position.copy(center);
    scene.add(sky);

    // Star field — uniform Points cloud on the upper hemisphere, only built
    // when the active preset calls for stars. Sits just inside the skydome.
    let stars = null;
    if (preset.sky.starStrength > 0.01) {
      stars = buildStarField(extent * 3.8, 1800, preset.sky.starStrength);
      stars.position.copy(center);
      scene.add(stars);
    }

    // Layered horizon: rolling hills in the distance, scattered grandstand
    // accents close in. Both sit just below the lowest curve point so the
    // track always reads as on top of the terrain.
    const standsY = bb.min.y - 0.4;
    scene.add(buildHorizonHills(center, extent, standsY));
    scene.add(buildGrandstands(center, extent, standsY));

    // Stadium lights ring (night only) — 8 floodlight pylons around the bbox.
    if (preset.stadiumLights) {
      scene.add(buildStadiumLights(center, extent, standsY, preset.stadiumLights));
    }

    // Terrain mesh — broad undulating field around the circuit. A flat plane
    // made elevated tracks read like a ribbon floating over a table, so the
    // terrain now follows the circuit's height envelope and falls away from it.
    const grassTex = cachedTex("grass", makeGrassTexture);
    grassTex.repeat.set((extent * 6) / 120, (extent * 6) / 120);
    const groundGeom = buildTerrainGeometry(curve, center, extent, bb.min.y - 1.6);
    const groundMat = new THREE.MeshLambertMaterial({
      color: groundBaseColor, map: grassTex,
      polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4,
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.position.set(center.x, 0, center.z);
    ground.receiveShadow = false;
    scene.add(ground);

    // Runoff band — TWO parallel strips outside the track/kerbs, NOT a full
    // ribbon under the track. The previous version was a single wide ribbon
    // spanning ±RUNOFF_WIDTH that physically overlapped the track strip
    // (±TRACK_WIDTH). At grazing camera angles the 30 cm yLift gap + polygon
    // offset weren't enough to stop z-fighting, and the runoff would win for
    // the central strip — making the track look translucent / missing its
    // material. Two parallel strips outside the kerbs eliminate the overlap
    // entirely: each side spans from kerb-outer to runoff-outer.
    const GRASS_STRIP_WIDTH = 7.5;
    const VERGE_INNER = TRACK_WIDTH + KERB_WIDTH;
    const VERGE_CENTER = VERGE_INNER + GRASS_STRIP_WIDTH * 0.5;
    const vergeTex = cachedTex("grass", makeGrassTexture);
    vergeTex.repeat.set(1, 90);
    const vergeMat = new THREE.MeshBasicMaterial({
      color: vergeDryColor, map: vergeTex, toneMapped: false,
    });
    const vergeL = new THREE.Mesh(
      buildEdgeLineGeometry(curve, segments, -VERGE_CENTER, GRASS_STRIP_WIDTH, 0.06, 90),
      vergeMat,
    );
    const vergeR = new THREE.Mesh(
      buildEdgeLineGeometry(curve, segments, +VERGE_CENTER, GRASS_STRIP_WIDTH, 0.06, 90),
      vergeMat,
    );
    vergeL.receiveShadow = false; vergeR.receiveShadow = false;
    vergeL.renderOrder = 1; vergeR.renderOrder = 1;
    scene.add(vergeL); scene.add(vergeR);

    const RUNOFF_INNER = VERGE_INNER + GRASS_STRIP_WIDTH;
    const RUNOFF_STRIP_WIDTH = RUNOFF_WIDTH - RUNOFF_INNER;
    const RUNOFF_STRIP_CENTER = RUNOFF_INNER + RUNOFF_STRIP_WIDTH * 0.5;
    const runoffTex = cachedTex("runoff", makeRunoffAsphaltTexture);
    runoffTex.repeat.set(2, 80);
    const runoffMat = new THREE.MeshBasicMaterial({
      color: runoffDryColor, map: runoffTex, toneMapped: false,
    });
    const runoffL = new THREE.Mesh(
      buildEdgeLineGeometry(curve, segments, -RUNOFF_STRIP_CENTER, RUNOFF_STRIP_WIDTH, 0.05, 80),
      runoffMat,
    );
    const runoffR = new THREE.Mesh(
      buildEdgeLineGeometry(curve, segments, +RUNOFF_STRIP_CENTER, RUNOFF_STRIP_WIDTH, 0.05, 80),
      runoffMat,
    );
    runoffL.receiveShadow = false; runoffR.receiveShadow = false;
    runoffL.renderOrder = 1; runoffR.renderOrder = 1;
    scene.add(runoffL); scene.add(runoffR);

    // Main track surface — an extruded box rather than a flat ribbon. The
    // previous flat ribbon kept reading as grey/transparent because:
    //  (1) at wide orbit distances the 512² asphalt texture mipmap-averaged
    //      the dark base + scattered chips into a mid-grey tone
    //      indistinguishable from the concrete ground, and
    //  (2) ACES tonemap applied by OutputPass compressed near-black albedo
    //      upward, further closing the gap with the neutral-grey ground.
    // Extruding to a 0.45 m thick slab with a solid (un-textured) dark
    // charcoal albedo fixes both: no mipmap averaging, no chance of the
    // track collapsing onto a near-identical lit value as the ground, and
    // physical thickness that makes z-fighting with the runoff / ground
    // impossible at any camera angle. The side walls catch a sliver of
    // rim-light that reads as a tar "kerb" even from high orbit.
    const TRACK_BASE_Y = 0.4;
    const TRACK_THICKNESS = 0.45;
    const TRACK_TOP_Y = TRACK_BASE_Y + TRACK_THICKNESS;
    const curveLenApprox = extent * Math.PI;
    const trackUv = Math.max(60, curveLenApprox / 40);
    const asphaltTex = cachedTex("asphalt", makeAsphaltTexture);
    asphaltTex.repeat.set(1, trackUv);
    const asphaltNormal = cachedTex("asphaltNormal", makeAsphaltNormalMap);
    asphaltNormal.wrapS = asphaltNormal.wrapT = THREE.RepeatWrapping;
    asphaltNormal.repeat.set(1, trackUv);
    const trackGeom = buildExtrudedRibbonGeometry(
      curve, segments, TRACK_WIDTH, TRACK_BASE_Y, TRACK_THICKNESS, trackUv,
    );
    // PBR track surface: dark charcoal albedo + procedural normal map so the
    // sun direction rakes across the asphalt and IBL gives a faint sheen.
    // Earlier this was MeshBasicMaterial because mip-averaging at distance
    // collapsed the lit colour toward the ground concrete; a low
    // envMapIntensity plus high roughness keeps the surface readable as tar
    // under ACES tonemap while still picking up directional light cues that
    // were lost on the unlit material.
    const trackMat = new THREE.MeshStandardMaterial({
      color: trackDryColor,
      map: asphaltTex,
      normalMap: asphaltNormal,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.88,
      metalness: 0.0,
      envMapIntensity: 0.35,
    });
    const track = new THREE.Mesh(trackGeom, trackMat);
    track.renderOrder = 2;
    scene.add(track);

    // Everything that was previously layered via tiny Y offsets on a flat
    // ribbon now has to live on the top face of the extruded track slab.
    // `ABOVE_TRACK` lifts a mesh whose helper builds vertices at `p.y +
    // builtinOffset` up to `p.y + TRACK_TOP_Y + clearance`. We pass the
    // helper's builtin Y offset as `base` so the final vertex Y is
    // independent of whatever the helper decided internally.
    const ABOVE_TRACK = (base, clearance = 0.02) => TRACK_TOP_Y - base + clearance;

    // White edge lines just inside each kerb.
    const EDGE_LINE_WIDTH = 0.2;
    const edgeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: false, opacity: 1,
    });
    const edgeL = new THREE.Mesh(
      buildEdgeLineGeometry(curve, segments, -(TRACK_WIDTH + EDGE_LINE_WIDTH * 0.5), EDGE_LINE_WIDTH, 0.38),
      edgeMat,
    );
    const edgeR = new THREE.Mesh(
      buildEdgeLineGeometry(curve, segments, +(TRACK_WIDTH + EDGE_LINE_WIDTH * 0.5), EDGE_LINE_WIDTH, 0.38),
      edgeMat,
    );
    edgeL.position.y = ABOVE_TRACK(0.38, 0.01);
    edgeR.position.y = ABOVE_TRACK(0.38, 0.01);
    edgeL.renderOrder = 3; edgeR.renderOrder = 3;
    scene.add(edgeL); scene.add(edgeR);

    // Kerbs rendered as flat striped ribbons. This avoids long spike artifacts
    // from side-face triangulation while preserving clear red/white boundaries.
    const kerbTex = cachedTex("kerb", makeKerbStripeTexture);
    const kerbUv = Math.max(80, curveLenApprox / 8);
    const kerbMat = new THREE.MeshBasicMaterial({
      map: kerbTex,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const kerbL = new THREE.Mesh(
      buildEdgeLineGeometry(curve, segments, -(TRACK_WIDTH + KERB_WIDTH * 0.5), KERB_WIDTH, TRACK_TOP_Y + 0.015, kerbUv),
      kerbMat,
    );
    const kerbR = new THREE.Mesh(
      buildEdgeLineGeometry(curve, segments, +(TRACK_WIDTH + KERB_WIDTH * 0.5), KERB_WIDTH, TRACK_TOP_Y + 0.015, kerbUv),
      kerbMat,
    );
    kerbL.castShadow = false; kerbL.receiveShadow = false;
    kerbR.castShadow = false; kerbR.receiveShadow = false;
    kerbL.renderOrder = 4;
    kerbR.renderOrder = 4;
    scene.add(kerbL); scene.add(kerbR);

    const aoWidth = 0.42;
    const aoMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
      toneMapped: false,
    });
    const aoL = new THREE.Mesh(
      buildEdgeLineGeometry(curve, segments, -(TRACK_WIDTH - aoWidth * 0.5), aoWidth, 0.381, 80),
      aoMat,
    );
    const aoR = new THREE.Mesh(
      buildEdgeLineGeometry(curve, segments, +(TRACK_WIDTH - aoWidth * 0.5), aoWidth, 0.381, 80),
      aoMat,
    );
    aoL.position.y = ABOVE_TRACK(0.381, 0.006);
    aoR.position.y = ABOVE_TRACK(0.381, 0.006);
    aoL.renderOrder = 3;
    aoR.renderOrder = 3;
    scene.add(aoL);
    scene.add(aoR);

    const barrierOffset = Math.max(18, RUNOFF_INNER + RUNOFF_STRIP_WIDTH + 2.8);
    const barrierTex = cachedTex("armco", makeArmcoTexture);
    barrierTex.repeat.set(1, 20);
    const barrierMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: barrierTex,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const armcoHeight = 1.2;
    const armcoWidth = 0.35;
    const barrierL = new THREE.Mesh(
      buildVerticalRibbonGeometry(curve, segments, -barrierOffset, armcoWidth, 0.06, armcoHeight, 20),
      barrierMat,
    );
    const barrierR = new THREE.Mesh(
      buildVerticalRibbonGeometry(curve, segments, +barrierOffset, armcoWidth, 0.06, armcoHeight, 20),
      barrierMat,
    );
    barrierL.renderOrder = 2;
    barrierR.renderOrder = 2;
    scene.add(barrierL);
    scene.add(barrierR);

    const fenceMat = new THREE.MeshBasicMaterial({
      color: 0xd9e5ef,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const fenceOffset = barrierOffset + 0.06;
    const fenceBase = 0.06 + armcoHeight;
    const fenceHeight = 2.2;
    const fenceL = new THREE.Mesh(
      buildVerticalRibbonGeometry(curve, segments, -fenceOffset, 0.08, fenceBase, fenceHeight, 26),
      fenceMat,
    );
    const fenceR = new THREE.Mesh(
      buildVerticalRibbonGeometry(curve, segments, +fenceOffset, 0.08, fenceBase, fenceHeight, 26),
      fenceMat,
    );
    fenceL.renderOrder = 2;
    fenceR.renderOrder = 2;
    scene.add(fenceL);
    scene.add(fenceR);

    const cornerRanges = buildCornerRanges(curve, 720);
    const tracksideGroup = new THREE.Group();
    const propPoint = new THREE.Vector3();
    const propTan = new THREE.Vector3();
    const propRight = new THREE.Vector3();
    const propUp = new THREE.Vector3();
    const propFlatFwd = new THREE.Vector3();
    const propFlatRight = new THREE.Vector3();
    const propBasis = new THREE.Matrix4();
    const placeTrackside = (obj, u, side, offset, lift = 0.05) => {
      sampleTrackFrameAt(curve, u, propPoint, propTan, propRight, propUp);
      obj.position.copy(propPoint)
        .addScaledVector(propRight, offset * side)
        .addScaledVector(propUp, lift);
      propFlatFwd.copy(propTan);
      propFlatFwd.y = 0;
      if (propFlatFwd.lengthSq() < 1e-8) propFlatFwd.copy(propTan);
      propFlatFwd.normalize();
      propFlatRight.crossVectors(propFlatFwd, TRACKSIDE_WORLD_UP).normalize();
      if (propFlatRight.dot(propRight) < 0) propFlatRight.multiplyScalar(-1);
      propBasis.makeBasis(propFlatFwd, TRACKSIDE_WORLD_UP, propFlatRight);
      obj.quaternion.setFromRotationMatrix(propBasis);
      if (side > 0) obj.rotateY(Math.PI);
      tracksideGroup.add(obj);
    };

    const brakingDistances = [150, 100, 50];
    const brakingOffset = barrierOffset + 2.8;
    const cornerOffset = barrierOffset + 4.4;
    for (let i = 0; i < cornerRanges.length; i++) {
      const c = cornerRanges[i];
      const side = c.sign >= 0 ? 1 : -1;
      for (const dist of brakingDistances) {
        const u = ((c.startU - dist / Math.max(curveLength, 1)) % 1 + 1) % 1;
        placeTrackside(
          makeTracksidePlacard(String(dist), {
            width: 1.8,
            height: 1.25,
            postHeight: 2.5,
            bg: "#F4F4F6",
            fg: "#10131A",
            border: "#10131A",
          }),
          u,
          side,
          brakingOffset,
          0.04,
        );
      }
      placeTrackside(
        makeTracksidePlacard(`T${i + 1}`, {
          width: 2.0,
          height: 1.35,
          postHeight: 2.9,
          bg: "#11151D",
          fg: "#F4F4F6",
          border: "#F4F4F6",
          accent: "#FF5A36",
        }),
        c.apexU,
        side,
        cornerOffset,
        0.06,
      );
    }

    const gravelTex = cachedTex("gravel", makeGravelTexture);
    gravelTex.repeat.set(1, 45);
    const gravelMat = new THREE.MeshBasicMaterial({
      color: 0xc2a974,
      map: gravelTex,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const gravelInner = RUNOFF_INNER + RUNOFF_STRIP_WIDTH + 1.3;
    const gravelWidth = 5.5;
    for (const c of cornerRanges) {
      const side = c.sign >= 0 ? 1 : -1;
      const gravelOffset = side * (gravelInner + gravelWidth * 0.5);
      const gravelGeom = buildPartialEdgeLineGeometry(
        curve,
        segments,
        c.startU,
        c.endU,
        gravelOffset,
        gravelWidth,
        0.045,
        28,
      );
      const gravel = new THREE.Mesh(gravelGeom, gravelMat);
      gravel.renderOrder = 1;
      scene.add(gravel);
    }

    const skidMat = new THREE.MeshBasicMaterial({
      color: 0x050506,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      toneMapped: false,
    });
    for (const c of cornerRanges) {
      const sideBias = c.sign >= 0 ? 0.35 : -0.35;
      const baseStart = c.apexU;
      const end = c.endU;
      const span = end >= baseStart ? (end - baseStart) : (1 - baseStart + end);
      if (span < 0.01) continue;
      const s1 = baseStart + span * 0.18;
      const s2 = baseStart + span * 0.56;
      const e1 = Math.min(1, s1 + Math.min(0.018, span * 0.35));
      const e2 = Math.min(1, s2 + Math.min(0.016, span * 0.3));
      for (const tyreOffset of [-1.85, 1.85]) {
        const o = tyreOffset + sideBias;
        const skid1 = new THREE.Mesh(
          buildPartialEdgeLineGeometry(curve, segments, s1 % 1, e1 % 1, o, 0.22, 0.39, 5),
          skidMat,
        );
        const skid2 = new THREE.Mesh(
          buildPartialEdgeLineGeometry(curve, segments, s2 % 1, e2 % 1, o * 0.92, 0.2, 0.39, 4),
          skidMat,
        );
        skid1.position.y = ABOVE_TRACK(0.39, 0.01);
        skid2.position.y = ABOVE_TRACK(0.39, 0.012);
        skid1.renderOrder = 3;
        skid2.renderOrder = 3;
        scene.add(skid1);
        scene.add(skid2);
      }
    }

    // DRS zones — green stripes on the outer side of each zone.
    for (const z of window.APEX.DRS_ZONES || []) {
      const u = Math.max(0, Math.min(1, z.startIdx / Math.max(1, circuit.length - 1)));
      for (const side of [+1, -1]) {
        const m = buildDRSZoneMesh(curve, segments, circuit.length, z, side);
        m.position.y = ABOVE_TRACK(0.42, 0.03);
        scene.add(m);
        placeTrackside(
          makeTracksidePlacard("DRS", {
            width: 2.2,
            height: 1.3,
            postHeight: 2.6,
            bg: "#16B35E",
            fg: "#08110B",
            border: "#E6FFF1",
          }),
          u,
          side,
          brakingOffset - 0.6,
          0.04,
        );
      }
    }

    for (const sector of window.APEX.SECTORS || []) {
      if (sector.idx == null) continue;
      const u = Math.max(0, Math.min(1, sector.idx / Math.max(1, circuit.length - 1)));
      for (const side of [+1, -1]) {
        placeTrackside(makeMarshalPanel(sector.color || "#F4F4F6"), u, side, barrierOffset + 1.2, 0.04);
      }
    }
    scene.add(tracksideGroup);

    // Sector boundary gates are disabled by default in 3D because they can
    // read as intrusive cross-track bars at wide camera distances.
    if (showTrackHelpers) {
      for (const s of window.APEX.SECTORS || []) {
        if (s.idx == null) continue;
        const g = buildSectorGate(curve, circuit.length, s.idx, s.color || "#f4f4f8");
        g.position.y = ABOVE_TRACK(0.40, 0.04);
        scene.add(g);
      }
    }

    // Racing line + start/finish — lifted onto the track top face.
    const racingLine = buildRacingLineMesh(curve, segments);
    racingLine.position.y = ABOVE_TRACK(0.39, 0.015);
    scene.add(racingLine);
    if (showTrackHelpers) {
      const sf = buildStartFinishMesh(curve, TRACK_WIDTH);
      sf.position.y += ABOVE_TRACK(0.41, 0.025);
      scene.add(sf);
    }

    // Rain.
    const rain = buildRain(bboxInfo);
    scene.add(rain);

    // --- Camera + controls ---
    const camera = new THREE.PerspectiveCamera(50, 1, 1, extent * 10);
    const framing = extent * 0.9;
    camera.position.set(center.x + framing, framing * 0.65, center.z + framing);
    camera.lookAt(center);

    const renderer = new THREE.WebGLRenderer({ antialias: qp.msaa > 0, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, qp.dprCap));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Filmic tonemap + slight overshoot exposure makes the bloom pass + the
    // emissive lights/sun read like a TV broadcast feed instead of a flat
    // unlit pipeline.
    renderer.toneMapping = disableToneMapping ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = disableToneMapping ? 1.0 : preset.exposure;
    renderer.shadowMap.enabled = false;
    mount.appendChild(renderer.domElement);
    Object.assign(renderer.domElement.style, {
      position: "absolute", inset: "0", width: "100%", height: "100%",
      display: "block",
    });

    // Anisotropic filtering by texture role:
    //  - High (max, typically 16): textures the camera sees at extreme grazing
    //    angles down long straights. The track surface is the obvious case;
    //    runoff and grass come in second along the verge.
    //  - Modest (capped at 8): small repeating textures (kerb stripes, armco,
    //    gravel) where mip aliasing isn't the visible failure mode. Going
    //    above 8 here just costs samples without changing pixels.
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    const modestAniso = Math.min(8, maxAniso);
    const setAniso = (tex, target) => {
      if (tex && tex.anisotropy < target) {
        tex.anisotropy = target;
        // anisotropy is sampler state — no needsUpdate required, and setting
        // it would force a full texture re-upload to the GPU for no benefit.
      }
    };
    setAniso(asphaltTex,    maxAniso);
    setAniso(asphaltNormal, maxAniso);
    setAniso(runoffTex,     maxAniso);
    setAniso(grassTex,      maxAniso);
    setAniso(vergeTex,      modestAniso);
    setAniso(gravelTex,     modestAniso);
    setAniso(kerbTex,        modestAniso);
    setAniso(barrierTex,     modestAniso);

    // Image-based lighting from a procedural RoomEnvironment — gives the car
    // bodies real shoulder/cockpit reflections and lifts the metal kerb
    // accents without shipping an HDRI asset. Cached at module scope; the
    // PMREM generator only runs once per renderer instead of once per scene
    // build.
    const envTex = getRoomEnvironment(renderer);
    scene.environment = envTex;

    // --- Post-processing composer ---
    // Bloom is the headline effect (kerbs/DRS/brake lights/sun pop).
    // Vignette frames the shot and intensifies in chase cam at speed.
    // OutputPass handles tonemap+colorspace conversion at the end of the
    // chain (the renderer's tonemap is bypassed once we go through composer).
    const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, // HDR pipeline so bloom has dynamic range
      samples: qp.msaa,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    const composer = new EffectComposer(renderer, renderTarget);
    composer.setPixelRatio(Math.min(window.devicePixelRatio, qp.dprCap));
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    const bloomPass = qp.bloom ? new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      preset.bloom.strength,
      preset.bloom.radius,
      preset.bloom.threshold,
    ) : null;
    if (bloomPass) composer.addPass(bloomPass);
    const vignettePass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uStrength: { value: preset.vignette.base },
        uRadius:   { value: 1.1 },
        uTint:     { value: new THREE.Color(preset.vignette.tint) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform float uStrength;
        uniform float uRadius;
        uniform vec3 uTint;
        void main() {
          vec4 col = texture2D(tDiffuse, vUv);
          vec2 d = vUv - vec2(0.5);
          float r = length(d) * 1.4142136;
          float v = smoothstep(uRadius, 0.45, r);
          col.rgb = mix(uTint, col.rgb, mix(1.0, v, uStrength));
          gl_FragColor = col;
        }
      `,
    });
    composer.addPass(vignettePass);
    composer.addPass(new OutputPass());
    // SMAA runs last (post-tonemap) so it operates in display space where
    // the algorithm's edge detector is calibrated. composer.setSize cascades
    // to the pass automatically on resize.
    const smaaPass = qp.smaa ? new SMAAPass(1, 1) : null;
    if (smaaPass) composer.addPass(smaaPass);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.copy(center);
    controls.minDistance = 20;
    controls.maxDistance = extent * 4;
    controls.maxPolarAngle = Math.PI * 0.49;

    const labelLayer = makeLabelLayer(mount);
    const povHud = buildPovHud(mount);
    hudToggleRef.current = povHud.toggle;

    // --- Driver meshes ---
    const driverGroup = new THREE.Group();
    scene.add(driverGroup);
    const driverMap = new Map();

    // --- Safety car mesh + label ---
    let scGroup = null;  // created on first SC appearance, reused thereafter
    let scLabel = null;  // DOM label, created alongside scGroup

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const onClick = (e) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(driverGroup.children, true);
      if (hits.length > 0) {
        let obj = hits[0].object;
        while (obj && !obj.userData?.driverCode) obj = obj.parent;
        if (obj?.userData?.driverCode) onPickDriver && onPickDriver(obj.userData.driverCode, e);
      }
    };
    renderer.domElement.addEventListener("click", onClick);

    // --- Resize ---
    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      if (bloomPass) {
        const s = qp.bloomScale || 1;
        bloomPass.setSize(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
      }
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    // --- Chase state ---
    const chase = {
      pos: new THREE.Vector3(), look: new THREE.Vector3(), up: new THREE.Vector3(), initialised: false,
    };
    const CHASE_BEHIND = Math.max(18, extent * 0.004);
    const CHASE_HEIGHT = Math.max(6, extent * 0.002);
    const CHASE_SIDE = 1.4;
    const CHASE_LOOKAHEAD = Math.max(28, extent * 0.006);
    const CHASE_SMOOTH_POS = 6.0;
    const CHASE_SMOOTH_LOOK = 9.0;
    const CHASE_SMOOTH_UP = 7.0;

    // Per-car visual smoothing applied on top of the data interpolation in
    // sampleStandingsAt. Damps out kinks at network-frame boundaries (where
    // the inter-frame velocity can change abruptly) and noisy curve tangents
    // near the spline seam. Time constants ≈ 45 / 55 ms — small enough that
    // steady-state lag at 320 kph is ~4 m, well under typical viewing scale.
    const CAR_POS_SMOOTH = 22.0;
    const CAR_ROT_SMOOTH = 18.0;

    // --- POV (first-person / cockpit) state ---
    const POV_EYE_HEIGHT  = 3.100;
    const POV_EYE_FORWARD = 0.700;
    const POV_LOOK_AHEAD  = 64.0;
    const POV_LOOK_HEIGHT = 1.150;
    const POV_FOV         = 89.0;
    const POV_SMOOTH_ROT  = 12.0;
    const pov = {
      smoothedForward: null,
      smoothedUp: null,
      initialised: false,
      attachedTo: null,
    };
    const lastPovSelfRef = { code: null };

    // --- Animation loop ---
    let rafId;
    let lastT = performance.now();
    // EMA of dt used only for lerp factors. Raw dt drives physics-like
    // integrations (wheel spin, weather time). Smoothing here means a single
    // hitched frame doesn't slingshot dampers (chase pos/look, vignette, FOV).
    let dtSmooth = 1 / 60;
    const tmpPoint = new THREE.Vector3();
    const tmpTan = new THREE.Vector3();
    const _fwd = new THREE.Vector3();
    const _right = new THREE.Vector3();
    const _up = new THREE.Vector3();
    const _worldUp = new THREE.Vector3(0, 1, 0);
    const _basis = new THREE.Matrix4();
    const _carTargetQuat = new THREE.Quaternion();
    const _surf = new THREE.Vector3();
    const _vp = new THREE.Vector3();
    // Chase/POV scratch vectors to avoid per-frame allocations
    const _chasePos = new THREE.Vector3();
    const _chaseLook = new THREE.Vector3();
    const _eyeWorld = new THREE.Vector3();
    const _lookWorld = new THREE.Vector3();
    const _carForward = new THREE.Vector3();
    const _carUp = new THREE.Vector3();
    const _carRight = new THREE.Vector3();
    const _cameraRight = new THREE.Vector3();
    // Weather scratch vector
    const _windVec = new THREE.Vector3();

    // Project a world-space position to the renderer's CSS pixel grid. Returns
    // false when the point is outside the camera frustum (z < -1 or z > 1) so
    // the caller can hide its label. Mutates the shared `_vp` scratch to avoid
    // per-call allocations; safe because nothing else holds onto it across
    // the call.
    const projectToScreen = (worldPos, yOffset, w, h) => {
      _vp.copy(worldPos);
      _vp.y += yOffset;
      _vp.project(camera);
      if (_vp.z < -1 || _vp.z > 1) return null;
      return {
        px: (_vp.x * 0.5 + 0.5) * w,
        py: (-_vp.y * 0.5 + 0.5) * h,
      };
    };

    // Show/hide an HTMLElement label and position it at a screen-space coord.
    // Caches the visibility state on `_shown` so we only touch `style.display`
    // when it actually changes — DOM writes are the bulk of label cost.
    const setLabelXY = (label, screen, anchor) => {
      if (!screen) {
        if (label._shown !== false) { label.style.display = "none"; label._shown = false; }
        return;
      }
      if (label._shown !== true) { label.style.display = "block"; label._shown = true; }
      label.style.transform = `translate3d(${screen.px | 0}px, ${screen.py | 0}px, 0) ${anchor}`;
    };

    // ─── Per-frame safety-car update ─────────────────────────────────────
    // Lazy-creates the SC mesh + label on first appearance, then keeps the
    // mesh on the curve at `sc.fraction`. Hidden when `sc` is null/missing.
    const updateSafetyCar = (live, now) => {
      const sc = live.safetyCar;
      if (sc && sc.fraction != null) {
        if (!scGroup) {
          scGroup = makeSafetyCarMarker();
          scene.add(scGroup);
          scLabel = document.createElement("div");
          scLabel.textContent = "SC";
          Object.assign(scLabel.style, {
            position: "absolute",
            fontSize: "10px", fontWeight: "700", letterSpacing: "0.08em",
            color: "#ffcc00",
            background: "rgba(0,0,0,0.72)",
            border: "1px solid #ffcc0088",
            borderRadius: "3px",
            padding: "1px 4px",
            pointerEvents: "none",
            transform: "translate(-50%, -100%)",
            display: "none",
          });
          labelLayer.appendChild(scLabel);
        }
        scGroup.visible = true;
        const u = ((sc.fraction % 1) + 1) % 1;
        const p = curve.getPointAt(u, tmpPoint);
        curve.getTangentAt(u, tmpTan);
        _fwd.copy(tmpTan).normalize();
        _right.crossVectors(_fwd, _worldUp).normalize();
        _up.crossVectors(_right, _fwd).normalize();
        _basis.makeBasis(_fwd, _up, _right);
        scGroup.quaternion.setFromRotationMatrix(_basis);
        _surf.copy(_up).multiplyScalar(TRACK_TOP_Y + CAR_SURFACE_CLEARANCE);
        scGroup.position.set(p.x + _surf.x, p.y + _surf.y, p.z + _surf.z);
        // Pulse the halo opacity during "deploying" phase.
        const alpha = sc.alpha ?? 1;
        if (scGroup.userData.haloMat) {
          scGroup.userData.haloMat.opacity = sc.phase === "deploying"
            ? 0.3 + 0.25 * Math.sin(now * 0.005)
            : 0.55 * alpha;
        }
      } else {
        if (scGroup) scGroup.visible = false;
        if (scLabel && scLabel._shown !== false) {
          scLabel.style.display = "none";
          scLabel._shown = false;
        }
      }
    };

    // ─── Per-frame weather/wet-overlay update ────────────────────────────
    // Reads `live.weather`, mutates rain particles + track/runoff/ground/
    // fog tinting + bloom intensity. Idempotent: each branch fully sets
    // every value it depends on, so flipping rainState mid-race doesn't
    // leak the previous state.
    const updateWeather = (live, dt) => {
      const w = live.weather || {};
      const raining = w.rainState === "RAINING";
      rain.visible = raining;
      if (raining) {
        const wDeg = (w.windDirection || 0) + 180;
        const wRad = wDeg * Math.PI / 180;
        const wSpeed = (w.windSpeed || 0) * 0.2778;
        _windVec.set(Math.sin(wRad) * wSpeed, 0, -Math.cos(wRad) * wSpeed);
        advanceRain(rain, dt, _windVec);
        trackMat.color.setHex(trackWetColor);
        runoffMat.color.setHex(runoffWetColor);
        vergeMat.color.setHex(vergeWetColor);
        // Do not heavily darken terrain in rain; the fog/tonemap stack already
        // reduces perceived brightness and can otherwise look like "missing"
        // black patches around the track.
        groundMat.color.setHex(groundBaseColor);
        scene.fog.color.setHex(fogWetColor);
        scene.fog.density = (preset.fog.densityScale * WET_OVERLAY.fogDensityMult) / extent;
        if (bloomPass) {
          bloomPass.strength = preset.bloom.strength + WET_OVERLAY.bloomStrengthAdd;
          bloomPass.threshold = Math.max(0.7, preset.bloom.threshold - WET_OVERLAY.bloomThresholdDrop);
        }
      } else {
        trackMat.color.setHex(trackDryColor);
        runoffMat.color.setHex(runoffDryColor);
        vergeMat.color.setHex(vergeDryColor);
        groundMat.color.setHex(groundBaseColor);
        scene.fog.color.setHex(fogDryColor);
        scene.fog.density = preset.fog.densityScale / extent;
        if (bloomPass) {
          bloomPass.strength = preset.bloom.strength;
          bloomPass.threshold = preset.bloom.threshold;
        }
      }
    };

    // ─── Per-frame label projection ──────────────────────────────────────
    // Runs every frame the labels are visible. Hot path — keeps DOM writes
    // minimal via the `_shown` cache and skips off-screen / hidden cars
    // before paying the projection cost.
    const updateLabels = (live, inFollow, inPov, seen) => {
      if (!(live.showLabels && !inFollow)) {
        if (labelLayer.style.display !== "none") labelLayer.style.display = "none";
        return;
      }
      if (labelLayer.style.display !== "block") labelLayer.style.display = "block";
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      for (const [code, entry] of driverMap) {
        const label = entry.label;
        // Hide the pinned driver's own label in POV — they're the camera.
        if (inPov && code === live.pinned) {
          if (label._shown !== false) { label.style.display = "none"; label._shown = false; }
          continue;
        }
        const isSeen = seen.has(code);
        const hasStatusBadge = !!entry.lastLabelStatus;
        if ((!isSeen || !entry.group.visible) && !hasStatusBadge) {
          if (label._shown !== false) { label.style.display = "none"; label._shown = false; }
          continue;
        }
        setLabelXY(label, projectToScreen(entry.group.position, 3, w, h), "translate(-50%, -130%)");
      }
      if (scLabel && scGroup?.visible) {
        setLabelXY(scLabel, projectToScreen(scGroup.position, 3, w, h), "translate(-50%, -100%)");
      }
    };

    const animate = () => {
      try {
      const now = performance.now();
      const rawDt = (now - lastT) / 1000;
      const dt = Math.min(rawDt, 1 / 30);
      lastT = now;
      // EMA over ~4 frames; only used for damper k-factors via dtL.
      dtSmooth += (dt - dtSmooth) * 0.25;
      const dtL = dtSmooth;
      const live = liveRef.current;

      // Sample interpolated standings if available and enabled
      const renderDelay = window.APEX?.RENDER_DELAY_MS ?? 220;
      const tRender = now - renderDelay;
      let standings;
      if (window.APEX?.INTERPOLATE !== false && window.APEX.sampleStandingsAt) {
        standings = window.APEX.sampleStandingsAt(tRender) || live.standings || [];
      } else {
        standings = live.standings || [];
      }

      // ─── DRIVERS: position, orientation, indicators, status visibility ──
      const seen = new Set();
      for (const s of standings) {
        if (!s?.driver?.code) continue;
        seen.add(s.driver.code);
        let entry = driverMap.get(s.driver.code);
        if (!entry) {
          const g = makeDriverMarker(window.APEX.TEAMS[s.driver.team]);
          g.userData.driverCode = s.driver.code;
          driverGroup.add(g);
          const teamColor = window.APEX.TEAMS[s.driver.team]?.color || "#ff1e00";
          const label = makeLabel(s.driver.code, teamColor);
          setLabelStatus(label, s.labelStatus ?? s.label_status, s.statusReason ?? s.status_reason);
          labelLayer.appendChild(label);
          entry = {
            group: g,
            label,
            prevRight: new THREE.Vector3(1, 0, 0),
            havePrevRight: false,
          };
          driverMap.set(s.driver.code, entry);
        }
        if (entry.lastLabelStatus !== (s.labelStatus ?? s.label_status) || entry.lastStatusReason !== (s.statusReason ?? s.status_reason)) {
          setLabelStatus(entry.label, s.labelStatus ?? s.label_status, s.statusReason ?? s.status_reason);
          entry.lastLabelStatus = s.labelStatus ?? s.label_status;
          entry.lastStatusReason = s.statusReason ?? s.status_reason;
        }
        const frac = s.fraction != null ? s.fraction : 0;
        const u = ((frac % 1) + 1) % 1;
        const p = curve.getPointAt(u, tmpPoint);
        curve.getTangentAt(u, tmpTan);
        // Orient the car to follow the track surface in 3D (yaw + pitch)
        // so it doesn't sink into or float above the track on elevation changes.
        _fwd.copy(tmpTan);
        if (_fwd.lengthSq() < 1e-10) _fwd.set(1, 0, 0);
        else _fwd.normalize();
        entry.havePrevRight = updateStableRight(
          _fwd,
          _worldUp,
          _right,
          entry.prevRight,
          entry.havePrevRight,
        );
        _up.crossVectors(_right, _fwd).normalize();
        // Car local frame: +X forward, +Y up, +Z right
        _basis.makeBasis(_fwd, _up, _right);
        // Position on track surface, offset along the surface normal (up)
        // so the car sits on top of the track even on slopes.
        _surf.copy(_up).multiplyScalar(TRACK_TOP_Y + CAR_SURFACE_CLEARANCE);
        const targetX = p.x + _surf.x;
        const targetY = p.y + _surf.y;
        const targetZ = p.z + _surf.z;
        _carTargetQuat.setFromRotationMatrix(_basis);
        // First frame for this car: snap. After that: damp toward target.
        // Smooths kinks at network-frame boundaries in sampleStandingsAt and
        // tangent noise near the spline seam without adding perceptible lag.
        if (!entry.smoothInit) {
          entry.group.position.set(targetX, targetY, targetZ);
          entry.group.quaternion.copy(_carTargetQuat);
          entry.smoothInit = true;
        } else {
          const kPos = 1 - Math.exp(-CAR_POS_SMOOTH * dtL);
          const kRot = 1 - Math.exp(-CAR_ROT_SMOOTH * dtL);
          const pos = entry.group.position;
          pos.x += (targetX - pos.x) * kPos;
          pos.y += (targetY - pos.y) * kPos;
          pos.z += (targetZ - pos.z) * kPos;
          entry.group.quaternion.slerp(_carTargetQuat, kRot);
        }

        // Selection halo + ring scale.
        const isPinned = live.pinned === s.driver.code;
        const isSecondary = live.secondary === s.driver.code;
        const ring = entry.group.userData.groundHalo;
        const labelStatus = s.labelStatus ?? s.label_status ?? null;
        const isDns = s.status === "OUT" && labelStatus === "DNS";
        ring.scale.setScalar(isPinned ? 1.35 : isSecondary ? 1.15 : 1);
        ring.material.color.set(
          isPinned ? 0xff1e00 : isSecondary ? 0x00d9ff : (isDns ? 0xa3abb8 : entry.group.userData.baseColor),
        );
        ring.material.opacity = isPinned || isSecondary ? 0.75 : (isDns ? 0.26 : 0.32);

        // Brake / DRS indicators read directly from the standing record —
        // the enriched object preserves the raw `brake_pct`/`in_drs` fields,
        // so we avoid an extra `.find()` per car per frame.
        const brakePct = s.brake_pct ?? 0;
        entry.group.userData.brakeMat.opacity =
          brakePct > 0 ? Math.min(1, brakePct / 60) : 0;
        entry.group.userData.drsMat.opacity = s.in_drs ? 0.95 : 0.0;

        // Tyre compound colour on the small bobble above the car.
        const compInfo = window.APEX.COMPOUNDS[s.compound] || { color: "#ffd93a" };
        entry.group.userData.compound.material.color.set(compInfo.color);

        // Wheel spin — fake it from speed so the wheels rotate convincingly.
        // Only spin if the wheels are separate meshes (4 individual wheels).
        // If the GLB merged all wheels into one mesh, rotating it would tumble
        // the whole set like a helicopter — skip spin in that case.
        if (entry.group.userData.wheelsAreSeparateMeshes) {
          const speedMps = (s.speedKph || 0) / 3.6;
          const spinDelta = (speedMps / WHEEL_RADIUS) * dt;
          for (const wh of entry.group.userData.wheels) wh.rotation.z += spinDelta;
        }

        // Pit / out visibility on body only (keep halo for map legibility).
        // Cache the last applied status so we only walk the body/wheel arrays
        // when it actually changed — most frames are pure transform updates.
        // Note: halo colour/opacity is NOT set here — the per-frame selection
        // block above is the authoritative writer so pinned/secondary/DNS state
        // always wins regardless of status transitions.
        const status = s.status;
        const renderKey = `${status}:${labelStatus || ""}`;
        if (entry.lastRenderKey !== renderKey) {
          const outOfPlay = isDns ? false : status === "OUT";
          const inPit = status === "PIT";
          for (const m of entry.group.userData.body) m.visible = !outOfPlay;
          for (const wh of entry.group.userData.wheels) wh.visible = !outOfPlay;
          if (entry.group.userData.compound) entry.group.userData.compound.visible = !outOfPlay && !isDns;
          if (entry.group.userData.blobShadow) {
            entry.group.userData.blobShadow.visible = !outOfPlay && !isDns;
          }
          // Body/wheel materials are shared across drivers on the same team,
          // so PIT/DNS opacity must clone-on-write the first time we touch
          // them per car. After cloning, swap the material on every body/
          // wheel mesh of THIS car only — the shared cache stays opaque.
          const needsTrans = isDns || inPit;
          if (needsTrans && !entry.ownsMats) {
            const swap = (meshes, mats) => {
              const map = new Map();
              for (const mesh of meshes) {
                if (!mesh.material) continue;
                let owned = map.get(mesh.material.uuid);
                if (!owned) {
                  owned = mesh.material.clone();
                  map.set(mesh.material.uuid, owned);
                }
                mesh.material = owned;
              }
              // Replace mats list with the per-car clones (deduped).
              mats.length = 0;
              for (const m of map.values()) mats.push(m);
            };
            swap(entry.group.userData.body, entry.group.userData.bodyMats);
            swap(entry.group.userData.wheels, entry.group.userData.wheelMats || []);
            entry.ownsMats = true;
          }
          if (entry.ownsMats) {
            for (const mat of entry.group.userData.bodyMats) {
              mat.transparent = true;
              mat.opacity = isDns ? 0.34 : inPit ? 0.45 : 1;
            }
            for (const mat of entry.group.userData.wheelMats || []) {
              mat.transparent = true;
              mat.opacity = isDns ? 0.38 : inPit ? 0.5 : 1;
            }
          }
          entry.lastRenderKey = renderKey;
        }
      }
      for (const [code, entry] of driverMap) {
        if (!seen.has(code)) {
          driverGroup.remove(entry.group);
          entry.label.remove();
          driverMap.delete(code);
        }
      }

      updateSafetyCar(live, now);

      // ─── CAMERA: orbit / chase / POV mode resolution + FOV easing ─────
      const inFollow = live.cameraMode === "follow" && !!live.pinned;
      const inPov = live.cameraMode === "pov" && !!live.pinned;
      // Target vignette state — settles by lerp at the bottom so the FX
      // doesn't snap when the camera mode changes.
      let targetVignetteStrength = preset.vignette.base;
      let targetVignetteRadius = 1.1;
      let chaseSpeedKph = 0;

      // In POV, hide the pinned car's floating overhead indicators (compound
      // bobble, ground halo) which read as HUD clutter from inside the cockpit.
      // Applied every frame so a status change (which re-enables compound.visible
      // via the renderKey block) doesn't leak the overlay back into POV view.
      // On driver-switch or mode-exit, restore the previous car's indicators.
      const povSelf = inPov ? live.pinned : null;
      if (lastPovSelfRef.code !== povSelf) {
        const prev = driverMap.get(lastPovSelfRef.code);
        if (prev) {
          if (prev.group.userData.compound) prev.group.userData.compound.visible = true;
          if (prev.group.userData.groundHalo) prev.group.userData.groundHalo.visible = true;
        }
        lastPovSelfRef.code = povSelf;
      }
      if (povSelf) {
        const cur = driverMap.get(povSelf);
        if (cur) {
          if (cur.group.userData.compound) cur.group.userData.compound.visible = false;
          if (cur.group.userData.groundHalo) cur.group.userData.groundHalo.visible = false;
        }
      }

      // Linear scan is faster than a per-frame Map for ~20 drivers.
      const findByCode = (code) => {
        if (!code) return null;
        for (let i = 0; i < standings.length; i++) {
          if (standings[i]?.driver?.code === code) return standings[i];
        }
        return null;
      };

      if (inFollow) {
        const pinnedStanding = findByCode(live.pinned);
        const pinnedEntry = driverMap.get(live.pinned);
        if (pinnedStanding && pinnedEntry) {
          chaseSpeedKph = pinnedStanding.speedKph || 0;
          _carForward.set(1, 0, 0).applyQuaternion(pinnedEntry.group.quaternion).normalize();
          _carUp.set(0, 1, 0).applyQuaternion(pinnedEntry.group.quaternion).normalize();
          _carRight.set(0, 0, 1).applyQuaternion(pinnedEntry.group.quaternion).normalize();
          _chasePos.copy(pinnedEntry.group.position)
            .addScaledVector(_carForward, -CHASE_BEHIND)
            .addScaledVector(_carUp, CHASE_HEIGHT)
            .addScaledVector(_carRight, CHASE_SIDE);
          _chaseLook.copy(pinnedEntry.group.position)
            .addScaledVector(_carForward, CHASE_LOOKAHEAD)
            .addScaledVector(_carUp, 1.8);
          const kPos = 1 - Math.exp(-CHASE_SMOOTH_POS * dtL);
          const kLook = 1 - Math.exp(-CHASE_SMOOTH_LOOK * dtL);
          const kUp = 1 - Math.exp(-CHASE_SMOOTH_UP * dtL);
          if (!chase.initialised) {
            chase.pos.copy(_chasePos);
            chase.look.copy(_chaseLook);
            chase.up.copy(_carUp);
            chase.initialised = true;
          } else {
            chase.pos.lerp(_chasePos, kPos);
            chase.look.lerp(_chaseLook, kLook);
            chase.up.lerp(_carUp, kUp).normalize();
          }
          camera.position.copy(chase.pos);
          camera.up.copy(chase.up);
          camera.lookAt(chase.look);
          controls.enabled = false;
          updatePovHud(povHud, pinnedStanding,
            window.APEX.COMPOUNDS[pinnedStanding.compound]);
          // Speed → vignette: subtle hint of velocity rather than a tunnel.
          // Smoothstep through the meaningful 150–300 kph band.
          const sNorm = Math.max(0, Math.min(1, (chaseSpeedKph - 80) / 240));
          const sCurve = sNorm * sNorm * (3 - 2 * sNorm);
          targetVignetteStrength = preset.vignette.base + sCurve * 0.25;
          targetVignetteRadius = 1.05 - sCurve * 0.2;
          // Subtle FOV widening at speed for that "hood-cam" effect.
          const targetFov = 50 + sCurve * 8;
          camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-3 * dtL));
          camera.updateProjectionMatrix();
        } else {
          povHud.root.style.display = "none"; povHud.pill.style.display = "none";
        }
      } else if (inPov) {
        const pinnedStanding = findByCode(live.pinned);
        const pinnedEntry = driverMap.get(live.pinned);
        if (pinnedStanding && pinnedEntry) {
          chaseSpeedKph = pinnedStanding.speedKph || 0;

          if (camera.near !== 0.1) {
            camera.near = 0.1;
            camera.updateProjectionMatrix();
          }

          _carForward.set(1, 0, 0).applyQuaternion(pinnedEntry.group.quaternion).normalize();
          _carUp.set(0, 1, 0).applyQuaternion(pinnedEntry.group.quaternion).normalize();
          _carRight.set(0, 0, 1).applyQuaternion(pinnedEntry.group.quaternion).normalize();

          // Reset smoothed forward when switching drivers.
          if (!pov.initialised || pov.attachedTo !== live.pinned) {
            if (!pov.smoothedForward) pov.smoothedForward = new THREE.Vector3();
            if (!pov.smoothedUp) pov.smoothedUp = new THREE.Vector3();
            pov.smoothedForward.copy(_carForward);
            pov.smoothedUp.copy(_carUp);
            pov.initialised = true;
            pov.attachedTo = live.pinned;
          } else {
            if (!pov.smoothedForward) pov.smoothedForward = new THREE.Vector3();
            if (!pov.smoothedUp) pov.smoothedUp = new THREE.Vector3();
            const kFwd = 1 - Math.exp(-POV_SMOOTH_ROT * dtL);
            pov.smoothedForward.lerp(_carForward, kFwd).normalize();
            pov.smoothedUp.lerp(_carUp, kFwd).normalize();
          }
          const fwd = pov.smoothedForward;
          const up = pov.smoothedUp;
          _cameraRight.crossVectors(fwd, up).normalize();
          up.crossVectors(_cameraRight, fwd).normalize();

          _eyeWorld.copy(pinnedEntry.group.position)
            .addScaledVector(fwd, POV_EYE_FORWARD)
            .addScaledVector(up, POV_EYE_HEIGHT);
          camera.position.copy(_eyeWorld);
          camera.up.copy(up);

          _lookWorld.copy(pinnedEntry.group.position)
            .addScaledVector(fwd, POV_LOOK_AHEAD)
            .addScaledVector(up, POV_LOOK_HEIGHT);
          camera.lookAt(_lookWorld);

          controls.enabled = false;
          updatePovHud(povHud, pinnedStanding,
            window.APEX.COMPOUNDS[pinnedStanding.compound]);

          const sNorm = Math.max(0, Math.min(1, (chaseSpeedKph - 80) / 240));
          const sCurve = sNorm * sNorm * (3 - 2 * sNorm);
          targetVignetteStrength = preset.vignette.base + sCurve * 0.3;
          targetVignetteRadius = 1.0 - sCurve * 0.22;
          const targetFov = POV_FOV + sCurve * 6;
          camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-3 * dtL));
          camera.updateProjectionMatrix();
        } else {
          povHud.root.style.display = "none"; povHud.pill.style.display = "none";
        }
      } else {
        if (chase.initialised) {
          controls.target.copy(center);
          chase.initialised = false;
        }
        camera.up.copy(_worldUp);
        controls.enabled = true;
        controls.update();
        povHud.root.style.display = "none"; povHud.pill.style.display = "none";
        // Reset chase-cam FOV when we leave follow/pov.
        camera.fov += (50 - camera.fov) * (1 - Math.exp(-3 * dtL));
        // Restore the default near plane when leaving POV so distant track
        // geometry isn't over-precise-to-the-point-of-shimmering.
        if (camera.near !== 1) {
          camera.near = 1;
        }
        camera.updateProjectionMatrix();
      }

      updateWeather(live, dt);

      // Tick star twinkle.
      if (stars) stars.material.uniforms.uTime.value += dt;

      // Smoothly settle vignette toward target each frame.
      const kV = 1 - Math.exp(-4 * dtL);
      const vu = vignettePass.uniforms;
      vu.uStrength.value += (targetVignetteStrength - vu.uStrength.value) * kV;
      vu.uRadius.value   += (targetVignetteRadius   - vu.uRadius.value)   * kV;

      updateLabels(live, inFollow, inPov, seen);

      // Frame ran clean — re-arm the error logger so a recurrence after a
      // healthy window gets logged again instead of being dedupe-swallowed.
      animate._lastErr = null;
      } catch (err) {
        // Log only the first occurrence of a recurring error so a buggy frame
        // doesn't flood the console. Re-armed above on a clean frame.
        if (!animate._lastErr || animate._lastErr.message !== err.message) {
          console.error('[Track3D animate]', err);
          animate._lastErr = err;
        }
      } finally {
        // composer.render() runs unconditionally so a buggy frame doesn't
        // freeze the canvas. _lastErr is only cleared by a fully-clean frame
        // (the assignment above the catch), never here.
        composer.render();
      }
      rafId = requestAnimationFrame(animate);
    };
    rafId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener("click", onClick);
      for (const [, entry] of driverMap) entry.label.remove();
      if (scLabel) scLabel.remove();
      labelLayer.remove();
      povHud.root.remove();
      povHud.pill.remove();
      composer.dispose();
      renderTarget.dispose();
      // envTex is module-cached (getRoomEnvironment) — do NOT dispose here.
      // Disposing a previously-cached envTex would break the next scene build.
      renderer.domElement.remove();
      renderer.dispose();
      // The PMREM is bound to a renderer; once that renderer is gone the
      // cached env is unusable. Drop the cache so the next renderer rebuilds.
      if (_pmremRendererRef === renderer) {
        _pmremEnv = null;
        _pmremRendererRef = null;
      }
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) {
            for (const m of o.material) m.dispose();
          } else {
            o.material.dispose();
          }
        }
      });
    };
  }, [geoVersion, todKey, qualityVersion]);

  return (
    <div ref={mountRef} style={{
      position: "absolute", inset: 0, overflow: "hidden",
    }}/>
  );
}

window.Track3D = Track3D;
