import * as THREE from "three";
import { describe, it, expect, vi } from "vitest";

import "../Track3D.jsx";

const { detectTimeOfDay, isDayCityEnabled, startCancelableCityLoad } = window.APEX_CITY_TEST;

describe("city integration", () => {
  it("cancels pending city load before resolve so scene.add is never called", async () => {
    let resolveLoad;
    const loader = {
      loadAsync: vi.fn(() => new Promise((resolve) => { resolveLoad = resolve; })),
    };
    const scene = new THREE.Scene();
    const addSpy = vi.spyOn(scene, "add");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cancel = startCancelableCityLoad(
      loader,
      (gltf) => scene.add(gltf.scene),
      (err) => console.warn("city-load-error", err),
    );
    cancel();
    resolveLoad({ scene: new THREE.Group() });
    await Promise.resolve();
    await Promise.resolve();

    expect(addSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("night circuit snapshot: no city group attached to scene graph", () => {
    const scene = new THREE.Scene();
    const todKey = detectTimeOfDay("Singapore Grand Prix");
    if (isDayCityEnabled(todKey)) {
      const g = new THREE.Group();
      g.name = "city";
      scene.add(g);
    }
    expect(scene.children.map((c) => c.name || c.type)).toMatchInlineSnapshot(`[]`);
  });
});

