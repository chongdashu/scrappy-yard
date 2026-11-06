import { describe, expect, it } from "vitest";
import { mat4 } from "../src/math";
import { Camera } from "../src/camera";
import { boxInFrustum, frustumPlanes } from "../src/gpu/frustum";

describe("frustum culling", () => {
  // Eye at the origin looking down −Z, 90° vertical field of view, square aspect, near 0.5, far 100.
  const viewProj = mat4.mul(mat4.perspective(Math.PI / 2, 1, 0.5, 100), mat4.lookAt([0, 0, 0], [0, 0, -1], [0, 1, 0]));
  const planes = frustumPlanes(viewProj);
  const box = (c: [number, number, number], h = 1) => boxInFrustum(planes, [c[0] - h, c[1] - h, c[2] - h], [c[0] + h, c[1] + h, c[2] + h]);

  it("keeps boxes in front of the camera and drops those behind, beside, or past the far plane", () => {
    expect(box([0, 0, -10])).toBe(true);
    expect(box([0, 0, 10])).toBe(false);
    expect(box([30, 0, -10])).toBe(false);
    expect(box([0, -30, -10])).toBe(false);
    expect(box([0, 0, -150])).toBe(false);
  });

  it("keeps a box that straddles a plane", () => {
    expect(box([10.5, 0, -10], 1)).toBe(true);
    expect(box([0, 0, -100.5], 1)).toBe(true);
    expect(box([0, 0, -0.2], 0.4)).toBe(true); // through the near plane
  });

  it("gives unit-length plane normals and can reuse an output array", () => {
    const out = new Float32Array(24);
    expect(frustumPlanes(viewProj, out)).toBe(out);
    for (let k = 0; k < 6; k++) expect(Math.hypot(out[k * 4], out[k * 4 + 1], out[k * 4 + 2])).toBeCloseTo(1, 5);
  });

  it("works on the gameplay camera: the ground around its target is in view, ground far behind the eye is not", () => {
    const cam = new Camera();
    cam.update(1 / 60, 0, 0, 16 / 9, [-50, -50, 50, 50]);
    const p = frustumPlanes(cam.viewProj);
    expect(boxInFrustum(p, [-1, 0, -1], [1, 0.5, 1])).toBe(true);
    expect(boxInFrustum(p, [-1, 0, 60], [1, 0.5, 62])).toBe(false);
  });
});
