// WebGL / Three.js track view. Replaces IsoTrack for the "iso" (3D) mode.
// - Real 3D extruded track ribbon with elevation (FastF1 Z column)
// - Orbit camera + Follow cam (tracks the pinned driver in third-person)
// - Weather layer: rain particles driven by frame.weather.rain_state + wind_*,
//   wet-track darkening, sky color shift, exponential fog.
//
// The scene is (re)built when window.APEX.CIRCUIT changes length (i.e. when
// the WS snapshot arrives). Per-frame data (car positions, weather) is pushed
// into refs and consumed inside the animation loop so React never re-renders
// the canvas.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const TRACK_WIDTH = 14;      // metres — visible track ribbon
const RUNOFF_WIDTH = 28;     // metres — asphalt runoff band
const KERB_WIDTH = 2.2;      // metres
const CAR_RADIUS = 4.5;      // metres — driver dot
const Z_EXAGGERATION = 2.2;  // amplify elevation so Spa/Austria read on screen

// FastF1 PositionData X/Y/Z are in 1/10 mm. Detect by magnitude and convert
// to metres. If coords already look like metres (< ~500k units wide), skip.
function detectUnitScale(circuit) {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const p of circuit) {
    if (p.x < xmin) xmin = p.x; if (p.x > xmax) xmax = p.x;
    if (p.y < ymin) ymin = p.y; if (p.y > ymax) ymax = p.y;
  }
  const diag = Math.hypot(xmax - xmin, ymax - ymin);
  return diag > 500000 ? 0.0001 : 1;
}

// Map FastF1 world (X east, Y north, Z up) -> Three.js (Y up, -Z forward),
// in metres, with elevation baseline removed so the track sits near y=0.
function toThree(p, zBase, scale) {
  return new THREE.Vector3(
    p.x * scale,
    ((p.z || 0) * scale - zBase) * Z_EXAGGERATION,
    -p.y * scale,
  );
}

function buildCenterlineCurve(circuit, zBase, scale) {
  const pts = circuit.map((p) => toThree(p, zBase, scale));
  const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal", 0.5);
  return curve;
}

// Build a twisted ribbon along the curve: for each sample, place two vertices at
// +/- halfWidth along the local right vector (tangent x up). `up` is world up,
// which keeps the ribbon flat in the banking axis. Good enough for first cut.
function buildRibbonGeometry(curve, segments, halfWidth) {
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const indices = [];
  const up = new THREE.Vector3(0, 1, 0);
  const tmpRight = new THREE.Vector3();
  const tmpTan = new THREE.Vector3();

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = curve.getPoint(t);
    curve.getTangent(t, tmpTan);
    tmpRight.crossVectors(tmpTan, up).normalize();
    const lx = p.x - tmpRight.x * halfWidth;
    const ly = p.y - tmpRight.y * halfWidth + 0.02; // tiny lift to avoid z-fighting with runoff
    const lz = p.z - tmpRight.z * halfWidth;
    const rx = p.x + tmpRight.x * halfWidth;
    const ry = p.y + tmpRight.y * halfWidth + 0.02;
    const rz = p.z + tmpRight.z * halfWidth;
    positions[i * 6 + 0] = lx; positions[i * 6 + 1] = ly; positions[i * 6 + 2] = lz;
    positions[i * 6 + 3] = rx; positions[i * 6 + 4] = ry; positions[i * 6 + 5] = rz;
    uvs[i * 4 + 0] = 0; uvs[i * 4 + 1] = t * 40;
    uvs[i * 4 + 2] = 1; uvs[i * 4 + 3] = t * 40;

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

// Checker pattern for kerbs — alternating colors along the length.
function buildKerbGeometry(curve, segments, innerOffset, outerOffset, side) {
  // side: +1 for right kerb (outer), -1 for left kerb. innerOffset/outerOffset are metres from centerline.
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const colors = new Float32Array((segments + 1) * 2 * 3);
  const indices = [];
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const red = new THREE.Color(0xff1e00);
  const white = new THREE.Color(0xf4f4f8);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = curve.getPoint(t);
    curve.getTangent(t, tan);
    right.crossVectors(tan, up).normalize();
    const inner = side * innerOffset, outer = side * outerOffset;
    positions[i * 6 + 0] = p.x + right.x * inner;
    positions[i * 6 + 1] = p.y + right.y * inner + 0.03;
    positions[i * 6 + 2] = p.z + right.z * inner;
    positions[i * 6 + 3] = p.x + right.x * outer;
    positions[i * 6 + 4] = p.y + right.y * outer + 0.03;
    positions[i * 6 + 5] = p.z + right.z * outer;
    const c = Math.floor(t * segments / 4) % 2 === 0 ? red : white;
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

function buildStartFinishMesh(curve, halfWidth) {
  // Small checkered band at t=0.
  const t = 0;
  const p = curve.getPoint(t);
  const tan = new THREE.Vector3();
  curve.getTangent(t, tan);
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(tan, up).normalize();
  const planeGeom = new THREE.PlaneGeometry(halfWidth * 2, 4, 8, 2);
  planeGeom.rotateX(-Math.PI / 2);
  const canvas = document.createElement("canvas");
  canvas.width = 64; canvas.height = 8;
  const ctx = canvas.getContext("2d");
  for (let i = 0; i < 16; i++) {
    ctx.fillStyle = i % 2 ? "#ffffff" : "#0b0b11";
    ctx.fillRect(i * 4, 0, 4, 8);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 1);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  const mesh = new THREE.Mesh(planeGeom, mat);
  mesh.position.set(p.x, p.y + 0.05, p.z);
  const yaw = Math.atan2(tan.z, tan.x);
  mesh.rotation.y = -yaw;
  return mesh;
}

function buildRacingLineMesh(curve, segments) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const p = curve.getPoint(i / segments);
    pts.push(new THREE.Vector3(p.x, p.y + 0.05, p.z));
  }
  const geom = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineDashedMaterial({
    color: 0x5a5a70, linewidth: 1, dashSize: 6, gapSize: 8, transparent: true, opacity: 0.55,
  });
  const line = new THREE.Line(geom, mat);
  line.computeLineDistances();
  return line;
}

function makeDriverSprite(team) {
  // Car marker: circular disc with team color, glowing halo, facing upward.
  // We use a Group so the halo can pulse independently.
  const g = new THREE.Group();
  const discGeom = new THREE.CircleGeometry(CAR_RADIUS, 20);
  discGeom.rotateX(-Math.PI / 2);
  const teamCol = new THREE.Color(team?.color || "#ff1e00");
  const discMat = new THREE.MeshBasicMaterial({ color: teamCol });
  const disc = new THREE.Mesh(discGeom, discMat);
  g.add(disc);

  const ringGeom = new THREE.RingGeometry(CAR_RADIUS + 0.5, CAR_RADIUS + 1.2, 24);
  ringGeom.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({ color: teamCol, transparent: true, opacity: 0.6 });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.position.y = 0.05;
  g.add(ring);

  // Arrow indicator for heading.
  const arrowGeom = new THREE.ConeGeometry(2, 4, 4);
  arrowGeom.rotateZ(-Math.PI / 2);
  arrowGeom.rotateY(-Math.PI / 2);
  const arrow = new THREE.Mesh(arrowGeom, new THREE.MeshBasicMaterial({ color: 0x0b0b11 }));
  arrow.position.set(CAR_RADIUS + 1.5, 0.2, 0);
  g.add(arrow);

  g.userData.disc = disc;
  g.userData.ring = ring;
  g.userData.arrow = arrow;
  g.userData.baseColor = teamCol;
  return g;
}

// HTML label overlay. Uses a separate DOM node that we transform each frame.
// Cheaper than CSS2DRenderer for just driver codes.
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

// --- Rain particle system ---
function buildRain(bbox) {
  const COUNT = 3500;
  const positions = new Float32Array(COUNT * 3);
  const velocities = new Float32Array(COUNT * 3);
  const spanX = bbox.sx * 1.4, spanZ = bbox.sz * 1.4;
  for (let i = 0; i < COUNT; i++) {
    positions[i * 3 + 0] = bbox.cx + (Math.random() - 0.5) * spanX;
    positions[i * 3 + 1] = bbox.cy + Math.random() * 180 + 20;
    positions[i * 3 + 2] = bbox.cz + (Math.random() - 0.5) * spanZ;
    velocities[i * 3 + 0] = 0;
    velocities[i * 3 + 1] = -(60 + Math.random() * 40); // m/s downward
    velocities[i * 3 + 2] = 0;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xb8cfe4, size: 0.9, transparent: true, opacity: 0.7,
    depthWrite: false,
  });
  const pts = new THREE.Points(geom, mat);
  pts.userData = { velocities, bbox, count: COUNT };
  pts.visible = false;
  return pts;
}

function advanceRain(rain, dt, windVec) {
  if (!rain.visible) return;
  const positions = rain.geometry.attributes.position.array;
  const vels = rain.userData.velocities;
  const bbox = rain.userData.bbox;
  const spanX = bbox.sx * 1.4, spanZ = bbox.sz * 1.4;
  for (let i = 0; i < rain.userData.count; i++) {
    positions[i * 3 + 0] += (vels[i * 3 + 0] + windVec.x) * dt;
    positions[i * 3 + 1] += vels[i * 3 + 1] * dt;
    positions[i * 3 + 2] += (vels[i * 3 + 2] + windVec.z) * dt;
    if (positions[i * 3 + 1] < bbox.cy - 5) {
      positions[i * 3 + 0] = bbox.cx + (Math.random() - 0.5) * spanX;
      positions[i * 3 + 1] = bbox.cy + 150 + Math.random() * 40;
      positions[i * 3 + 2] = bbox.cz + (Math.random() - 0.5) * spanZ;
    }
  }
  rain.geometry.attributes.position.needsUpdate = true;
}

function pickDriverPoint(curve, fraction) {
  const t = ((fraction % 1) + 1) % 1;
  return curve.getPointAt(t);
}

function Track3D({
  standings,
  pinned,
  secondary,
  onPickDriver,
  showLabels = true,
  cameraMode = "orbit",   // "orbit" | "follow"
  weather = null,          // { rainState, windSpeed, windDirection, trackTemp, airTemp }
}) {
  const mountRef = React.useRef(null);
  const stateRef = React.useRef({});
  const liveRef = React.useRef({ standings, pinned, secondary, cameraMode, weather, showLabels });

  // Push the latest props into a ref the animation loop reads from.
  liveRef.current = { standings, pinned, secondary, cameraMode, weather, showLabels };

  // Track geometry version — bumps whenever CIRCUIT changes length (snapshot arrival).
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

    // --- Scene ---
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05050a);
    scene.fog = new THREE.FogExp2(0x05050a, 0.0006);

    // Lights
    const hemi = new THREE.HemisphereLight(0xb0c4ff, 0x14141c, 0.75);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffe5c2, 0.8);
    sun.position.set(2000, 3000, 1500);
    scene.add(sun);

    // --- Build curve from CIRCUIT ---
    // Normalize Z so the whole track sits near y=0 (prevents extreme fog/clipping).
    let zMin = Infinity;
    for (const p of circuit) { const z = p.z || 0; if (z < zMin) zMin = z; }
    if (!isFinite(zMin)) zMin = 0;
    const curve = buildCenterlineCurve(circuit, zMin);
    const segments = Math.max(400, circuit.length * 2);

    // Bounding box for camera placement + rain volume
    const bb = new THREE.Box3();
    const pts = curve.getPoints(segments);
    for (const p of pts) bb.expandByPoint(p);
    const center = bb.getCenter(new THREE.Vector3());
    const size = bb.getSize(new THREE.Vector3());
    const bboxInfo = {
      cx: center.x, cy: center.y, cz: center.z,
      sx: Math.max(size.x, 300), sz: Math.max(size.z, 300),
    };

    // Ground plane — dark, slightly below track min Y.
    const groundSize = Math.max(size.x, size.z) * 2.4;
    const groundGeom = new THREE.PlaneGeometry(groundSize, groundSize, 1, 1);
    groundGeom.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x0e0e16, roughness: 0.95, metalness: 0,
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.position.set(center.x, bb.min.y - 0.8, center.z);
    scene.add(ground);

    // Runoff band (wide)
    const runoffGeom = buildRibbonGeometry(curve, segments, RUNOFF_WIDTH);
    const runoffMat = new THREE.MeshStandardMaterial({
      color: 0x23232f, roughness: 0.95, metalness: 0,
    });
    const runoff = new THREE.Mesh(runoffGeom, runoffMat);
    scene.add(runoff);

    // Track surface (narrow, on top)
    const trackGeom = buildRibbonGeometry(curve, segments, TRACK_WIDTH);
    const trackMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a38, roughness: 0.9, metalness: 0.05,
    });
    const track = new THREE.Mesh(trackGeom, trackMat);
    scene.add(track);

    // Kerbs — on both sides, just outside the track edge.
    const kerbL = new THREE.Mesh(
      buildKerbGeometry(curve, segments, TRACK_WIDTH, TRACK_WIDTH + KERB_WIDTH, -1),
      new THREE.MeshBasicMaterial({ vertexColors: true })
    );
    const kerbR = new THREE.Mesh(
      buildKerbGeometry(curve, segments, TRACK_WIDTH, TRACK_WIDTH + KERB_WIDTH, +1),
      new THREE.MeshBasicMaterial({ vertexColors: true })
    );
    scene.add(kerbL); scene.add(kerbR);

    // Racing line + S/F
    scene.add(buildRacingLineMesh(curve, segments));
    scene.add(buildStartFinishMesh(curve, TRACK_WIDTH));

    // --- Rain ---
    const rain = buildRain(bboxInfo);
    scene.add(rain);

    // --- Camera + controls ---
    const camera = new THREE.PerspectiveCamera(50, 1, 1, 100000);
    const diag = Math.max(size.x, size.z) * 0.9;
    camera.position.set(center.x + diag, diag * 0.6, center.z + diag);
    camera.lookAt(center);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio);
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
    controls.minDistance = 30;
    controls.maxDistance = diag * 3;
    controls.maxPolarAngle = Math.PI * 0.49;

    const labelLayer = makeLabelLayer(mount);

    // --- Driver meshes (dynamic) ---
    const driverGroup = new THREE.Group();
    scene.add(driverGroup);
    const driverMap = new Map(); // code -> { group, label }
    const followState = { pos: new THREE.Vector3(), tan: new THREE.Vector3(0, 0, 1) };

    // Click picking
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    renderer.domElement.addEventListener("click", (e) => {
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
    });

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

    // --- Animation loop ---
    let rafId;
    let lastT = performance.now();
    const animate = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastT) / 1000);
      lastT = now;
      const live = liveRef.current;

      // Reconcile drivers
      const seen = new Set();
      const standings = live.standings || [];
      for (const s of standings) {
        seen.add(s.driver.code);
        let entry = driverMap.get(s.driver.code);
        if (!entry) {
          const g = makeDriverSprite(window.APEX.TEAMS[s.driver.team]);
          g.userData.driverCode = s.driver.code;
          driverGroup.add(g);
          const label = makeLabel(s.driver.code, window.APEX.TEAMS[s.driver.team]?.color || "#ff1e00");
          labelLayer.appendChild(label);
          entry = { group: g, label };
          driverMap.set(s.driver.code, entry);
        }
        const frac = s.fraction != null ? s.fraction : 0;
        const u = ((frac % 1) + 1) % 1;
        const p = curve.getPointAt(u);
        entry.group.position.set(p.x, p.y + 0.15, p.z);
        // Heading — orient the group so local +X aligns with the tangent.
        const tan = curve.getTangentAt(u);
        entry.group.rotation.y = Math.atan2(-tan.z, tan.x);
        // Selection highlighting
        const isPinned = live.pinned === s.driver.code;
        const isSecondary = live.secondary === s.driver.code;
        const ring = entry.group.userData.ring;
        ring.scale.setScalar(isPinned || isSecondary ? 1.6 : 1);
        ring.material.color.set(isPinned ? 0xff1e00 : (isSecondary ? 0x00d9ff : entry.group.userData.baseColor));
        ring.material.opacity = isPinned || isSecondary ? 0.95 : 0.55;
        // Pit / OUT
        entry.group.visible = s.status !== "OUT";
        entry.group.userData.disc.material.opacity = s.status === "PIT" ? 0.45 : 1;
        entry.group.userData.disc.material.transparent = true;
      }
      // Remove drivers not present
      for (const [code, entry] of driverMap) {
        if (!seen.has(code)) {
          driverGroup.remove(entry.group);
          entry.label.remove();
          driverMap.delete(code);
        }
      }

      // --- Camera modes ---
      if (live.cameraMode === "follow" && live.pinned) {
        const entry = driverMap.get(live.pinned);
        if (entry) {
          // Follow behind + above the car, along its tangent.
          const pinnedEntry = standings.find((s) => s.driver.code === live.pinned);
          const frac = pinnedEntry?.fraction ?? 0;
          const t = ((frac % 1) + 1) % 1;
          const carPos = curve.getPointAt(t);
          const tan = curve.getTangentAt(t);
          const behind = tan.clone().multiplyScalar(-60);
          followState.pos.lerp(carPos.clone().add(behind).add(new THREE.Vector3(0, 22, 0)), 0.18);
          camera.position.copy(followState.pos);
          const lookAhead = tan.clone().multiplyScalar(40);
          camera.lookAt(carPos.clone().add(lookAhead));
          controls.enabled = false;
        }
      } else {
        controls.enabled = true;
        controls.update();
      }

      // --- Weather ---
      const w = live.weather || {};
      const raining = w.rainState === "RAINING";
      rain.visible = raining;
      if (raining) {
        // Wind: speed (m/s ≈ km/h * 0.2778), direction is degrees meteorological (from).
        // Blowing-to direction = from + 180. Build a horizontal drift vector.
        const wDeg = (w.windDirection || 0) + 180;
        const wRad = wDeg * Math.PI / 180;
        const wSpeed = (w.windSpeed || 0) * 0.2778;
        const windVec = new THREE.Vector3(Math.sin(wRad) * wSpeed, 0, -Math.cos(wRad) * wSpeed);
        advanceRain(rain, dt, windVec);
        // Wet-track darkening + sheen
        trackMat.color.setHex(0x13131a);
        trackMat.roughness = 0.45;
        trackMat.metalness = 0.35;
        runoffMat.color.setHex(0x11111a);
        scene.fog.density = 0.0020;
        scene.background.setHex(0x0a0c14);
      } else {
        trackMat.color.setHex(0x2a2a38);
        trackMat.roughness = 0.9;
        trackMat.metalness = 0.05;
        runoffMat.color.setHex(0x23232f);
        scene.fog.density = 0.0006;
        scene.background.setHex(0x05050a);
      }

      // --- Labels (HTML overlay) ---
      if (live.showLabels) {
        labelLayer.style.display = "block";
        const w2 = renderer.domElement.clientWidth;
        const h2 = renderer.domElement.clientHeight;
        const vp = new THREE.Vector3();
        for (const [, entry] of driverMap) {
          if (!entry.group.visible) { entry.label.style.display = "none"; continue; }
          vp.copy(entry.group.position);
          vp.y += 6;
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

    // --- Cleanup ---
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.dispose();
      for (const [, entry] of driverMap) entry.label.remove();
      labelLayer.remove();
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
