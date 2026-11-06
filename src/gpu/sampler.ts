// glTF texture samplers → backend sampling state, shared by the WebGPU and WebGL 2 model drivers.
// glTF uses the WebGL enums, so WebGL 2 takes the numbers as they are; WebGPU needs a descriptor.
import type { GltfSampler } from "../gltf/glb";

/** One key per distinct sampler (the drivers cache GPU samplers and WebGL texture variants by it). */
export const samplerKey = (s: GltfSampler) => `${s.magFilter}/${s.minFilter}/${s.wrapS}/${s.wrapT}`;

/**
 * True when the minification filter reads the mip chain (glTF 9984–9987, the `*_MIPMAP_*` filters). NEAREST (9728) and
 * LINEAR (9729) read only the full-size image, however small it is drawn. The magnification filter never decides this:
 * NEAREST magnification with a mipmapped minification filter still averages texels at a distance.
 */
export const usesMipmaps = (s: GltfSampler) => s.minFilter >= 9984;

/**
 * Anisotropic filtering: the engine's 4× for fully linear, trilinear sampling (the default), off otherwise
 * (WebGPU allows it only when every filter is linear; WebGL 2 follows so both backends match).
 */
export const anisotropyFor = (s: GltfSampler) => (s.magFilter === 9729 && s.minFilter === 9987 ? 4 : 1);

const ADDRESS: Record<GltfSampler["wrapS"], GPUAddressMode> = { 33071: "clamp-to-edge", 33648: "mirror-repeat", 10497: "repeat" };
const nearest = (f: number) => f === 9728 || f === 9984 || f === 9986;

/**
 * The WebGPU sampler for a glTF sampler. A non-mipmapped minification filter also needs a one-level texture view
 * (`usesMipmaps`), since the texture itself keeps its mip chain for other samplers of the same image.
 */
export function webgpuSampler(s: GltfSampler): GPUSamplerDescriptor {
  return {
    magFilter: nearest(s.magFilter) ? "nearest" : "linear",
    minFilter: nearest(s.minFilter) ? "nearest" : "linear",
    mipmapFilter: s.minFilter === 9986 || s.minFilter === 9987 ? "linear" : "nearest",
    addressModeU: ADDRESS[s.wrapS],
    addressModeV: ADDRESS[s.wrapT],
    maxAnisotropy: anisotropyFor(s),
  };
}
