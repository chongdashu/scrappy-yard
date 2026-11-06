// Geometry without a GPU: what a game server (or any Node tool) needs to read colliders and markers from a GLB.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isColliderNode, loadGlb, parseGlb } from "../src/gltf/glb";
import { isColliderNode as fromModel } from "../src/gpu/model";
import { box, buildGlb, quad } from "./fixtures/glb";

// A textured level: the image bytes are not even a valid PNG, so decoding them would fail anywhere.
const level = () => buildGlb({
  images: [new Uint8Array([1, 2, 3, 4])],
  materials: [{ name: "mat_floor", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }, { name: "mat_wall" }],
  meshes: [quad(4, 4, 0), box(1, 2, 1, 1)],
  nodes: [{ name: "floor", mesh: 0 }, { name: "col_wall", mesh: 1, translation: [2, 1, 0] }, { name: "mk_spawn", translation: [0, 0, 3] }],
});

afterEach(() => vi.unstubAllGlobals());

describe("geometry-only GLB parse", () => {
  it("runs in Node, where createImageBitmap does not exist, when textures are skipped", async () => {
    expect(typeof globalThis.createImageBitmap).toBe("undefined");
    await expect(parseGlb(level(), "level.glb")).rejects.toThrow(/createImageBitmap/);
    const doc = await parseGlb(level(), "level.glb", { textures: false });
    expect(doc.materials.map((m) => [m.name, m.texture, m.sampler])).toEqual([["mat_floor", undefined, undefined], ["mat_wall", undefined, undefined]]);
    expect(doc.meshes[1].primitives[0].positions).toHaveLength(24 * 3);
    const colliders = doc.nodes.filter((n) => isColliderNode(n.name)).map((n) => [n.name, n.t]);
    expect(colliders).toEqual([["col_wall", [2, 1, 0]], ["mk_spawn", [0, 0, 3]]]);
  });

  it("passes the option through loadGlb", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(level(), { headers: { "content-type": "model/gltf-binary" } })));
    const doc = await loadGlb("/assets/level.glb", { textures: false });
    expect(doc.nodes.map((n) => n.name)).toEqual(["floor", "col_wall", "mk_spawn"]);
  });

  it("keeps isColliderNode importable from the model module", () => {
    expect(fromModel).toBe(isColliderNode);
    expect(["col_x", "mk_y", "collider", "mesh_col_"].map(isColliderNode)).toEqual([true, true, false, false]);
  });
});
