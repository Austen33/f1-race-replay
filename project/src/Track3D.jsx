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
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import {
  TRACK_WIDTH,
  RUNOFF_WIDTH,
  KERB_WIDTH,
  WHEEL_RADIUS,
  CAR_SURFACE_CLEARANCE,
  makeAsphaltTexture,
  makeRunoffAsphaltTexture,
  makeGrassTexture,
  makeGravelTexture,
  makeArmcoTexture,
  makeAsphaltNormalMap,
  makeKerbStripeTexture,
  cachedTex,
  getRoomEnvironment,
  clearRoomEnvironmentCache,
  makeLabelLayer,
  makeLabel,
  setLabelStatus,
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
  buildWheelHud,
  createWheelHudAttachment,
  buildWheelHudDebugPanel,
  buildPovHud,
  updatePovHud,
  detectUnitScale,
  buildCenterlineCurve,
  buildPartialEdgeLineGeometry,
  buildVerticalRibbonGeometry,
  buildCornerRanges,
  buildExtrudedRibbonGeometry,
  buildEdgeLineGeometry,
  buildDRSZoneMesh,
  buildSectorGate,
  buildStartFinishMesh,
  buildRacingLineMesh,
  buildTerrainGeometry,
  buildTrackEmbankmentGeometry,
  makeDriverMarker,
  makeSafetyCarMarker,
} from "./track3d/index.js";

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

const TRACK3D_POV_TUNE = Object.freeze({
  eyeForward: 0.430,
  eyeRight: 0.000,
  upDown: -1.170,
  eyeHeight: 3.100,
  lookAhead: 64.000,
  lookHeight: -0.020,
  baseFov: 75.000,
});







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
  // Live frame ref — refreshed every render so the RAF loop can read the
  // current frame without stale-closure issues. The hook lives on window.LIVE
  // and returns null until the WebSocket has produced a snapshot/frame.
  const _live = window.LIVE?.useLive ? window.LIVE.useLive() : null;
  const frameRef = React.useRef(_live?.frame || null);
  frameRef.current = _live?.frame || null;
  const snapshotRef = React.useRef(_live?.snapshot || null);
  snapshotRef.current = _live?.snapshot || null;
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
    const grassBlendColor = debugLayerColors ? groundBaseColor : 0x5b874b;
    const groundWetColor = debugLayerColors ? groundBaseColor : mulHexLumaFloor(preset.ground.color, WET_OVERLAY.groundDarken, 76);
    const runoffDryColor = debugLayerColors ? 0x0060ff : preset.runoff.color;
    const runoffWetColor = debugLayerColors ? runoffDryColor : mulHexLumaFloor(preset.runoff.color, WET_OVERLAY.runoffDarken, 56);
    const vergeDryColor = grassBlendColor;
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
    if (preset.grandstands !== false) {
      scene.add(buildGrandstands(center, extent, standsY));
    }

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
    const groundMat = preset.ground.unlit
      ? new THREE.MeshBasicMaterial({
        color: groundBaseColor,
        map: grassTex,
        fog: true,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: 4,
        polygonOffsetUnits: 4,
      })
      : new THREE.MeshLambertMaterial({
        color: groundBaseColor,
        map: grassTex,
        polygonOffset: true,
        polygonOffsetFactor: 4,
        polygonOffsetUnits: 4,
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
      buildEdgeLineGeometry(curve, segments, -VERGE_CENTER, GRASS_STRIP_WIDTH, 0.06, 90, VERGE_INNER + 0.05),
      vergeMat,
    );
    const vergeR = new THREE.Mesh(
      buildEdgeLineGeometry(curve, segments, +VERGE_CENTER, GRASS_STRIP_WIDTH, 0.06, 90, VERGE_INNER + 0.05),
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
      buildEdgeLineGeometry(curve, segments, -RUNOFF_STRIP_CENTER, RUNOFF_STRIP_WIDTH, 0.05, 80, RUNOFF_INNER + 0.05),
      runoffMat,
    );
    const runoffR = new THREE.Mesh(
      buildEdgeLineGeometry(curve, segments, +RUNOFF_STRIP_CENTER, RUNOFF_STRIP_WIDTH, 0.05, 80, RUNOFF_INNER + 0.05),
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

    // Embankment walls — placed just outside the runoff boundary (RUNOFF_WIDTH)
    // so they never overlap kerb/verge/runoff strips. Top is flush with the outer
    // runoff surface (yLift 0.06). Bottom is at a fixed world floor so on an
    // elevated section the wall is as tall as the elevation delta, closing the
    // "see sky under the track" gap without touching any inner geometry.
    const EMBANKMENT_FLOOR = bb.min.y - 2.0;
    const EMBANKMENT_OFFSET = RUNOFF_WIDTH + 0.15;
    const embankTex = cachedTex("grass", makeGrassTexture);
    embankTex.repeat.set(1, 85);
    const embankMat = new THREE.MeshBasicMaterial({
      color: vergeDryColor,
      map: embankTex,
      side: THREE.DoubleSide,
      fog: true,
      toneMapped: false,
    });
    const embankL = new THREE.Mesh(
      buildTrackEmbankmentGeometry(curve, segments, -EMBANKMENT_OFFSET, 0.3, EMBANKMENT_FLOOR, 0.06, RUNOFF_WIDTH + 0.02),
      embankMat,
    );
    const embankR = new THREE.Mesh(
      buildTrackEmbankmentGeometry(curve, segments, +EMBANKMENT_OFFSET, 0.3, EMBANKMENT_FLOOR, 0.06, RUNOFF_WIDTH + 0.02),
      embankMat,
    );
    embankL.renderOrder = 1;
    embankR.renderOrder = 1;
    scene.add(embankL);
    scene.add(embankR);

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
    const tracksideWorldUp = new THREE.Vector3(0, 1, 0);
    const placeTrackside = (obj, u, side, offset, lift = 0.05) => {
      sampleTrackFrameAt(curve, u, propPoint, propTan, propRight, propUp);
      obj.position.copy(propPoint)
        .addScaledVector(propRight, offset * side)
        .addScaledVector(propUp, lift);
      propFlatFwd.copy(propTan);
      propFlatFwd.y = 0;
      if (propFlatFwd.lengthSq() < 1e-8) propFlatFwd.copy(propTan);
      propFlatFwd.normalize();
      propFlatRight.crossVectors(propFlatFwd, tracksideWorldUp).normalize();
      if (propFlatRight.dot(propRight) < 0) propFlatRight.multiplyScalar(-1);
      propBasis.makeBasis(propFlatFwd, tracksideWorldUp, propFlatRight);
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
    // Driver entries are referenced both by the scene update and wheel-HUD
    // helper reattach callback.
    const driverMap = new Map();

    // Wheel HUD — single CanvasTexture/material instance for the whole scene.
    // The Steer mesh in this GLB has the screen face baked into a single
    // chassis texture (buttons, paddles, F1 logo all in one), with no
    // separate display submesh. Replacing its material would clobber the
    // whole wheel. Instead, we add a small PlaneGeometry quad as a child of
    // the steering wheel mesh, positioned to cover the screen area. On a
    // pinned-driver change we just reparent (or rebuild) the quad — the
    // shared chassis material is never touched.
    const wheelHud = buildWheelHud();
    // The quad is created once and reparented per pinned car. Geometry is
    // 1:1 (1×1) and sized via mesh.scale so we can re-tune the screen size
    // at runtime without rebuilding geometry.
    const wheelHudQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), wheelHud.material);
    wheelHudQuad.castShadow = false;
    wheelHudQuad.receiveShadow = false;
    wheelHudQuad.renderOrder = 5; // draw on top of the wheel surface
    const {
      state: wheelHudAttach,
      attach: attachWheelHud,
      detach: detachWheelHud,
      reapply: reapplyWheelHud,
    } = createWheelHudAttachment({
      wheelHud,
      wheelHudQuad,
      getDriverEntry: (code) => driverMap.get(code),
    });

    const wheelHudDebug = buildWheelHudDebugPanel(mount, reapplyWheelHud);
    const onDebugKey = (e) => {
      if (e.key === "w" || e.key === "W") {
        // Don't fire if user is typing in an input field.
        const t = e.target;
        const tag = t && t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || (t && t.isContentEditable)) return;
        wheelHudDebug.toggle();
      }
    };
    window.addEventListener("keydown", onDebugKey);

    // --- Driver meshes ---
    const driverGroup = new THREE.Group();
    scene.add(driverGroup);

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
    const POV_SMOOTH_ROT = 12.0;
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
        embankMat.color.setHex(vergeWetColor);
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
        embankMat.color.setHex(vergeDryColor);
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
        const labelBadge = String(entry.lastLabelStatus || "").trim().toUpperCase();
        const hideFromTrack = labelBadge === "RET" || labelBadge === "ACC";
        if (hideFromTrack) {
          if (label._shown !== false) { label.style.display = "none"; label._shown = false; }
          continue;
        }
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
          entry = { group: g, label };
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
        _fwd.copy(tmpTan).normalize();
        _right.crossVectors(_fwd, _worldUp).normalize();
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
        const isRetired = labelStatus === "RET" || labelStatus === "ACC";
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
          const outOfPlay = isDns ? false : (status === "OUT" || isRetired);
          const inPit = status === "PIT";
          entry.group.visible = !outOfPlay;
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
          const povTune = TRACK3D_POV_TUNE;
          _cameraRight.crossVectors(fwd, up).normalize();
          up.crossVectors(_cameraRight, fwd).normalize();

          _eyeWorld.copy(pinnedEntry.group.position)
            .addScaledVector(fwd, povTune.eyeForward)
            .addScaledVector(_cameraRight, povTune.eyeRight)
            .addScaledVector(up, povTune.eyeHeight + povTune.upDown);
          camera.position.copy(_eyeWorld);
          camera.up.copy(up);

          _lookWorld.copy(pinnedEntry.group.position)
            .addScaledVector(fwd, povTune.lookAhead)
            .addScaledVector(_cameraRight, povTune.eyeRight)
            .addScaledVector(up, povTune.lookHeight + povTune.upDown);
          camera.lookAt(_lookWorld);

          controls.enabled = false;
          // POV now uses the in-cockpit wheel display, so suppress the
          // old screen-space HUD overlay in this camera mode.
          povHud.root.style.display = "none";
          povHud.pill.style.display = "none";

          const sNorm = Math.max(0, Math.min(1, (chaseSpeedKph - 80) / 240));
          const sCurve = sNorm * sNorm * (3 - 2 * sNorm);
          targetVignetteStrength = preset.vignette.base + sCurve * 0.3;
          targetVignetteRadius = 1.0 - sCurve * 0.22;
          const targetFov = povTune.baseFov + sCurve * 6;
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

      // ─── Wheel HUD: live dashboard rendered onto the steering-wheel mesh ─
      // Always-on when a driver is pinned, regardless of camera mode (the
      // quad costs nothing when offscreen). On a pinned-driver change,
      // detach from the previous car before attaching to the new one.
      {
        const pinnedCode = live.pinned || null;
        if (wheelHudAttach.code !== pinnedCode) {
          if (wheelHudAttach.code) detachWheelHud();
          if (pinnedCode) {
            const entry = driverMap.get(pinnedCode);
            // The GLB clone is built async — userData.steeringWheel is set
            // when the model finishes loading. If it's not ready yet, leave
            // the attach for a future frame.
            if (entry && entry.group?.userData?.steeringWheel) {
              attachWheelHud(pinnedCode, entry);
            }
          }
        } else if (pinnedCode && !wheelHudAttach.parent) {
          // Pinned didn't change but the model wasn't ready before — retry.
          const entry = driverMap.get(pinnedCode);
          if (entry && entry.group?.userData?.steeringWheel) {
            attachWheelHud(pinnedCode, entry);
          }
        }

        if (wheelHudAttach.parent && pinnedCode) {
          const standing = findByCode(pinnedCode);
          if (standing) {
            const f = frameRef.current;
            const snap = snapshotRef.current;
            const teamColor =
              snap?.driver_meta?.[pinnedCode]?.team_colour ||
              window.APEX?.TEAMS?.[standing.driver?.team]?.color ||
              "#FF1E00";
            // The standings array in the RAF loop comes from
            // window.APEX.sampleStandingsAt (interpolated for smooth motion),
            // NOT from computeStandings. The interpolated objects preserve
            // the raw snake_case frame fields (last_lap_s, best_lap_s, gear,
            // rpm, throttle_pct, brake_pct, in_drs, in_pit, ...) and add a
            // few cooked ones (speedKph, compound, tyreAge). Read the raw
            // fields directly here — the camelCase aliases from
            // computeStandings (lastLap, bestLap, inDRS, pit) don't exist
            // on these objects.
            const lastLapS = standing.last_lap_s;
            const bestLapS = standing.best_lap_s;
            const pbLapS = standing.personal_best_lap_s;
            const drsOn = !!standing.in_drs;
            const drsLabel = drsOn ? "OPEN" : "CLSD";
            // Prefer LAST; fall back to BEST when no completed lap yet (e.g.
            // first lap of the race). Real F1 wheels do exactly this.
            const fmt = (t) => {
              const m = Math.floor(t / 60);
              const s = (t - m * 60);
              return `${m}:${s.toFixed(3).padStart(6, "0")}`;
            };
            let lastLap;
            let lastLapMode;
            if (Number.isFinite(lastLapS) && lastLapS > 0) {
              lastLap = fmt(lastLapS);
              lastLapMode = "LAST";
            } else if (Number.isFinite(bestLapS) && bestLapS > 0) {
              lastLap = fmt(bestLapS);
              lastLapMode = "BEST";
            } else {
              lastLap = "--:--.---";
              lastLapMode = "LAST";
            }
            // Lap tag: session_best > pb > none. Compares the value being
            // displayed (lastLap or fallback bestLap) against session/PB.
            const displayedS = (lastLapMode === "LAST") ? lastLapS : bestLapS;
            let lapTag = "";
            const sb = window.APEX?.SESSION_BEST?.lap_s;
            if (Number.isFinite(sb) && Number.isFinite(displayedS) && displayedS > 0 && Math.abs(displayedS - sb) < 0.0005) {
              lapTag = "session_best";
            } else if (Number.isFinite(pbLapS) && Number.isFinite(displayedS) && displayedS > 0 && Math.abs(displayedS - pbLapS) < 0.0005) {
              lapTag = "pb";
            }
            wheelHud.repaint({
              code: standing.driver?.code || pinnedCode,
              pos: standing.pos,
              speed: standing.speedKph || standing.speed_kph || 0,
              gear: standing.gear,
              rpm: standing.rpm || 0,
              throttle: standing.throttle_pct || 0,
              brake: standing.brake_pct || 0,
              drs: drsLabel,
              tyre: standing.compound || "M",
              tyreLaps: standing.tyreAge ?? standing.tyre_age_laps ?? 0,
              lap: f?.lap || null,
              totalLaps: f?.total_laps || null,
              flagState: f?.flag_state || "GREEN",
              inPit: !!standing.in_pit || standing.status === "PIT",
              lastLap,
              lastLapMode,
              lapTag,
              teamColor,
            });
          }
        }
      }

      updateWeather(live, dt);

      // Cockpit and chase cams read harsher than orbit because bright kerbs,
      // barriers and spec hits occupy much more of the screen. Keep the same
      // overall look, but tame the bloom specifically for these cameras.
      if (bloomPass) {
        if (inPov) {
          bloomPass.strength *= 0.45;
          bloomPass.threshold = Math.min(1.0, bloomPass.threshold + 0.08);
        } else if (inFollow) {
          bloomPass.strength *= 0.7;
          bloomPass.threshold = Math.min(1.0, bloomPass.threshold + 0.04);
        }
      }

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
      // Detach the wheel HUD quad from whichever car currently owns it before
      // the scene-level dispose pass, so the live material/geometry don't
      // get double-disposed via scene.traverse below.
      detachWheelHud();
      if (wheelHudQuad.geometry) wheelHudQuad.geometry.dispose();
      wheelHud.dispose();
      window.removeEventListener("keydown", onDebugKey);
      wheelHudDebug.root.remove();
      composer.dispose();
      renderTarget.dispose();
      // envTex is module-cached (getRoomEnvironment) — do NOT dispose here.
      // Disposing a previously-cached envTex would break the next scene build.
      renderer.domElement.remove();
      renderer.dispose();
      // The PMREM cache is renderer-bound. Once that renderer is gone, drop it
      // so the next scene rebuild can regenerate safely.
      clearRoomEnvironmentCache(renderer);
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
