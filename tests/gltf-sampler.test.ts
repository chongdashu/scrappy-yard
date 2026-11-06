import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLTF_SAMPLER, parseGlb, samplerOptions, type GltfSampler } from "../src/gltf/glb";
import { anisotropyFor, samplerKey, usesMipmaps, webgpuSampler } from "../src/gpu/sampler";
import { buildGlb, quad } from "./fixtures/glb";

// One embedded image, one material per texture. The image is never decoded: createImageBitmap is stubbed.
function parse(samplers: Record<string, unknown>[] | undefined, textures: Record<string, unknown>[]) {
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4, height: 1 })));
  return parseGlb(buildGlb({
    images: [new Uint8Array([137, 80, 78, 71])],
    samplers,
    textures,
    materials: textures.map((_, i) => ({ name: `mat_${i}`, pbrMetallicRoughness: { baseColorTexture: { index: i } } })),
    meshes: [quad(1, 1, 0)],
    nodes: [{ name: "card", mesh: 0 }],
  }), "sampler.glb");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GLB texture samplers", () => {
  it("gives each material its texture's sampler, also when materials share one image", async () => {
    const nearest = { magFilter: 9728, minFilter: 9984, wrapS: 33071, wrapT: 33648 };
    const doc = await parse([nearest, {}], [{ source: 0, sampler: 0 }, { source: 0, sampler: 1 }]);
    expect(doc.materials[0].sampler).toEqual(nearest);
    expect(doc.materials[1].sampler).toEqual(DEFAULT_GLTF_SAMPLER);
    expect(doc.materials[0].texture).toBe(doc.materials[1].texture);
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
  });

  it.each([9728, 9729, 9984, 9985, 9986, 9987])("keeps minification filter %i", async (minFilter) => {
    const doc = await parse([{ minFilter }], [{ source: 0, sampler: 0 }]);
    expect(doc.materials[0].sampler).toEqual({ ...DEFAULT_GLTF_SAMPLER, minFilter });
  });

  it("samples a texture without a sampler the way every texture was sampled before (linear, mipmapped, repeat)", async () => {
    const doc = await parse(undefined, [{ source: 0 }]);
    expect(doc.materials[0].sampler).toEqual({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });
  });

  it("warns once and falls back to the default for a missing sampler, however many textures use it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = await parse([], [{ source: 0, sampler: 3 }, { source: 0, sampler: 3 }]);
    expect(doc.materials.map((m) => m.sampler)).toEqual([DEFAULT_GLTF_SAMPLER, DEFAULT_GLTF_SAMPLER]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/sampler\.glb: sampler 3: is missing/);
  });

  it("keeps the valid fields of a sampler and replaces a value glTF does not define with the default's", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = await parse([{ magFilter: 9987, minFilter: 9728, wrapS: 33071 }], [{ source: 0, sampler: 0 }]);
    expect(doc.materials[0].sampler).toEqual({ magFilter: 9729, minFilter: 9728, wrapS: 33071, wrapT: 10497 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/magFilter 9987 is not a glTF sampler value; using 9729/);
    expect(samplerOptions(undefined)).toEqual(DEFAULT_GLTF_SAMPLER);
    expect(samplerOptions({ wrapT: "REPEAT" })).toEqual(DEFAULT_GLTF_SAMPLER);
  });

  it("gives an untextured material no sampler", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn());
    const doc = await parseGlb(buildGlb({ materials: [{ name: "mat_plain" }], meshes: [quad(1, 1, 0)], nodes: [{ name: "card", mesh: 0 }] }));
    expect(doc.materials[0].sampler).toBeUndefined();
  });
});

describe("texture samplers on the GPU", () => {
  const s = (magFilter: number, minFilter: number, wrapS = 10497, wrapT = 10497) => ({ magFilter, minFilter, wrapS, wrapT }) as GltfSampler;

  it("keeps the engine's original WebGPU sampler for the default", () => {
    expect(webgpuSampler(DEFAULT_GLTF_SAMPLER)).toEqual({
      magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat", maxAnisotropy: 4,
    });
    expect(anisotropyFor(DEFAULT_GLTF_SAMPLER)).toBe(4);
  });

  it("maps every minification filter to WebGPU filters, and only the *_MIPMAP_* ones read mipmaps", () => {
    const rows = [9728, 9729, 9984, 9985, 9986, 9987].map((min) => {
      const d = webgpuSampler(s(9728, min));
      return [min, d.minFilter, d.mipmapFilter, usesMipmaps(s(9728, min))];
    });
    expect(rows).toEqual([
      [9728, "nearest", "nearest", false],
      [9729, "linear", "nearest", false],
      [9984, "nearest", "nearest", true],
      [9985, "linear", "nearest", true],
      [9986, "nearest", "linear", true],
      [9987, "linear", "linear", true],
    ]);
  });

  it("samples pixel art nearest, and Blender's Closest export (NEAREST, NEAREST_MIPMAP_NEAREST) still mipmapped", () => {
    const blender = s(9728, 9984, 33071, 33071);
    expect(webgpuSampler(blender)).toEqual({
      magFilter: "nearest", minFilter: "nearest", mipmapFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", maxAnisotropy: 1,
    });
    expect(usesMipmaps(blender)).toBe(true);
    expect(usesMipmaps(s(9728, 9728))).toBe(false);
    expect(webgpuSampler(s(9729, 9987, 33648, 10497))).toMatchObject({ addressModeU: "mirror-repeat", addressModeV: "repeat", maxAnisotropy: 4 });
  });

  it("turns anisotropy off unless every filter is linear (WebGPU rejects it otherwise)", () => {
    expect([s(9728, 9987), s(9729, 9985), s(9729, 9729), s(9729, 9986)].map(anisotropyFor)).toEqual([1, 1, 1, 1]);
  });

  it("keys samplers by all four fields", () => {
    const keys = new Set([DEFAULT_GLTF_SAMPLER, s(9728, 9987), s(9729, 9984), s(9729, 9987, 33071), s(9729, 9987, 10497, 33071)].map(samplerKey));
    expect(keys.size).toBe(5);
  });
});
