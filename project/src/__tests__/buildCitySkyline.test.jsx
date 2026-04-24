import * as THREE from "three";
import { describe, it, expect, vi } from "vitest";

import "../Track3D.jsx";

const { buildCitySkyline } = window.APEX_CITY_TEST;

function makeMockGltfScene(heights) {
  const root = new THREE.Group();
  heights.forEach((h, idx) => {
    const geom = new THREE.BoxGeometry(1, h, 1);
    geom.translate(0, h * 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = `mesh_${idx}`;
    root.add(mesh);
  });
  return root;
}

describe("buildCitySkyline", () => {
  it("selects the tallest 8 templates from a 12-mesh mock GLB", () => {
    const heights = [1, 3, 7, 2, 12, 9, 6, 4, 8, 5, 11, 10];
    const gltfScene = makeMockGltfScene(heights);
    const center = new THREE.Vector3(0, 0, 0);
    const built = buildCitySkyline(
      center,
      { x: 1000, z: 1000 },
      0,
      { hemi: { sky: 0xffffff } },
      gltfScene,
      160,
    );

    expect(built.group.children).toHaveLength(8);
    built.group.children.forEach((c) => expect(c.isInstancedMesh).toBe(true));

    const pickedHeights = built.group.children.map((c) => {
      c.geometry.computeBoundingBox();
      const bb = c.geometry.boundingBox;
      return Number((bb.max.y - bb.min.y).toFixed(6));
    }).sort((a, b) => b - a);
    const expectedTop8 = [...heights].sort((a, b) => b - a).slice(0, 8);
    expect(pickedHeights).toEqual(expectedTop8);
  });

  it("dispose() releases instanced geometries/materials and detaches the group", () => {
    const gltfScene = makeMockGltfScene([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const scene = new THREE.Scene();
    const built = buildCitySkyline(
      new THREE.Vector3(0, 0, 0),
      { x: 1000, z: 1000 },
      0,
      { hemi: { sky: 0xffffff } },
      gltfScene,
      90,
    );
    scene.add(built.group);

    const geometryDisposers = built.group.children.map((c) => vi.spyOn(c.geometry, "dispose"));
    const materialDisposers = built.group.children.map((c) => vi.spyOn(c.material, "dispose"));

    built.dispose();

    expect(scene.children.includes(built.group)).toBe(false);
    geometryDisposers.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    materialDisposers.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
  });
});

