// SkinPose and its rotation helpers (src/gltf/skinpose.ts): posing a skin from world-space bone
// transforms. Synthetic skeletons only, so this suite says nothing about any game.
import { describe, expect, it } from "vitest";
import type { GltfDoc, GltfNode } from "../src/gltf/glb";
import { IDENTITY } from "../src/gltf/glb";
import { SkinPose, apply3, boneDelta, followSwing, frame3, mul3, mul3T, stretchAlong, swing3 } from "../src/gltf/skinpose";

const node = (name: string, parent: number, children: number[], t: [number, number, number], r: [number, number, number, number] = [0, 0, 0, 1]): GltfNode => ({
  name, parent, children, t, r, s: [1, 1, 1], mesh: -1, skin: -1, extras: {},
});

/** root(0) → upper(1) at (0,1,0) → lower(2) 1 m further up; a rolled lower bone (a non-identity rest rotation). */
function chainDoc(rollLower = true): GltfDoc {
  const nodes = [
    node("root", -1, [1], [0, 0, 0]),
    node("upper", 0, [2], [0, 1, 0]),
    node("lower", 1, [], [0, 1, 0], rollLower ? [0.3826834, 0, 0, 0.9238795] : [0, 0, 0, 1]),
  ];
  const inv = new Float32Array(32);
  // inverse bind: translate by −(rest position); the rest positions are (0,1,0) and (0,2,0).
  inv.set(IDENTITY, 0);
  inv.set(IDENTITY, 16);
  inv[13] = -1;
  inv[16 + 13] = -2;
  // (`bound()` below replaces these with exact inverses of the rest world matrices, roll included.)
  return { url: "chain", nodes, meshes: [], materials: [], skins: [{ joints: [1, 2], inverseBind: inv }], clips: [], roots: [0], extensionsUsed: [] };
}

/** Skin a point given in rest world space by joint j (a vertex fully weighted to it). */
function skinPoint(pose: SkinPose, j: number, p: [number, number, number]): [number, number, number] {
  const m = pose.jointMatrices;
  const o = j * 16;
  return [
    m[o] * p[0] + m[o + 4] * p[1] + m[o + 8] * p[2] + m[o + 12],
    m[o + 1] * p[0] + m[o + 5] * p[1] + m[o + 9] * p[2] + m[o + 13],
    m[o + 2] * p[0] + m[o + 6] * p[1] + m[o + 10] * p[2] + m[o + 14],
  ];
}
const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-5) => {
  for (let i = 0; i < b.length; i++) expect(a[i], `component ${i}`).toBeCloseTo(b[i], -Math.log10(eps));
};

describe("the rotation helpers", () => {
  it("builds right-handed orthonormal frames and prefers the reference for the second axis", () => {
    const f = new Float64Array(9);
    expect(frame3(f, [0, 0, 2], [3, 0, 5])).toBe(true);
    close(f, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    // z is the axis, x the reference with the axis part removed.
    frame3(f, [0, 1, 0], [1, 1, 0]);
    close(apply3(f, 0, 0, 1), [0, 1, 0]);
    close(apply3(f, 1, 0, 0), [1, 0, 0]);
    // det = +1 and columns are orthonormal.
    const t = new Float64Array(9);
    mul3T(t, f, f);
    close(t, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("copes with a reference parallel to the axis", () => {
    const f = new Float64Array(9);
    expect(frame3(f, [0, 1, 0], [0, 4, 0])).toBe(false);
    const t = new Float64Array(9);
    mul3T(t, f, f);
    close(t, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    close(apply3(f, 0, 0, 1), [0, 1, 0]);
  });

  it("swings one direction onto another without twisting, including the opposite one", () => {
    const r = new Float64Array(9);
    swing3(r, [0, 1, 0], [1, 0, 0]);
    close(apply3(r, 0, 1, 0), [1, 0, 0]);
    // The axis perpendicular to both is unchanged (no twist).
    close(apply3(r, 0, 0, 1), [0, 0, 1]);
    swing3(r, [0, 1, 0], [0, 1, 0]);
    close(r, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    for (const hint of [undefined, [1, 0, 0], [0, 0, 1], [0, 1, 0]]) {
      swing3(r, [0, 1, 0], [0, -1, 0], hint);
      close(apply3(r, 0, 1, 0), [0, -1, 0]);
      const t = new Float64Array(9);
      mul3T(t, r, r);
      close(t, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    }
    // The hint chooses the half-turn axis: a hint along x turns about x, so z flips.
    swing3(r, [0, 1, 0], [0, -1, 0], [1, 0, 0]);
    close(apply3(r, 0, 0, 1), [0, 0, -1]);
    close(apply3(r, 1, 0, 0), [1, 0, 0]);
  });

  it("composes swings on a parent's rotation and stretches along a direction", () => {
    const parent = new Float64Array(9);
    swing3(parent, [0, 1, 0], [1, 0, 0]); // the parent lies along +x now
    const out = new Float64Array(9);
    // Rest direction (0,1,0) rotated by the parent is (1,0,0); posing it there changes nothing beyond the parent.
    followSwing(out, parent, [0, 1, 0], [1, 0, 0]);
    close(out, Array.from(parent));
    // Posed along +z instead: the direction lands there.
    followSwing(out, parent, [0, 1, 0], [0, 0, 1]);
    close(apply3(out, 0, 1, 0), [0, 0, 1]);
    const s = new Float64Array(9);
    stretchAlong(s, [0, 2, 0], 1.5);
    close(apply3(s, 0, 1, 0), [0, 1.5, 0]);
    close(apply3(s, 1, 0, 0), [1, 0, 0]);
    const m = new Float64Array(9);
    mul3(m, out, s);
    close(apply3(m, 0, 1, 0), [0, 0, 1.5]);
  });
});

describe("SkinPose", () => {
  /** A doc whose bind pose equals its rest pose (so the rest pose skins to the identity). */
  function bound(doc: GltfDoc): SkinPose {
    const p = new SkinPose(doc);
    const sk = doc.skins[0];
    // inverse bind = inverse of the rest world matrix (rigid: transpose the rotation).
    sk.joints.forEach((n, j) => {
      const w = p.rest.subarray(n * 16, n * 16 + 16);
      const inv = new Float32Array(16);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) inv[c * 4 + r] = w[r * 4 + c];
      for (let r = 0; r < 3; r++) inv[12 + r] = -(inv[r] * w[12] + inv[4 + r] * w[13] + inv[8 + r] * w[14]);
      inv[15] = 1;
      sk.inverseBind.set(inv, j * 16);
    });
    p.update(IDENTITY);
    return p;
  }

  it("is the rest pose until a bone is set, with rest positions from the node transforms", () => {
    const pose = bound(chainDoc());
    close(pose.restPosition("upper")!, [0, 1, 0]);
    close(pose.restPosition("lower")!, [0, 2, 0]);
    expect(pose.restPosition("nothing")).toBeNull();
    for (let j = 0; j < 2; j++) close(pose.jointMatrices.subarray(j * 16, j * 16 + 16), IDENTITY);
  });

  it("moves a bone to a posed head with a rotation, whatever the node's own rest rotation is", () => {
    const pose = bound(chainDoc(true));
    const R = new Float64Array(9);
    swing3(R, [0, 1, 0], [1, 0, 0]); // the bone now points along +x
    const d = new Float32Array(16);
    boneDelta(d, 0, [0, 1, 0], [3, 1, 0], R);
    pose.set("upper", d);
    pose.update(IDENTITY);
    // The rest head lands on the posed head; a point one metre along the bone lands one metre along +x.
    close(skinPoint(pose, 0, [0, 1, 0]), [3, 1, 0]);
    close(skinPoint(pose, 0, [0, 2, 0]), [4, 1, 0]);
    // The child follows its parent when it has no pose of its own: its head moved with it.
    const w = pose.world;
    close([w[2 * 16 + 12], w[2 * 16 + 13], w[2 * 16 + 14]], [4, 1, 0]);
  });

  it("poses each bone independently and resets to the rest pose", () => {
    const pose = bound(chainDoc());
    const R = new Float64Array(9);
    swing3(R, [0, 1, 0], [0, 0, 1]);
    const d = new Float32Array(16);
    boneDelta(d, 0, [0, 2, 0], [0, 2, 5], R);
    pose.set("lower", d);
    pose.update(IDENTITY);
    close(skinPoint(pose, 0, [0, 1.5, 0]), [0, 1.5, 0]); // upper untouched
    close(skinPoint(pose, 1, [0, 3, 0]), [0, 2, 6]);
    pose.reset();
    pose.update(IDENTITY);
    close(pose.jointMatrices.subarray(16, 32), IDENTITY);
  });

  it("places the whole model with a root matrix and ignores unknown bone names", () => {
    const pose = bound(chainDoc());
    const root = new Float32Array(IDENTITY);
    root[12] = 10;
    pose.set("no such bone", new Float32Array(IDENTITY));
    pose.update(root);
    close(skinPoint(pose, 0, [0, 1, 0]), [10, 1, 0]);
  });

  it("writes the same layout the Animator does (16 floats per node and per joint)", () => {
    const pose = bound(chainDoc());
    expect(pose.world.length).toBe(3 * 16);
    expect(pose.jointMatrices.length).toBe(2 * 16);
  });
});
