// Minimal GLB (glTF 2.0 binary) parser for Blender exports.
// Pure CPU: decodes nodes, triangle meshes (with skin attributes), materials
// (base colour factor/texture and its sampler, emissive +
// KHR_materials_emissive_strength, alphaMode/alphaCutoff, the engine's material
// kind from extras), skins and animation clips. No GPU work happens here, and
// with `{ textures: false }` no image decoding either (geometry only, e.g. Node).
//
// Supported subset (rejected with a clear error otherwise): triangle-list
// primitives, float/normalized-int accessors, embedded buffers/images,
// LINEAR / STEP / CUBICSPLINE animation samplers. Not supported: morph
// targets, sparse accessors, external .bin/.png files, metallic/normal/
// occlusion maps, cameras/lights, KHR_texture_transform, Draco/meshopt
// compression. See docs/starter.md.

export interface GltfNode {
  name: string;
  parent: number;
  children: number[];
  t: [number, number, number];
  r: [number, number, number, number];
  s: [number, number, number];
  mesh: number;
  skin: number;
  extras: Record<string, unknown>;
}

export interface GltfPrimitive {
  positions: Float32Array;
  normals: Float32Array;
  uvs?: Float32Array;
  joints?: Uint16Array;
  weights?: Float32Array;
  indices: Uint32Array;
  material: number;
}

export interface GltfMaterial {
  name: string;
  /** Linear RGBA (glTF base colour factors are linear). */
  baseColor: [number, number, number, number];
  emissive: [number, number, number];
  emissiveStrength: number;
  /** sRGB-encoded base colour image, if any. Materials that use the same glTF image share one ImageBitmap. */
  texture?: ImageBitmap;
  /** How the base colour texture is filtered and wrapped (glTF `samplers`); set whenever `texture` is. */
  sampler?: GltfSampler;
  doubleSided?: boolean;
  /** pbrMetallicRoughness.roughnessFactor (used as 1 − gloss by the toon shader). */
  roughness?: number;
  /** glTF alphaMode: OPAQUE ignores alpha, MASK cuts out below `alphaCutoff`, BLEND draws in the translucent pass. Absent = OPAQUE. */
  alphaMode?: AlphaMode;
  /** MASK threshold on base alpha × texture alpha (glTF default 0.5). */
  alphaCutoff?: number;
  /** The engine's material kind (`extras.vgd_kind` or `extras.vgd.kind`); absent = "default". */
  kind?: MaterialKind;
}

/**
 * A glTF texture sampler, in glTF's (WebGL's) enums. Filters: 9728 NEAREST, 9729 LINEAR, and for minification
 * 9984 NEAREST_MIPMAP_NEAREST, 9985 LINEAR_MIPMAP_NEAREST, 9986 NEAREST_MIPMAP_LINEAR, 9987 LINEAR_MIPMAP_LINEAR.
 * Wraps: 33071 CLAMP_TO_EDGE, 33648 MIRRORED_REPEAT, 10497 REPEAT. Only the minification filter decides whether
 * mipmaps are read (9984–9987 do; NEAREST and LINEAR read the full-size image at any distance).
 */
export interface GltfSampler {
  magFilter: 9728 | 9729;
  minFilter: 9728 | 9729 | 9984 | 9985 | 9986 | 9987;
  wrapS: 33071 | 33648 | 10497;
  wrapT: 33071 | 33648 | 10497;
}

/**
 * A texture without a sampler: repeat wrapping (glTF's default) and the engine's automatic filtering, linear with
 * trilinear mipmaps (and 4× anisotropy). Every texture was sampled this way before samplers were read. A missing
 * field of a sampler, or a value glTF does not define, takes the value from here.
 */
export const DEFAULT_GLTF_SAMPLER: Readonly<GltfSampler> = Object.freeze({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });

const SAMPLER_VALUES: { readonly [K in keyof GltfSampler]: readonly GltfSampler[K][] } = {
  magFilter: [9728, 9729],
  minFilter: [9728, 9729, 9984, 9985, 9986, 9987],
  wrapS: [33071, 33648, 10497],
  wrapT: [33071, 33648, 10497],
};

/** A sampler from its glTF JSON. Absent fields, and values glTF does not define (`warn` names them), take DEFAULT_GLTF_SAMPLER's. */
export function samplerOptions(s: Json | undefined, warn?: (message: string) => void): GltfSampler {
  const out: GltfSampler = { ...DEFAULT_GLTF_SAMPLER };
  if (!s || typeof s !== "object") return out;
  for (const key of Object.keys(SAMPLER_VALUES) as (keyof GltfSampler)[]) {
    const v = s[key];
    if (v === undefined) continue;
    if ((SAMPLER_VALUES[key] as readonly unknown[]).includes(v)) (out as Record<keyof GltfSampler, number>)[key] = v;
    else warn?.(`${key} ${JSON.stringify(v)} is not a glTF sampler value; using ${DEFAULT_GLTF_SAMPLER[key]}`);
  }
  return out;
}

export type AlphaMode = "OPAQUE" | "MASK" | "BLEND";
/**
 * What a surface is, for the shaders: "default" (everything), "foliage" (sways in the wind when
 * `Style.foliageSway` > 0), "liquid" (waves when `Style.liquidWave` > 0; more opaque at grazing angles when BLEND),
 * "bump" (shaded with relief from its base colour's brightness, up to `Style.bumpHeight`; an approximate height
 * effect, not a normal map).
 */
export type MaterialKind = "default" | "foliage" | "liquid" | "bump";
export const MATERIAL_KINDS: readonly MaterialKind[] = ["default", "foliage", "liquid", "bump"];

/**
 * A material's alpha mode, cutoff and kind from its glTF JSON. Blender writes custom properties to
 * `extras` (glTF exporter → Include → Custom Properties): a material property `vgd_kind` = "foliage",
 * or a `vgd` group holding `kind`. Unknown alpha modes read as OPAQUE and unknown kinds as "default"
 * (`warn` names them).
 */
export function materialOptions(m: Json, warn?: (message: string) => void): { alphaMode: AlphaMode; alphaCutoff: number; kind: MaterialKind } {
  const mode = m.alphaMode ?? "OPAQUE";
  const alphaMode: AlphaMode = mode === "MASK" || mode === "BLEND" ? mode : "OPAQUE";
  if (mode !== alphaMode) warn?.(`alphaMode ${JSON.stringify(mode)} is not a glTF alpha mode; drawing OPAQUE`);
  const cut = m.alphaCutoff;
  const alphaCutoff = typeof cut === "number" && Number.isFinite(cut) ? Math.min(1, Math.max(0, cut)) : 0.5;
  const extras = m.extras && typeof m.extras === "object" ? m.extras : {};
  const raw = extras.vgd_kind ?? (extras.vgd && typeof extras.vgd === "object" ? extras.vgd.kind : undefined);
  let kind: MaterialKind = "default";
  if (raw !== undefined) {
    const name = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
    if ((MATERIAL_KINDS as readonly unknown[]).includes(name)) kind = name as MaterialKind;
    else warn?.(`material kind ${JSON.stringify(raw)} is not one of ${MATERIAL_KINDS.join(", ")}; using "default"`);
  }
  return { alphaMode, alphaCutoff, kind };
}

export interface GltfSkin {
  joints: number[];
  /** 16 floats per joint, column-major. */
  inverseBind: Float32Array;
}

export interface GltfChannel {
  node: number;
  path: "translation" | "rotation" | "scale";
  times: Float32Array;
  values: Float32Array;
  interp: "LINEAR" | "STEP" | "CUBICSPLINE";
}

export interface GltfClip {
  name: string;
  duration: number;
  channels: GltfChannel[];
}

export interface GltfDoc {
  url: string;
  nodes: GltfNode[];
  meshes: { name: string; primitives: GltfPrimitive[] }[];
  materials: GltfMaterial[];
  skins: GltfSkin[];
  clips: GltfClip[];
  /** Root nodes of the default scene. */
  roots: number[];
  /** Extensions the file declares as used (informational). */
  extensionsUsed: string[];
}

export class GltfError extends Error {}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

interface Json {
  // Loosely typed glTF JSON; fields are validated where used.
  [k: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function loadGlb(url: string, options: ParseGlbOptions = {}): Promise<GltfDoc> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new GltfError(`${url}: network error (${String(e)})`);
  }
  if (!res.ok) throw new GltfError(`${url}: HTTP ${res.status}`);
  // Dev servers answer unknown paths with index.html (HTTP 200).
  if ((res.headers.get("content-type") ?? "").includes("text/html")) throw new GltfError(`${url}: not found (server returned HTML)`);
  return parseGlb(await res.arrayBuffer(), url, options);
}

export interface ParseGlbOptions {
  /**
   * false: skip decoding embedded images, so materials get no `texture` or `sampler`. For geometry-only use, such as
   * reading colliders in Node or on a game server, where `createImageBitmap` does not exist. Default true.
   */
  textures?: boolean;
}

export async function parseGlb(data: ArrayBuffer, url = "<memory>", options: ParseGlbOptions = {}): Promise<GltfDoc> {
  const dv = new DataView(data);
  if (data.byteLength < 20 || dv.getUint32(0, true) !== GLB_MAGIC) throw new GltfError(`${url}: not a GLB file`);
  if (dv.getUint32(4, true) !== 2) throw new GltfError(`${url}: unsupported glTF version ${dv.getUint32(4, true)}`);
  let off = 12;
  let json: Json | null = null;
  let bin: ArrayBuffer | null = null;
  while (off + 8 <= data.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, start, len)));
    else if (type === CHUNK_BIN) bin = data.slice(start, start + len);
    off = start + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new GltfError(`${url}: missing JSON chunk`);
  const req: string[] = json.extensionsRequired ?? [];
  if (req.length) throw new GltfError(`${url}: requires unsupported extensions ${req.join(", ")}`);

  const buffers: ArrayBuffer[] = (json.buffers ?? []).map((b: Json, i: number) => {
    if (b.uri) throw new GltfError(`${url}: external buffer ${i} (${b.uri}) is not supported`);
    if (!bin) throw new GltfError(`${url}: buffer ${i} has no BIN chunk`);
    return bin;
  });

  const viewBytes = (viewIndex: number): { buf: ArrayBuffer; offset: number; length: number; stride: number } => {
    const v = json!.bufferViews[viewIndex];
    return { buf: buffers[v.buffer], offset: v.byteOffset ?? 0, length: v.byteLength, stride: v.byteStride ?? 0 };
  };

  /** Read an accessor as a tightly packed typed array of the requested kind. */
  const readAccessor = (index: number, as: "f32" | "u16" | "u32"): Float32Array | Uint16Array | Uint32Array => {
    const a = json!.accessors[index];
    if (a.sparse) throw new GltfError(`${url}: sparse accessor ${index} is not supported`);
    const comps = COMPONENTS[a.type];
    const cbytes = COMPONENT_BYTES[a.componentType];
    if (!comps || !cbytes) throw new GltfError(`${url}: accessor ${index} has unsupported type ${a.type}/${a.componentType}`);
    const count: number = a.count;
    const out = as === "f32" ? new Float32Array(count * comps) : as === "u16" ? new Uint16Array(count * comps) : new Uint32Array(count * comps);
    if (a.bufferView === undefined) return out; // all zeros per spec
    const v = viewBytes(a.bufferView);
    const elemBytes = comps * cbytes;
    const stride = v.stride || elemBytes;
    const base = v.offset + (a.byteOffset ?? 0);
    const src = new DataView(v.buf, base, Math.max(0, (count - 1) * stride + elemBytes));
    const norm = !!a.normalized;
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < comps; c++) {
        const o = i * stride + c * cbytes;
        let x: number;
        switch (a.componentType) {
          case 5126: x = src.getFloat32(o, true); break;
          case 5125: x = src.getUint32(o, true); break;
          case 5123: x = src.getUint16(o, true); if (norm && as === "f32") x /= 65535; break;
          case 5122: x = src.getInt16(o, true); if (norm && as === "f32") x = Math.max(x / 32767, -1); break;
          case 5121: x = src.getUint8(o); if (norm && as === "f32") x /= 255; break;
          case 5120: x = src.getInt8(o); if (norm && as === "f32") x = Math.max(x / 127, -1); break;
          default: x = 0;
        }
        out[i * comps + c] = x;
      }
    }
    return out;
  };

  // Nodes.
  const nodes: GltfNode[] = (json.nodes ?? []).map((n: Json, i: number) => {
    let t: [number, number, number] = n.translation ?? [0, 0, 0];
    let r: [number, number, number, number] = n.rotation ?? [0, 0, 0, 1];
    let s: [number, number, number] = n.scale ?? [1, 1, 1];
    if (n.matrix) [t, r, s] = decompose(n.matrix);
    return {
      name: n.name ?? `node_${i}`,
      parent: -1,
      children: n.children ?? [],
      t: [...t] as [number, number, number],
      r: [...r] as [number, number, number, number],
      s: [...s] as [number, number, number],
      mesh: n.mesh ?? -1,
      skin: n.skin ?? -1,
      extras: n.extras ?? {},
    };
  });
  nodes.forEach((n, i) => n.children.forEach((c) => (nodes[c].parent = i)));

  // Meshes.
  const meshes = (json.meshes ?? []).map((m: Json, mi: number) => ({
    name: m.name ?? `mesh_${mi}`,
    primitives: (m.primitives ?? []).map((p: Json, pi: number): GltfPrimitive => {
      const mode = p.mode ?? 4;
      if (mode !== 4) throw new GltfError(`${url}: mesh ${m.name} primitive ${pi} uses mode ${mode}; only triangles are supported`);
      const at = p.attributes;
      if (at.POSITION === undefined) throw new GltfError(`${url}: mesh ${m.name} primitive ${pi} has no POSITION`);
      const positions = readAccessor(at.POSITION, "f32") as Float32Array;
      const vcount = positions.length / 3;
      const normals = at.NORMAL !== undefined ? (readAccessor(at.NORMAL, "f32") as Float32Array) : new Float32Array(vcount * 3);
      const uvs = at.TEXCOORD_0 !== undefined ? (readAccessor(at.TEXCOORD_0, "f32") as Float32Array) : undefined;
      const joints = at.JOINTS_0 !== undefined ? (readAccessor(at.JOINTS_0, "u16") as Uint16Array) : undefined;
      const weights = at.WEIGHTS_0 !== undefined ? (readAccessor(at.WEIGHTS_0, "f32") as Float32Array) : undefined;
      let indices: Uint32Array;
      if (p.indices !== undefined) indices = readAccessor(p.indices, "u32") as Uint32Array;
      else {
        indices = new Uint32Array(vcount);
        for (let i = 0; i < vcount; i++) indices[i] = i;
      }
      if (at.NORMAL === undefined) computeNormals(positions, indices, normals);
      return { positions, normals, uvs, joints, weights, indices, material: p.material ?? -1 };
    }),
  }));

  // Materials (+ embedded images → ImageBitmap).
  const imageCache = new Map<number, Promise<ImageBitmap | undefined>>();
  const loadImage = (imageIndex: number): Promise<ImageBitmap | undefined> => {
    if (!imageCache.has(imageIndex)) {
      const img = json!.images?.[imageIndex];
      const p = (async () => {
        if (!img) return undefined;
        if (img.uri) throw new GltfError(`${url}: external image ${img.uri} is not supported`);
        const v = viewBytes(img.bufferView);
        const blob = new Blob([new Uint8Array(v.buf, v.offset, v.length)], { type: img.mimeType ?? "image/png" });
        return createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      })();
      imageCache.set(imageIndex, p);
    }
    return imageCache.get(imageIndex)!;
  };
  // One sampler per glTF sampler index; a problem with one is reported once, however many materials use it.
  const samplerCache = new Map<number, GltfSampler>();
  const textureSampler = (index: number | undefined): GltfSampler => {
    if (index === undefined) return { ...DEFAULT_GLTF_SAMPLER };
    let s = samplerCache.get(index);
    if (!s) {
      const raw = json!.samplers?.[index];
      const warn = (message: string) => console.warn(`${url}: sampler ${index}: ${message}`);
      if (raw && typeof raw === "object") s = samplerOptions(raw, warn);
      else {
        warn("is missing; using the default (linear, mipmapped, repeat)");
        s = { ...DEFAULT_GLTF_SAMPLER };
      }
      samplerCache.set(index, s);
    }
    return { ...s };
  };
  const materials: GltfMaterial[] = await Promise.all(
    (json.materials ?? []).map(async (m: Json, i: number): Promise<GltfMaterial> => {
      const pbr = m.pbrMetallicRoughness ?? {};
      const bc = pbr.baseColorFactor ?? [1, 1, 1, 1];
      let texture: ImageBitmap | undefined;
      let sampler: GltfSampler | undefined;
      if (pbr.baseColorTexture && options.textures !== false) {
        const tex = json!.textures?.[pbr.baseColorTexture.index];
        if (tex && tex.source !== undefined) {
          sampler = textureSampler(tex.sampler);
          texture = await loadImage(tex.source);
          if (!texture) sampler = undefined;
        }
      }
      const em = m.emissiveFactor ?? [0, 0, 0];
      const strength = m.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
      const name = m.name ?? `material_${i}`;
      return {
        name,
        baseColor: [bc[0], bc[1], bc[2], bc[3]],
        emissive: [em[0], em[1], em[2]],
        emissiveStrength: strength,
        texture,
        sampler,
        doubleSided: !!m.doubleSided,
        roughness: pbr.roughnessFactor ?? 1,
        ...materialOptions(m, (message) => console.warn(`${url}: material ${name}: ${message}`)),
      };
    }),
  );

  // Skins.
  const skins: GltfSkin[] = (json.skins ?? []).map((s: Json) => {
    const joints: number[] = s.joints;
    let inverseBind: Float32Array;
    if (s.inverseBindMatrices !== undefined) inverseBind = readAccessor(s.inverseBindMatrices, "f32") as Float32Array;
    else {
      inverseBind = new Float32Array(joints.length * 16);
      for (let j = 0; j < joints.length; j++) inverseBind.set(IDENTITY, j * 16);
    }
    return { joints, inverseBind };
  });

  // Animation clips.
  const clips: GltfClip[] = (json.animations ?? []).map((a: Json, ai: number) => {
    let duration = 0;
    const channels: GltfChannel[] = [];
    for (const ch of a.channels ?? []) {
      const path = ch.target?.path;
      if (ch.target?.node === undefined || !["translation", "rotation", "scale"].includes(path)) continue; // weights/pointer unsupported
      const smp = a.samplers[ch.sampler];
      const times = readAccessor(smp.input, "f32") as Float32Array;
      const values = readAccessor(smp.output, "f32") as Float32Array;
      duration = Math.max(duration, times[times.length - 1] ?? 0);
      channels.push({ node: ch.target.node, path, times, values, interp: smp.interpolation ?? "LINEAR" });
    }
    return { name: a.name ?? `clip_${ai}`, duration, channels };
  });

  const scene = json.scenes?.[json.scene ?? 0];
  const roots: number[] = scene?.nodes ?? nodes.map((n, i) => (n.parent < 0 ? i : -1)).filter((i) => i >= 0);

  return { url, nodes, meshes, materials, skins, clips, roots, extensionsUsed: json.extensionsUsed ?? [] };
}

/** Nodes that are never drawn: gameplay colliders (`col_*`) and markers (`mk_*`), per the asset contract. */
export const isColliderNode = (name: string) => name.startsWith("col_") || name.startsWith("mk_");

export function findNode(doc: GltfDoc, name: string): number {
  return doc.nodes.findIndex((n) => n.name === name);
}

export const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Column-major T * R * S into `out` at float offset `o`. */
export function composeTRS(out: Float32Array, o: number, t: ArrayLike<number>, r: ArrayLike<number>, s: ArrayLike<number>) {
  const [x, y, z, w] = [r[0], r[1], r[2], r[3]];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[o + 0] = (1 - (yy + zz)) * s[0];
  out[o + 1] = (xy + wz) * s[0];
  out[o + 2] = (xz - wy) * s[0];
  out[o + 3] = 0;
  out[o + 4] = (xy - wz) * s[1];
  out[o + 5] = (1 - (xx + zz)) * s[1];
  out[o + 6] = (yz + wx) * s[1];
  out[o + 7] = 0;
  out[o + 8] = (xz + wy) * s[2];
  out[o + 9] = (yz - wx) * s[2];
  out[o + 10] = (1 - (xx + yy)) * s[2];
  out[o + 11] = 0;
  out[o + 12] = t[0];
  out[o + 13] = t[1];
  out[o + 14] = t[2];
  out[o + 15] = 1;
}

/** out[o..o+16] = a[ao..] * b[bo..] (column-major). `out` may alias neither input region. */
export function mulMat(out: Float32Array, o: number, a: Float32Array, ao: number, b: Float32Array, bo: number) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[bo + c * 4], b1 = b[bo + c * 4 + 1], b2 = b[bo + c * 4 + 2], b3 = b[bo + c * 4 + 3];
    out[o + c * 4 + 0] = a[ao + 0] * b0 + a[ao + 4] * b1 + a[ao + 8] * b2 + a[ao + 12] * b3;
    out[o + c * 4 + 1] = a[ao + 1] * b0 + a[ao + 5] * b1 + a[ao + 9] * b2 + a[ao + 13] * b3;
    out[o + c * 4 + 2] = a[ao + 2] * b0 + a[ao + 6] * b1 + a[ao + 10] * b2 + a[ao + 14] * b3;
    out[o + c * 4 + 3] = a[ao + 3] * b0 + a[ao + 7] * b1 + a[ao + 11] * b2 + a[ao + 15] * b3;
  }
}

/**
 * World matrices (rest pose) for every node, 16 floats per node, column-major.
 * `root` optionally places the whole scene (defaults to identity).
 */
export function worldMatrices(doc: GltfDoc, root: Float32Array = IDENTITY): Float32Array {
  const n = doc.nodes.length;
  const local = new Float32Array(16);
  const out = new Float32Array(n * 16);
  const visit = (i: number, parent: Float32Array, po: number) => {
    const node = doc.nodes[i];
    composeTRS(local, 0, node.t, node.r, node.s);
    mulMat(out, i * 16, parent, po, local, 0);
    for (const c of node.children) visit(c, out, i * 16);
  };
  for (const r of doc.roots) visit(r, root, 0);
  // Nodes not reachable from the scene roots still get a sensible transform.
  doc.nodes.forEach((node, i) => {
    if (node.parent < 0 && !doc.roots.includes(i)) visit(i, root, 0);
  });
  return out;
}

/** Decompose a column-major TRS matrix (no shear). */
function decompose(m: number[]): [[number, number, number], [number, number, number, number], [number, number, number]] {
  const sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx;
  const r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy;
  const r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;
  const tr = r00 + r11 + r22;
  let q: [number, number, number, number];
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, 0.25 * s];
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    q = [0.25 * s, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    q = [(r01 + r10) / s, 0.25 * s, (r12 + r21) / s, (r02 - r20) / s];
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
    q = [(r02 + r20) / s, (r12 + r21) / s, 0.25 * s, (r10 - r01) / s];
  }
  return [[m[12], m[13], m[14]], q, [sx, sy, sz]];
}

function computeNormals(p: Float32Array, idx: Uint32Array, out: Float32Array) {
  out.fill(0);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      out[k] += nx;
      out[k + 1] += ny;
      out[k + 2] += nz;
    }
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= l;
    out[i + 1] /= l;
    out[i + 2] /= l;
  }
}

/** Summary numbers for info panels. */
export function docStats(doc: GltfDoc) {
  let triangles = 0;
  let primitives = 0;
  const meshUse = new Map<number, number>();
  doc.nodes.forEach((n) => n.mesh >= 0 && meshUse.set(n.mesh, (meshUse.get(n.mesh) ?? 0) + 1));
  for (const [mi, uses] of meshUse) {
    for (const p of doc.meshes[mi].primitives) {
      triangles += (p.indices.length / 3) * uses;
      primitives += uses;
    }
  }
  return {
    nodes: doc.nodes.length,
    meshes: doc.meshes.length,
    instancedPrimitives: primitives,
    instancedTriangles: triangles,
    materials: doc.materials.length,
    textures: doc.materials.filter((m) => m.texture).length,
    joints: doc.skins.reduce((a, s) => a + s.joints.length, 0),
    clips: doc.clips.map((c) => ({ name: c.name, duration: c.duration })),
  };
}
