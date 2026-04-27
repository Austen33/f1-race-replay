// Steering-wheel HUD quad placement on the GLB's Steer mesh. The screen face
// is identified by the wheel mesh's shortest local axis (the disk normal).
// Held as a mutable object so the on-screen debug panel (toggle: 'W' key)
// can tweak values live. Once the values look right, paste them back as the
// new defaults below.
// faceSign:           +1 / -1 — flip if the quad lands on the wrong side
//                     of the wheel (front-of-cockpit vs. driver-facing).
// flipU / flipV:      mirror the dashboard horizontally / vertically.
// shiftFaceX / Y:     nudge along the wheel face (fraction of face bbox).
// sizeFaceX / Y:      screen size as fraction of face bbox (separate W/H).
// sizeMultiplier:     overall screen size scaling on top of the per-axis
//                     sizes — useful for quick global tweaks.
// emissiveIntensity:  HUD glow under the cockpit ambient. Sweet spot 0.5–0.8.
export const TRACK3D_WHEEL_HUD_TUNE = {
  faceSign: 1,
  flipU: true,
  flipV: true,
  shiftFaceX: 0.000,
  shiftFaceY: 0.225,
  sizeFaceX: 0.310,
  sizeFaceY: 0.330,
  sizeMultiplier: 1.000,
  emissiveIntensity: 0.750,
};
