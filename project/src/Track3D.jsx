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

// Track dimensions (metres).
const TRACK_WIDTH = 14;
const RUNOFF_WIDTH = 32;
const KERB_WIDTH = 2.2;
const DRS_STRIPE_WIDTH = 1.8;
const Z_EXAGGERATION = 1.4;

// Car dimensions (metres). Slightly larger than real F1 (~5×2) so the body
// reads at wider zooms, but still honest enough for the chase cam.
const CAR_LENGTH = 6.0;
const CAR_WIDTH = 2.4;
const CAR_HEIGHT = 0.55;
const WHEEL_RADIUS = 0.45;
const WHEEL_WIDTH = 0.42;
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

function makeAsphaltTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  // Base tarmac tone.
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, "#2b2b37");
  grad.addColorStop(1, "#23232d");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  // Coarse grain — tiny specks of lighter/darker dust.
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 36;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  // A few longitudinal darker streaks to suggest tyre rubber/racing line.
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = "#12121a";
  for (let i = 0; i < 8; i++) {
    const x = Math.random() * size;
    const w = 1 + Math.random() * 2;
    ctx.fillRect(x, 0, w, size);
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function makeConcreteTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#181822";
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
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

// Ribbon of constant half-width along the curve. `yLift` puts layered ribbons
// (runoff, track, kerbs) on separate tiny y-planes to avoid z-fighting.
// `uvRepeat` controls how many times the texture tiles along the length.
function buildRibbonGeometry(curve, segments, halfWidth, yLift, uvRepeat = 80) {
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const indices = [];
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3();
  const tan = new THREE.Vector3();

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = curve.getPoint(t);
    curve.getTangent(t, tan);
    right.crossVectors(tan, up).normalize();
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

// Thin painted edge line (like white track boundaries) — a slab offset from
// the centerline by `offset` with a small `width`. Used for both inner and
// outer edge stripes.
function buildEdgeLineGeometry(curve, segments, offset, width, yLift) {
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const indices = [];
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const half = width * 0.5;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = curve.getPoint(t);
    curve.getTangent(t, tan);
    right.crossVectors(tan, up).normalize();
    const inner = offset - half, outer = offset + half;
    positions[i * 6 + 0] = p.x + right.x * inner;
    positions[i * 6 + 1] = p.y + yLift;
    positions[i * 6 + 2] = p.z + right.z * inner;
    positions[i * 6 + 3] = p.x + right.x * outer;
    positions[i * 6 + 4] = p.y + yLift;
    positions[i * 6 + 5] = p.z + right.z * outer;
    if (i < segments) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

// Red/white kerbs. STRIPE_SEGS = how many curve-segments span one colour band.
// At ~2000 segments round a 5 km track, 2 ≈ 5 m per stripe — matches real
// kerbing.
function buildKerbGeometry(curve, segments, innerOffset, outerOffset, side, yLift) {
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const colors = new Float32Array((segments + 1) * 2 * 3);
  const indices = [];
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const red = new THREE.Color(0xff1e00);
  const white = new THREE.Color(0xf4f4f8);
  const STRIPE_SEGS = 2;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = curve.getPoint(t);
    curve.getTangent(t, tan);
    right.crossVectors(tan, up).normalize();
    const inner = side * innerOffset, outer = side * outerOffset;
    positions[i * 6 + 0] = p.x + right.x * inner;
    positions[i * 6 + 1] = p.y + yLift;
    positions[i * 6 + 2] = p.z + right.z * inner;
    positions[i * 6 + 3] = p.x + right.x * outer;
    positions[i * 6 + 4] = p.y + yLift;
    positions[i * 6 + 5] = p.z + right.z * outer;
    const c = Math.floor(i / STRIPE_SEGS) % 2 === 0 ? red : white;
    colors[i * 6 + 0] = c.r; colors[i * 6 + 1] = c.g; colors[i * 6 + 2] = c.b;
    colors[i * 6 + 3] = c.r; colors[i * 6 + 4] = c.g; colors[i * 6 + 5] = c.b;
    if (i < segments) {
      const a = i * 2, b = i * 2 + 1, c2 = (i + 1) * 2, d = (i + 1) * 2 + 1;
      indices.push(a, c2, b, b, c2, d);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
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
  const tan = new THREE.Vector3();
  const inner = side * (TRACK_WIDTH + KERB_WIDTH + 0.4);
  const outer = side * (TRACK_WIDTH + KERB_WIDTH + 0.4 + DRS_STRIPE_WIDTH);
  for (let i = 0; i <= zoneSegs; i++) {
    const tu = i / zoneSegs;
    const u = (uStart + tu * span) % 1;
    const p = curve.getPointAt(u);
    curve.getTangentAt(u, tan);
    right.crossVectors(tan, up).normalize();
    positions[i * 6 + 0] = p.x + right.x * inner;
    positions[i * 6 + 1] = p.y + 0.14;
    positions[i * 6 + 2] = p.z + right.z * inner;
    positions[i * 6 + 3] = p.x + right.x * outer;
    positions[i * 6 + 4] = p.y + 0.14;
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
  });
  return new THREE.Mesh(geom, mat);
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
    p.x + right.x * -halfW - tan.x * depth * 0.5, p.y + 0.11, p.z + right.z * -halfW - tan.z * depth * 0.5,
    p.x + right.x *  halfW - tan.x * depth * 0.5, p.y + 0.11, p.z + right.z *  halfW - tan.z * depth * 0.5,
    p.x + right.x * -halfW + tan.x * depth * 0.5, p.y + 0.11, p.z + right.z * -halfW + tan.z * depth * 0.5,
    p.x + right.x *  halfW + tan.x * depth * 0.5, p.y + 0.11, p.z + right.z *  halfW + tan.z * depth * 0.5,
  ]);
  const indices = [0, 2, 1, 1, 2, 3];
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
  return new THREE.Mesh(geom, mat);
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
    ctx.fillStyle = i % 2 ? "#ffffff" : "#0b0b11";
    ctx.fillRect(0, i * 4, 8, 4);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 4);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  const mesh = new THREE.Mesh(planeGeom, mat);
  mesh.position.set(p.x, p.y + 0.13, p.z);
  mesh.rotation.y = Math.atan2(-tan.z, tan.x);
  return mesh;
}

function buildRacingLineMesh(curve, segments) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const p = curve.getPoint(i / segments);
    pts.push(new THREE.Vector3(p.x, p.y + 0.09, p.z));
  }
  const geom = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineDashedMaterial({
    color: 0x7a7a90, dashSize: 6, gapSize: 10, transparent: true, opacity: 0.4,
  });
  const line = new THREE.Line(geom, mat);
  line.computeLineDistances();
  return line;
}

// ───────────────────────────────────────────────────────────────────────────
// Car marker — stylised F1 built from primitives. Exposes `userData` hooks
// so the animate loop can toggle brake/DRS lights and halo state cheaply.
// Local coord frame: +X is forward, +Y up, +Z right.
// ───────────────────────────────────────────────────────────────────────────

function makeDriverMarker(team) {
  const g = new THREE.Group();
  const color = new THREE.Color(team?.color || "#ff1e00");
  const bodyMat = new THREE.MeshStandardMaterial({
    color, roughness: 0.55, metalness: 0.25, emissive: color, emissiveIntensity: 0.08,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x0e0e14, roughness: 0.75, metalness: 0.1,
  });
  const tyreMat = new THREE.MeshStandardMaterial({
    color: 0x16161c, roughness: 0.9, metalness: 0.02,
  });

  // Floor + sidepod-ish main body — a low flat slab that tapers slightly at
  // the nose via two boxes stacked ahead of the cockpit.
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(CAR_LENGTH, 0.3, CAR_WIDTH * 0.9),
    bodyMat,
  );
  floor.position.y = 0.25;
  g.add(floor);

  const sidepods = new THREE.Mesh(
    new THREE.BoxGeometry(CAR_LENGTH * 0.55, 0.55, CAR_WIDTH * 0.85),
    bodyMat,
  );
  sidepods.position.set(-CAR_LENGTH * 0.05, 0.55, 0);
  g.add(sidepods);

  // Nose cone — tapered box reading as the survival cell + nose.
  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(CAR_LENGTH * 0.45, 0.3, CAR_WIDTH * 0.3),
    bodyMat,
  );
  nose.position.set(CAR_LENGTH * 0.38, 0.4, 0);
  g.add(nose);

  // Airbox / rollhoop.
  const airbox = new THREE.Mesh(
    new THREE.BoxGeometry(CAR_LENGTH * 0.2, 0.55, CAR_WIDTH * 0.3),
    bodyMat,
  );
  airbox.position.set(-CAR_LENGTH * 0.1, 1.0, 0);
  g.add(airbox);

  // Halo around the cockpit — tiny dark arch.
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.35, 0.04, 6, 12, Math.PI),
    darkMat,
  );
  halo.position.set(-CAR_LENGTH * 0.02, 0.95, 0);
  halo.rotation.x = Math.PI * 0.5;
  halo.rotation.y = Math.PI * 0.5;
  g.add(halo);

  // Front wing — thin plate ahead of the nose.
  const frontWing = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.08, CAR_WIDTH * 1.1),
    darkMat,
  );
  frontWing.position.set(CAR_LENGTH * 0.55, 0.25, 0);
  g.add(frontWing);

  // Rear wing — taller, two vertical endplates + top flap.
  const rearWingFlap = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.14, CAR_WIDTH),
    darkMat,
  );
  rearWingFlap.position.set(-CAR_LENGTH * 0.55, 1.0, 0);
  g.add(rearWingFlap);
  const rearEndplateL = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.9, 0.08),
    darkMat,
  );
  rearEndplateL.position.set(-CAR_LENGTH * 0.55, 0.58, -CAR_WIDTH * 0.5);
  g.add(rearEndplateL);
  const rearEndplateR = rearEndplateL.clone();
  rearEndplateR.position.z = CAR_WIDTH * 0.5;
  g.add(rearEndplateR);

  // DRS indicator — a thin strip on the top of the rear wing that lights up
  // blue when in_drs is true.
  const drsMat = new THREE.MeshBasicMaterial({
    color: 0x00d9ff, transparent: true, opacity: 0.0,
  });
  const drsLamp = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.08, CAR_WIDTH * 0.75),
    drsMat,
  );
  drsLamp.position.set(-CAR_LENGTH * 0.57, 1.12, 0);
  g.add(drsLamp);

  // Brake lights — twin red squares at the rear under the wing.
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

  // Four wheels. CylinderGeometry is upright by default — rotate onto its
  // side then orient the car in the scene via the group's Y rotation.
  const wheelPositions = [
    [  CAR_LENGTH * 0.3, -CAR_WIDTH * 0.55],
    [  CAR_LENGTH * 0.3,  CAR_WIDTH * 0.55],
    [ -CAR_LENGTH * 0.3, -CAR_WIDTH * 0.55],
    [ -CAR_LENGTH * 0.3,  CAR_WIDTH * 0.55],
  ];
  const wheelGeom = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, 18);
  wheelGeom.rotateX(Math.PI / 2);
  const wheels = [];
  for (const [wx, wz] of wheelPositions) {
    const w = new THREE.Mesh(wheelGeom, tyreMat);
    w.position.set(wx, WHEEL_RADIUS, wz);
    g.add(w);
    wheels.push(w);
  }

  // Ground halo — always-visible marker, decoupled from car dimensions.
  const haloGeom = new THREE.RingGeometry(HALO_RADIUS * 0.75, HALO_RADIUS, 36);
  haloGeom.rotateX(-Math.PI / 2);
  const haloMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.38, depthWrite: false,
  });
  const groundHalo = new THREE.Mesh(haloGeom, haloMat);
  groundHalo.position.y = 0.02;
  g.add(groundHalo);

  // Tyre compound indicator — a small coloured dot floating above the airbox.
  const compGeom = new THREE.SphereGeometry(0.32, 10, 8);
  const compMat = new THREE.MeshBasicMaterial({ color: 0xffd93a });
  const compound = new THREE.Mesh(compGeom, compMat);
  compound.position.set(-CAR_LENGTH * 0.05, 1.9, 0);
  g.add(compound);

  g.userData = {
    body: [floor, sidepods, nose, airbox, rearWingFlap, rearEndplateL, rearEndplateR, frontWing],
    bodyMats: [bodyMat, darkMat],
    wheels, groundHalo, compound,
    drsLamp, drsMat,
    brakeL, brakeR, brakeMat,
    baseColor: color.clone(),
  };
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

function buildSkyDome(radius) {
  const geom = new THREE.SphereGeometry(radius, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.55);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top:    { value: new THREE.Color(0x0a0c14) },
      bottom: { value: new THREE.Color(0x1e1528) },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      varying vec3 vWorld;
      uniform vec3 top;
      uniform vec3 bottom;
      void main() {
        float h = clamp(vWorld.y / ${(radius).toFixed(1)}, 0.0, 1.0);
        gl_FragColor = vec4(mix(bottom, top, h), 1.0);
      }
    `,
  });
  return new THREE.Mesh(geom, mat);
}

// A ring of randomly-sized low-poly boxes around the track's outer bbox,
// suggesting grandstands / outer facilities without needing real models.
// Blobby and imprecise on purpose — only visible as silhouettes through fog.
function buildGrandstandRing(center, extent, yBase) {
  const g = new THREE.Group();
  const radius = extent * 1.1;
  const count = 64;
  const baseColor = new THREE.Color(0x1a1a22);
  const accentColor = new THREE.Color(0x2a2230);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const jitter = 1 + (Math.random() - 0.5) * 0.25;
    const r = radius * jitter;
    const h = 6 + Math.random() * 14;
    const w = 30 + Math.random() * 70;
    const d = 18 + Math.random() * 40;
    const col = Math.random() > 0.75 ? accentColor : baseColor;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshBasicMaterial({ color: col }),
    );
    m.position.set(
      center.x + Math.cos(a) * r,
      yBase + h * 0.5,
      center.z + Math.sin(a) * r,
    );
    m.rotation.y = -a + Math.PI * 0.5 + (Math.random() - 0.5) * 0.3;
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
}) {
  const mountRef = React.useRef(null);
  const liveRef = React.useRef({ standings, pinned, secondary, cameraMode, weather, showLabels });
  liveRef.current = { standings, pinned, secondary, cameraMode, weather, showLabels };

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
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0c14);

    const hemi = new THREE.HemisphereLight(0xb0c4ff, 0x14141c, 0.9);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffe5c2, 1.0);
    sun.position.set(800, 1200, 600);
    scene.add(sun);

    // --- Curve ---
    const scale = detectUnitScale(circuit);
    let zMin = Infinity;
    for (const p of circuit) {
      const z = Number(p?.z ?? 0);
      if (Number.isFinite(z) && z < zMin) zMin = z;
    }
    if (!isFinite(zMin)) zMin = 0;
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

    scene.fog = new THREE.FogExp2(0x0a0c14, 1.2 / extent);

    const sky = buildSkyDome(extent * 4);
    sky.position.copy(center);
    scene.add(sky);

    // Distant grandstand / facility silhouettes.
    const standsY = bb.min.y - 0.4;
    scene.add(buildGrandstandRing(center, extent, standsY));

    // Ground plane with concrete noise texture.
    const concreteTex = makeConcreteTexture();
    concreteTex.repeat.set(extent / 40, extent / 40);
    const groundSize = extent * 6;
    const groundGeom = new THREE.PlaneGeometry(groundSize, groundSize, 1, 1);
    groundGeom.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a22, map: concreteTex, roughness: 0.95, metalness: 0,
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.position.set(center.x, bb.min.y - 0.5, center.z);
    scene.add(ground);

    // Runoff band (wide, asphalt).
    const runoffTex = makeConcreteTexture();
    runoffTex.repeat.set(2, 120);
    const runoffGeom = buildRibbonGeometry(curve, segments, RUNOFF_WIDTH, 0.02, 120);
    const runoffMat = new THREE.MeshStandardMaterial({
      color: 0x272732, map: runoffTex, roughness: 0.95, metalness: 0,
    });
    const runoff = new THREE.Mesh(runoffGeom, runoffMat);
    scene.add(runoff);

    // Main track surface.
    const asphaltTex = makeAsphaltTexture();
    asphaltTex.repeat.set(1, Math.max(40, extent / 60));
    const trackGeom = buildRibbonGeometry(curve, segments, TRACK_WIDTH, 0.08, Math.max(40, extent / 60));
    const trackMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: asphaltTex, roughness: 0.88, metalness: 0.06,
    });
    const track = new THREE.Mesh(trackGeom, trackMat);
    scene.add(track);

    // White edge lines just inside each kerb.
    const edgeMat = new THREE.MeshBasicMaterial({
      color: 0xdcdce4, transparent: true, opacity: 0.75,
    });
    const edgeL = new THREE.Mesh(
      buildEdgeLineGeometry(curve, segments, -(TRACK_WIDTH - 0.25), 0.25, 0.1),
      edgeMat,
    );
    const edgeR = new THREE.Mesh(
      buildEdgeLineGeometry(curve, segments, +(TRACK_WIDTH - 0.25), 0.25, 0.1),
      edgeMat,
    );
    scene.add(edgeL); scene.add(edgeR);

    // Kerbs.
    const kerbL = new THREE.Mesh(
      buildKerbGeometry(curve, segments, TRACK_WIDTH, TRACK_WIDTH + KERB_WIDTH, -1, 0.12),
      new THREE.MeshBasicMaterial({ vertexColors: true }),
    );
    const kerbR = new THREE.Mesh(
      buildKerbGeometry(curve, segments, TRACK_WIDTH, TRACK_WIDTH + KERB_WIDTH, +1, 0.12),
      new THREE.MeshBasicMaterial({ vertexColors: true }),
    );
    scene.add(kerbL); scene.add(kerbR);

    // DRS zones — green stripes on the outer side of each zone.
    for (const z of window.APEX.DRS_ZONES || []) {
      scene.add(buildDRSZoneMesh(curve, segments, circuit.length, z, +1));
      scene.add(buildDRSZoneMesh(curve, segments, circuit.length, z, -1));
    }

    // Sector boundary gates.
    for (const s of window.APEX.SECTORS || []) {
      if (s.idx == null) continue;
      scene.add(buildSectorGate(curve, circuit.length, s.idx, s.color || "#f4f4f8"));
    }

    // Racing line + start/finish.
    scene.add(buildRacingLineMesh(curve, segments));
    scene.add(buildStartFinishMesh(curve, TRACK_WIDTH));

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
    mount.appendChild(renderer.domElement);
    Object.assign(renderer.domElement.style, {
      position: "absolute", inset: "0", width: "100%", height: "100%",
      display: "block",
    });

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
        entry.group.position.set(p.x, p.y + 0.15, p.z);
        entry.group.rotation.y = Math.atan2(-tmpTan.z, tmpTan.x);

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
        const speedMps = (s.speedKph || 0) / 3.6;
        const spinDelta = (speedMps / WHEEL_RADIUS) * dt;
        for (const wh of entry.group.userData.wheels) wh.rotation.x += spinDelta;

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
      if (inFollow) {
        const pinnedStanding = standings.find((s) => s.driver.code === live.pinned);
        if (pinnedStanding) {
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
        trackMat.color.setHex(0x1a1a22);
        trackMat.roughness = 0.45;
        trackMat.metalness = 0.35;
        runoffMat.color.setHex(0x13131a);
        scene.fog.density = 2.2 / extent;
      } else {
        trackMat.color.setHex(0xffffff); // white so asphalt texture shows full tone
        trackMat.roughness = 0.88;
        trackMat.metalness = 0.06;
        runoffMat.color.setHex(0x272732);
        scene.fog.density = 1.2 / extent;
      }

      // --- Driver labels overlay ---
      if (live.showLabels && !inFollow) {
        labelLayer.style.display = "block";
        const w2 = renderer.domElement.clientWidth;
        const h2 = renderer.domElement.clientHeight;
        const vp = new THREE.Vector3();
        for (const [, entry] of driverMap) {
          const firstBody = entry.group.userData.body[0];
          if (!firstBody.visible) { entry.label.style.display = "none"; continue; }
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

      renderer.render(scene, camera);
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
  }, [geoVersion]);

  return (
    <div ref={mountRef} style={{
      position: "absolute", inset: 0, overflow: "hidden",
    }}/>
  );
}

window.Track3D = Track3D;
