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
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

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
  // (c) Racing line wear — subtle darker polish down the middle of the
  // ribbon (UV-Y runs length-wise in buildRibbonGeometry).
  const rl = ctx.createLinearGradient(0, 0, size, 0);
  rl.addColorStop(0.00, "rgba(0,0,0,0.0)");
  rl.addColorStop(0.45, "rgba(0,0,0,0.08)");
  rl.addColorStop(0.50, "rgba(0,0,0,0.12)");
  rl.addColorStop(0.55, "rgba(0,0,0,0.08)");
  rl.addColorStop(1.00, "rgba(0,0,0,0.0)");
  ctx.fillStyle = rl;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
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
  return new THREE.CatmullRomCurve3(pts, closed, "centripetal", 0.5);
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
    const p = curve.getPoint(t);
    curve.getTangent(t, tan);
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
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3();
  const prevRight = new THREE.Vector3();
  const tan = new THREE.Vector3();
  let havePrevRight = false;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = curve.getPoint(t);
    curve.getTangent(t, tan);
    havePrevRight = updateStableRight(tan, up, right, prevRight, havePrevRight);
    const yTop = p.y + baseY + thickness;
    const yBot = p.y + baseY;
    const base = i * vertsPerRing * 3;
    // top-left
    positions[base + 0] = p.x - right.x * halfWidth;
    positions[base + 1] = yTop;
    positions[base + 2] = p.z - right.z * halfWidth;
    // top-right
    positions[base + 3] = p.x + right.x * halfWidth;
    positions[base + 4] = yTop;
    positions[base + 5] = p.z + right.z * halfWidth;
    // bot-left
    positions[base + 6] = p.x - right.x * halfWidth;
    positions[base + 7] = yBot;
    positions[base + 8] = p.z - right.z * halfWidth;
    // bot-right
    positions[base + 9]  = p.x + right.x * halfWidth;
    positions[base + 10] = yBot;
    positions[base + 11] = p.z + right.z * halfWidth;
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
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3();
  const prevRight = new THREE.Vector3();
  const tan = new THREE.Vector3();
  let havePrevRight = false;
  const half = width * 0.5;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = curve.getPoint(t);
    curve.getTangent(t, tan);
    havePrevRight = updateStableRight(tan, up, right, prevRight, havePrevRight);
    const inner = offset - half, outer = offset + half;
    positions[i * 6 + 0] = p.x + right.x * inner;
    positions[i * 6 + 1] = p.y + yLift;
    positions[i * 6 + 2] = p.z + right.z * inner;
    positions[i * 6 + 3] = p.x + right.x * outer;
    positions[i * 6 + 4] = p.y + yLift;
    positions[i * 6 + 5] = p.z + right.z * outer;
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
    const p = curve.getPoint(t);
    curve.getTangent(t, tan);
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
    const p = curve.getPoint(i / segments);
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
        reject(err);
      },
    );
  });
  return _baseModelPromise;
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
    baseColor: color.clone(),
  };
  return g;
}

// Add indicator overlays (ground halo, brake/DRS lamps, compound dot) to a
// car group. These are functional indicators that sit on top of any car model.
function addIndicatorOverlays(g, color) {
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
  g.userData = { baseColor: color.clone(), body: [], bodyMats: [], wheels: [] };

  // Add indicator overlays right away (they work independently of the car body).
  addIndicatorOverlays(g, color);

  // Kick off the async model load. Once resolved, clone the base model and
  // insert it into the group, wiring up the userData hooks the animation loop
  // depends on.
  loadBaseCarModel().then((baseModel) => {
    const clone = baseModel.clone();
    // Deep-clone materials so each car gets its own instances. Without this,
    // Object3D.clone() shares materials and tinting one car tints all of them.
    const matMap = new Map();
    clone.traverse((child) => {
      if (!child.isMesh) return;
      if (child.material && !matMap.has(child.material)) {
        matMap.set(child.material, child.material.clone());
      }
      child.material = matMap.get(child.material);
    });
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
    // Apply team livery colour to body materials only (not wheels).
    // The GLB model uses plain #000000 materials — tint them with the team
    // colour so each car is visually distinct. Only override the albedo
    // colour; leave roughness, metalness, emissive etc. intact.
    for (const mat of bodyMats) {
      if (mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial) {
        mat.color.copy(color);
      }
    }
    // Force wheel/tyre materials to black — they should never be coloured.
    for (const mat of wheelMats) {
      if (mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial) {
        mat.color.set(0x0a0a0a);
      }
    }
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
    g.userData.wheelsAreSeparateMeshes = true;
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
  el.textContent = code;
  Object.assign(el.style, {
    position: "absolute",
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

// ───────────────────────────────────────────────────────────────────────────
// Atmosphere — sky, grandstand rim, rain.
// ───────────────────────────────────────────────────────────────────────────

// Time-of-day presets. F1 has day, twilight and night races, so we key a
// handful of scene parameters (sky gradient, sun intensity/angle, hemi fill,
// fog, post FX) off the circuit name. Unknown circuits default to "day".
const TOD_PRESETS = {
  day: {
    sceneBg: 0x7f93ad,
    sky: {
      zenith: 0x3a6fb6, horizon: 0xbfd0e0, ground: 0x4e5560,
      sunColor: 0xfff4d6, sunDisc: 2.2, hazeTint: 1.15, starStrength: 0.0,
    },
    sun: { dir: [0.35, 0.85, -0.35], color: 0xfff1d6, intensity: 2.0 },
    hemi: { sky: 0xbcd4ff, ground: 0x6a6d78, intensity: 0.9 },
    fog: { color: 0x9aadc4, densityScale: 0.55 },
    // Runoff is lighter-grey paved, ground concrete even lighter, so the dark
    // asphalt track reads as the darkest ribbon of the three.
    ground: { color: 0xa8adb6 },
    runoff: { color: 0x6a6d76 },
    trackTint: 0xf2f3fa,
    exposure: 0.95,
    bloom: { strength: 0.22, threshold: 0.95, radius: 0.55 },
    vignette: { base: 0.28, tint: 0x0a0b10 },
    kerb: { emissive: 0x000000, emissiveIntensity: 0.0 },
  },
  dusk: {
    sceneBg: 0x1a1826,
    sky: {
      zenith: 0x121933, horizon: 0x703845, ground: 0x100f18,
      sunColor: 0xffb889, sunDisc: 3.4, hazeTint: 1.45, starStrength: 0.18,
    },
    sun: { dir: [0.45, 0.55, -0.7], color: 0xffc194, intensity: 1.6 },
    hemi: { sky: 0xa39abb, ground: 0x3b2f3a, intensity: 0.55 },
    fog: { color: 0x23202c, densityScale: 0.9 },
    ground: { color: 0x262530 },
    runoff: { color: 0x2b2b36 },
    trackTint: 0xe8eaf2,
    exposure: 0.98,
    bloom: { strength: 0.32, threshold: 0.88, radius: 0.55 },
    vignette: { base: 0.38, tint: 0x07080e },
    kerb: { emissive: 0x0a0000, emissiveIntensity: 0.05 },
  },
  night: {
    sceneBg: 0x05060c,
    sky: {
      zenith: 0x05070f, horizon: 0x181428, ground: 0x05060a,
      sunColor: 0xffd9a8, sunDisc: 1.2, hazeTint: 1.4, starStrength: 0.55,
    },
    // Under stadium lights → key comes from high overhead, cool white.
    sun: { dir: [0.25, 0.95, -0.15], color: 0xe8ecff, intensity: 1.1 },
    hemi: { sky: 0x2c395a, ground: 0x0a0a10, intensity: 0.4 },
    fog: { color: 0x08090e, densityScale: 1.0 },
    ground: { color: 0x16161e },
    runoff: { color: 0x1e1e28 },
    trackTint: 0xd8dbe6,
    exposure: 1.0,
    bloom: { strength: 0.38, threshold: 0.82, radius: 0.55 },
    vignette: { base: 0.4, tint: 0x04050a },
    kerb: { emissive: 0x140000, emissiveIntensity: 0.12 },
  },
};

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
      uStarStrength: { value: preset.sky.starStrength },
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
      uniform float uStarStrength;

      float hash21(vec2 p) {
        p = fract(p * vec2(443.8975, 397.2973));
        p += dot(p.xy, p.yx + 19.19);
        return fract(p.x * p.y);
      }

      void main() {
        vec3 d = normalize(vDir);
        float t = clamp(d.y, -1.0, 1.0);
        // Sky-vertical gradient.
        vec3 sky = (t > 0.0)
          ? mix(uHorizon, uZenith, smoothstep(0.0, 0.55, t))
          : mix(uHorizon, uGround, smoothstep(0.0, -0.25, t));
        // Haze concentrated at the horizon — warmer in dusk, cooler in day.
        float haze = exp(-abs(t) * 5.5);
        sky = mix(sky, uHorizon * uHazeTint, haze * 0.45);
        // Sun disc + bloom-friendly glow.
        float sd = max(0.0, dot(d, normalize(uSunDir)));
        float disc = smoothstep(uSunSize, uSunSize + 0.0008, sd);
        float halo = pow(sd, 64.0) * 0.40 + pow(sd, 6.0) * 0.08;
        sky += uSunColor * (disc * uSunDisc + halo);
        // Sparse stars: only above horizon, fade in as we look up.
        if (uStarStrength > 0.01 && t > 0.05) {
          // Project direction onto a stable grid (uses xz / y pseudo-tangent).
          vec2 grid = floor(d.xz / max(0.04, d.y) * 220.0);
          float h = hash21(grid);
          float star = step(0.9965, h) * uStarStrength * smoothstep(0.05, 0.4, t);
          // Twinkle bias — vary brightness per star.
          star *= 0.5 + 0.5 * hash21(grid + 13.7);
          sky += vec3(star) * vec3(0.85, 0.9, 1.0);
        }
        gl_FragColor = vec4(sky, 1.0);
      }
    `,
  });
  return new THREE.Mesh(geom, mat);
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
function buildGrandstands(center, extent, yBase) {
  const g = new THREE.Group();
  const radius = extent * 1.15;
  const count = 22;
  const baseColor = new THREE.Color(0x1c1d28);
  const accentColor = new THREE.Color(0x322438);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.1;
    const r = radius * (0.92 + Math.random() * 0.18);
    const h = 8 + Math.random() * 14;
    const w = 50 + Math.random() * 90;
    const d = 22 + Math.random() * 30;
    const col = Math.random() > 0.7 ? accentColor : baseColor;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshBasicMaterial({ color: col }),
    );
    m.position.set(
      center.x + Math.cos(a) * r,
      yBase + h * 0.5,
      center.z + Math.sin(a) * r,
    );
    m.rotation.y = -a + Math.PI * 0.5 + (Math.random() - 0.5) * 0.4;
    g.add(m);
  }
  return g;
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
  const root = document.createElement("div");
  Object.assign(root.style, {
    position: "absolute", left: "50%", bottom: "38px",
    transform: "translateX(-50%)",
    display: "none",
    fontFamily: "JetBrains Mono, monospace",
    color: "#f4f4f8",
    padding: "10px 16px",
    background: "rgba(11,11,17,0.8)",
    border: "1px solid rgba(255,30,0,0.35)",
    backdropFilter: "blur(6px)",
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
    </div>
  `;
  mount.appendChild(root);
  const q = (sel) => root.querySelector(sel);
  return {
    root,
    code: q("[data-hud=code]"),
    speed: q("[data-hud=speed]"),
    gear: q("[data-hud=gear]"),
    thr: q("[data-hud=thr]"),
    brk: q("[data-hud=brk]"),
    drs: q("[data-hud=drs]"),
    tyre: q("[data-hud=tyre]"),
  };
}

function updatePovHud(hud, standing, compoundInfo) {
  if (!standing) { hud.root.style.display = "none"; return; }
  hud.root.style.display = "block";
  hud.code.textContent = standing.driver.code;
  hud.speed.textContent = String(Math.round(standing.speedKph || 0)).padStart(3, "0");
  hud.gear.textContent = String(standing.stint != null && standing.status === "PIT" ? "P" : (standing.driver && standing.driver.code ? "" : "—"))
    || (standing.status === "PIT" ? "P" : "—");
  // gear isn't in the standings mapping — we use telemetryFor instead.
  const tel = window.APEX.telemetryFor(standing.driver.code, 0);
  hud.gear.textContent = standing.status === "PIT" ? "P" : String(tel.gear ?? "—");
  hud.thr.style.width = `${Math.max(0, Math.min(100, tel.throttle || 0))}%`;
  hud.brk.style.width = `${Math.max(0, Math.min(100, tel.brake || 0))}%`;
  const drsOn = !!tel.drs;
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
}) {
  const mountRef = React.useRef(null);
  const liveRef = React.useRef({ standings, pinned, secondary, cameraMode, weather, showLabels });
  liveRef.current = { standings, pinned, secondary, cameraMode, weather, showLabels };
  // Rebuild scene when the circuit changes (TOD preset is baked at setup).
  const todKey = detectTimeOfDay(circuitName);

  const [geoVersion, setGeoVersion] = React.useState(0);
  React.useEffect(() => {
    let lastLen = -1;
    const id = setInterval(() => {
      const n = window.APEX.CIRCUIT.length;
      if (n !== lastLen && n >= 2) {
        lastLen = n;
        setGeoVersion((v) => v + 1);
      }
    }, 250);
    return () => clearInterval(id);
  }, []);

  React.useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const circuit = window.APEX.CIRCUIT;
    if (circuit.length < 2) return;

    // --- Scene + lights ---
    const preset = TOD_PRESETS[todKey] || TOD_PRESETS.day;
    const search = new URLSearchParams(window.location.search);
    const debugLayerColors = search.get("trackDebug") === "1";
    const disableToneMapping = search.get("trackToneMap") === "off";
    const showTrackHelpers = search.get("trackHelpers") === "1";
    const groundBaseColor = debugLayerColors ? 0x00ff00 : preset.ground.color;
    const runoffDryColor = debugLayerColors ? 0x0060ff : preset.runoff.color;
    const runoffWetColor = debugLayerColors ? runoffDryColor : 0x10101a;
    const trackDryColor = debugLayerColors ? 0xff00ff : preset.trackTint;
    const trackWetColor = debugLayerColors ? trackDryColor : 0x3a3a48;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(preset.sceneBg);

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
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const shadowFrustum = extent * 1.1;
    sun.shadow.camera.left = -shadowFrustum;
    sun.shadow.camera.right = shadowFrustum;
    sun.shadow.camera.top = shadowFrustum;
    sun.shadow.camera.bottom = -shadowFrustum;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = sunDistance * 3;
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.6;
    sun.shadow.radius = 4; // soft PCF radius

    const sky = buildSkyDome(extent * 4, sunDir, preset);
    sky.position.copy(center);
    scene.add(sky);

    // Layered horizon: rolling hills in the distance, scattered grandstand
    // accents close in. Both sit just below the lowest curve point so the
    // track always reads as on top of the terrain.
    const standsY = bb.min.y - 0.4;
    scene.add(buildHorizonHills(center, extent, standsY));
    scene.add(buildGrandstands(center, extent, standsY));

    // Ground plane with concrete noise texture. Tile count scales with the
    // ground extent so individual noise cells stay roughly 120 m across —
    // dense enough to kill visible tiling, loose enough that the ground
    // reads as a calm surface rather than a bubbling sea under fog.
    const groundSize = extent * 6;
    const concreteTex = makeConcreteTexture();
    concreteTex.repeat.set(groundSize / 120, groundSize / 120);
    const groundGeom = new THREE.PlaneGeometry(groundSize, groundSize, 1, 1);
    groundGeom.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshStandardMaterial({
      color: groundBaseColor, map: concreteTex, roughness: 0.95, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4,
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.position.set(center.x, bb.min.y - 0.5, center.z);
    ground.receiveShadow = true;
    scene.add(ground);

    // Runoff band — TWO parallel strips outside the track/kerbs, NOT a full
    // ribbon under the track. The previous version was a single wide ribbon
    // spanning ±RUNOFF_WIDTH that physically overlapped the track strip
    // (±TRACK_WIDTH). At grazing camera angles the 30 cm yLift gap + polygon
    // offset weren't enough to stop z-fighting, and the runoff would win for
    // the central strip — making the track look translucent / missing its
    // material. Two parallel strips outside the kerbs eliminate the overlap
    // entirely: each side spans from kerb-outer to runoff-outer.
    const RUNOFF_INNER = TRACK_WIDTH + KERB_WIDTH;
    const RUNOFF_STRIP_WIDTH = RUNOFF_WIDTH - RUNOFF_INNER;
    const RUNOFF_STRIP_CENTER = RUNOFF_INNER + RUNOFF_STRIP_WIDTH * 0.5;
    const runoffTex = makeConcreteTexture();
    runoffTex.repeat.set(2, 80);
    const runoffMat = new THREE.MeshStandardMaterial({
      color: runoffDryColor, map: runoffTex, roughness: 0.92, metalness: 0,
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
    const asphaltTex = makeAsphaltTexture();
    asphaltTex.repeat.set(1, trackUv);
    const trackGeom = buildExtrudedRibbonGeometry(
      curve, segments, TRACK_WIDTH, TRACK_BASE_Y, TRACK_THICKNESS, trackUv,
    );
    // Solid-color base ensures the fragment never dips into "same luma as
    // the ground" territory, even when the texture mip averages to grey at
    // distance. `#1a1a22` reads as tar: darker than the concrete ground
    // (0xa8adb6) by a wide margin but not so black that ACES clips it.
    // Texture is still bound so the subtle aggregate pattern shows at close
    // range; `toneMapped = false` keeps it from getting pushed toward grey.
    const trackMat = new THREE.MeshBasicMaterial({
      color: trackDryColor,
      map: asphaltTex,
      toneMapped: false,
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
    const edgeMat = new THREE.MeshBasicMaterial({
      color: 0xdcdce4, transparent: true, opacity: 0.75,
    });
    const edgeL = new THREE.Mesh(
      buildEdgeLineGeometry(curve, segments, -(TRACK_WIDTH - 0.25), 0.25, 0.38),
      edgeMat,
    );
    const edgeR = new THREE.Mesh(
      buildEdgeLineGeometry(curve, segments, +(TRACK_WIDTH - 0.25), 0.25, 0.38),
      edgeMat,
    );
    edgeL.position.y = ABOVE_TRACK(0.38, 0.01);
    edgeR.position.y = ABOVE_TRACK(0.38, 0.01);
    edgeL.renderOrder = 3; edgeR.renderOrder = 3;
    scene.add(edgeL); scene.add(edgeR);

    // Kerbs rendered as flat striped ribbons. This avoids long spike artifacts
    // from side-face triangulation while preserving clear red/white boundaries.
    const kerbTex = makeKerbStripeTexture();
    const kerbUv = Math.max(120, curveLenApprox / 5);
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

    // DRS zones — green stripes on the outer side of each zone.
    for (const z of window.APEX.DRS_ZONES || []) {
      for (const side of [+1, -1]) {
        const m = buildDRSZoneMesh(curve, segments, circuit.length, z, side);
        m.position.y = ABOVE_TRACK(0.42, 0.03);
        scene.add(m);
      }
    }

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

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Filmic tonemap + slight overshoot exposure makes the bloom pass + the
    // emissive lights/sun read like a TV broadcast feed instead of a flat
    // unlit pipeline.
    renderer.toneMapping = disableToneMapping ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = disableToneMapping ? 1.0 : preset.exposure;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);
    Object.assign(renderer.domElement.style, {
      position: "absolute", inset: "0", width: "100%", height: "100%",
      display: "block",
    });

    // Image-based lighting from a procedural RoomEnvironment — gives the car
    // bodies real shoulder/cockpit reflections and lifts the metal kerb
    // accents without shipping an HDRI asset.
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const envScene = new RoomEnvironment();
    const envTex = pmrem.fromScene(envScene, 0.04).texture;
    scene.environment = envTex;
    pmrem.dispose();

    // --- Post-processing composer ---
    // Bloom is the headline effect (kerbs/DRS/brake lights/sun pop).
    // Vignette frames the shot and intensifies in chase cam at speed.
    // OutputPass handles tonemap+colorspace conversion at the end of the
    // chain (the renderer's tonemap is bypassed once we go through composer).
    const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, // HDR pipeline so bloom has dynamic range
      samples: 4,                // multisample = free SMAA-quality edges
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    const composer = new EffectComposer(renderer, renderTarget);
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      preset.bloom.strength,
      preset.bloom.radius,
      preset.bloom.threshold,
    );
    composer.addPass(bloomPass);
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

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.copy(center);
    controls.minDistance = 20;
    controls.maxDistance = extent * 4;
    controls.maxPolarAngle = Math.PI * 0.49;

    const labelLayer = makeLabelLayer(mount);
    const povHud = buildPovHud(mount);

    // --- Driver meshes ---
    const driverGroup = new THREE.Group();
    scene.add(driverGroup);
    const driverMap = new Map();

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
      bloomPass.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    // --- Chase state ---
    const chase = {
      pos: new THREE.Vector3(), look: new THREE.Vector3(), initialised: false,
    };
    const CHASE_BEHIND = Math.max(18, extent * 0.004);
    const CHASE_HEIGHT = Math.max(6, extent * 0.002);
    const CHASE_LOOKAHEAD = Math.max(28, extent * 0.006);
    const CHASE_SMOOTH_POS = 6.0;
    const CHASE_SMOOTH_LOOK = 9.0;

    // --- Animation loop ---
    let rafId;
    let lastT = performance.now();
    const tmpTan = new THREE.Vector3();

    const animate = () => {
      try {
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastT) / 1000);
      lastT = now;
      const live = liveRef.current;

      // Reconcile drivers.
      const seen = new Set();
      const standings = live.standings || [];
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
          labelLayer.appendChild(label);
          entry = { group: g, label };
          driverMap.set(s.driver.code, entry);
        }
        const frac = s.fraction != null ? s.fraction : 0;
        const u = ((frac % 1) + 1) % 1;
        const p = curve.getPointAt(u);
        curve.getTangentAt(u, tmpTan);
        // Orient the car to follow the track surface in 3D (yaw + pitch)
        // so it doesn't sink into or float above the track on elevation changes.
        const fwd = tmpTan.clone().normalize();
        const worldUp = new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3().crossVectors(fwd, worldUp).normalize();
        const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
        // Car local frame: +X forward, +Y up, +Z right
        const m = new THREE.Matrix4().makeBasis(fwd, up, right);
        entry.group.quaternion.setFromRotationMatrix(m);
        // Position on track surface, offset along the surface normal (up)
        // so the car sits on top of the track even on slopes.
        const surfaceOffset = up.clone().multiplyScalar(TRACK_TOP_Y + CAR_SURFACE_CLEARANCE);
        entry.group.position.set(p.x + surfaceOffset.x, p.y + surfaceOffset.y, p.z + surfaceOffset.z);

        // Selection halo + ring scale.
        const isPinned = live.pinned === s.driver.code;
        const isSecondary = live.secondary === s.driver.code;
        const ring = entry.group.userData.groundHalo;
        ring.scale.setScalar(isPinned ? 1.35 : isSecondary ? 1.15 : 1);
        ring.material.color.set(
          isPinned ? 0xff1e00 : isSecondary ? 0x00d9ff : entry.group.userData.baseColor,
        );
        ring.material.opacity = isPinned || isSecondary ? 0.75 : 0.32;

        // Brake / DRS indicator lamps from telemetry.
        const tel = window.APEX.telemetryFor(s.driver.code, 0);
        entry.group.userData.brakeMat.opacity =
          Math.min(1, Math.max(0, (tel.brake || 0) / 60));
        entry.group.userData.drsMat.opacity = tel.drs ? 0.95 : 0.0;

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
        const outOfPlay = s.status === "OUT";
        for (const m of entry.group.userData.body) m.visible = !outOfPlay;
        for (const wh of entry.group.userData.wheels) wh.visible = !outOfPlay;
        entry.group.userData.compound.visible = !outOfPlay;
        const inPit = s.status === "PIT";
        for (const mat of entry.group.userData.bodyMats) {
          mat.transparent = true;
          mat.opacity = inPit ? 0.45 : 1;
        }
      }
      for (const [code, entry] of driverMap) {
        if (!seen.has(code)) {
          driverGroup.remove(entry.group);
          entry.label.remove();
          driverMap.delete(code);
        }
      }

      // --- Camera modes ---
      const inFollow = live.cameraMode === "follow" && !!live.pinned;
      // Target vignette state — settles by lerp at the bottom so the FX
      // doesn't snap when the camera mode changes.
      let targetVignetteStrength = preset.vignette.base;
      let targetVignetteRadius = 1.1;
      let chaseSpeedKph = 0;
      if (inFollow) {
        const pinnedStanding = standings.find((s) => s.driver.code === live.pinned);
        if (pinnedStanding) {
          chaseSpeedKph = pinnedStanding.speedKph || 0;
          const frac = pinnedStanding.fraction ?? 0;
          const u = ((frac % 1) + 1) % 1;
          const carPos = curve.getPointAt(u);
          curve.getTangentAt(u, tmpTan);
          const targetPos = carPos.clone()
            .addScaledVector(tmpTan, -CHASE_BEHIND)
            .add(new THREE.Vector3(0, CHASE_HEIGHT, 0));
          const targetLook = carPos.clone()
            .addScaledVector(tmpTan, CHASE_LOOKAHEAD)
            .add(new THREE.Vector3(0, 1.2, 0));
          const kPos = 1 - Math.exp(-CHASE_SMOOTH_POS * dt);
          const kLook = 1 - Math.exp(-CHASE_SMOOTH_LOOK * dt);
          if (!chase.initialised) {
            chase.pos.copy(targetPos);
            chase.look.copy(targetLook);
            chase.initialised = true;
          } else {
            chase.pos.lerp(targetPos, kPos);
            chase.look.lerp(targetLook, kLook);
          }
          camera.position.copy(chase.pos);
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
          camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-3 * dt));
          camera.updateProjectionMatrix();
        } else {
          povHud.root.style.display = "none";
        }
      } else {
        if (chase.initialised) {
          controls.target.copy(center);
          chase.initialised = false;
        }
        controls.enabled = true;
        controls.update();
        povHud.root.style.display = "none";
        // Reset chase-cam FOV when we leave follow.
        camera.fov += (50 - camera.fov) * (1 - Math.exp(-3 * dt));
        camera.updateProjectionMatrix();
      }

      // --- Weather ---
      const w = live.weather || {};
      const raining = w.rainState === "RAINING";
      rain.visible = raining;
      if (raining) {
        const wDeg = (w.windDirection || 0) + 180;
        const wRad = wDeg * Math.PI / 180;
        const wSpeed = (w.windSpeed || 0) * 0.2778;
        const windVec = new THREE.Vector3(Math.sin(wRad) * wSpeed, 0, -Math.cos(wRad) * wSpeed);
        advanceRain(rain, dt, windVec);
        // Wet asphalt — just darken the tint on the unlit track material.
        // (No env-map reflections since we're on MeshBasicMaterial now; a
        // proper wet sheen would need a different setup.)
        trackMat.color.setHex(trackWetColor);
        runoffMat.color.setHex(runoffWetColor);
        runoffMat.roughness = 0.55;
        runoffMat.metalness = 0.2;
        scene.fog.density = (preset.fog.densityScale * 2.4) / extent;
        // Slight bloom lift in rain — wet headlights/brake lights glow more.
        bloomPass.strength = preset.bloom.strength + 0.12;
        bloomPass.threshold = Math.max(0.7, preset.bloom.threshold - 0.1);
      } else {
        trackMat.color.setHex(trackDryColor);
        runoffMat.color.setHex(runoffDryColor);
        runoffMat.roughness = 0.92;
        runoffMat.metalness = 0;
        scene.fog.density = preset.fog.densityScale / extent;
        bloomPass.strength = preset.bloom.strength;
        bloomPass.threshold = preset.bloom.threshold;
      }

      // Smoothly settle vignette toward target each frame.
      const kV = 1 - Math.exp(-4 * dt);
      const vu = vignettePass.uniforms;
      vu.uStrength.value += (targetVignetteStrength - vu.uStrength.value) * kV;
      vu.uRadius.value   += (targetVignetteRadius   - vu.uRadius.value)   * kV;

      // --- Driver labels overlay ---
      if (live.showLabels && !inFollow) {
        labelLayer.style.display = "block";
        const w2 = renderer.domElement.clientWidth;
        const h2 = renderer.domElement.clientHeight;
        const vp = new THREE.Vector3();
        for (const [, entry] of driverMap) {
          const firstBody = entry.group.userData.body[0];
          if (!firstBody || !firstBody.visible) { entry.label.style.display = "none"; continue; }
          vp.copy(entry.group.position);
          vp.y += 3;
          vp.project(camera);
          if (vp.z < -1 || vp.z > 1) { entry.label.style.display = "none"; continue; }
          const px = (vp.x * 0.5 + 0.5) * w2;
          const py = (-vp.y * 0.5 + 0.5) * h2;
          entry.label.style.display = "block";
          entry.label.style.left = `${px}px`;
          entry.label.style.top = `${py}px`;
        }
      } else {
        labelLayer.style.display = "none";
      }

      } catch (err) {
        console.error('[Track3D animate]', err);
      }
      composer.render();
      rafId = requestAnimationFrame(animate);
    };
    rafId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener("click", onClick);
      for (const [, entry] of driverMap) entry.label.remove();
      labelLayer.remove();
      povHud.root.remove();
      composer.dispose();
      renderTarget.dispose();
      envTex.dispose();
      renderer.domElement.remove();
      renderer.dispose();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
    };
  }, [geoVersion, todKey]);

  return (
    <div ref={mountRef} style={{
      position: "absolute", inset: 0, overflow: "hidden",
    }}/>
  );
}

window.Track3D = Track3D;
