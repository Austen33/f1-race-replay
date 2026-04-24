import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

const isWatch = process.argv.includes("--watch");

// Copy static assets (GLB models, etc.) into project/assets/.
// The server mounts project/ at /app/, so assets/f1-car.glb is served at
// /app/assets/f1-car.glb which matches the CAR_MODEL_PATH in Track3D.jsx.
function copyAssets() {
  const projectDir = dirname(import.meta.url.replace("file://", ""));
  const assetsDir = join(projectDir, "assets");
  if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
  const src = join(projectDir, "..", "car_model.glb");
  if (existsSync(src)) {
    cpSync(src, join(assetsDir, "f1-car.glb"));
    console.log("Copied f1-car.glb → assets/");
  } else {
    console.warn("Warning: f1-car.glb not found at project root — cars will use fallback primitives.");
  }
  const scSrc = join(projectDir, "..", "safety_car.glb");
  if (existsSync(scSrc)) {
    cpSync(scSrc, join(assetsDir, "safety_car.glb"));
    console.log("Copied safety_car.glb → assets/");
  } else {
    console.warn("Warning: safety_car.glb not found at project root — safety car will use fallback primitives.");
  }
  // Optional real F1 steering wheel GLB for the POV view. If missing, the
  // cockpit rig renders a procedural wheel instead.
  const swSrc = join(projectDir, "..", "steering_wheel.glb");
  if (existsSync(swSrc)) {
    cpSync(swSrc, join(assetsDir, "steering_wheel.glb"));
    console.log("Copied steering_wheel.glb → assets/");
  } else {
    console.log("Note: steering_wheel.glb not found at project root — POV view uses procedural wheel.");
  }
}

const ctx = await esbuild.context({
  entryPoints: ["src/index.jsx"],
  bundle: true,
  outfile: "dist/bundle.js",
  format: "iife",
  jsx: "transform",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  target: ["chrome90", "firefox90", "safari15"],
  // React/ReactDOM are loaded from CDN as globals — no import statements to externalize
  // All files assign to window.XXX explicitly, so the IIFE wrapper
  // doesn't need to export anything. We just need the side-effects.
  footer: {
    js: "// side-effects only — window.APEX, window.LIVE, etc.",
  },
  minify: !isWatch,
  sourcemap: isWatch,
  logLevel: "info",
});

copyAssets();

if (isWatch) {
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("Build complete.");
}
