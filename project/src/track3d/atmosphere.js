import * as THREE from "three";

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

export {
  TOD_PRESETS,
  WET_OVERLAY,
  mulHex,
  mulHexLumaFloor,
  detectTimeOfDay,
  buildSkyDome,
  buildStarField,
  buildStadiumLights,
  buildHorizonHills,
  buildGrandstands,
  sampleTrackFrameAt,
  makeTracksidePlacard,
  makeMarshalPanel,
  buildRain,
  advanceRain,
};
