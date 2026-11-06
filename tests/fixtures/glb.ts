// A minimal GLB writer for tests: triangle meshes with normals/UVs, materials as raw glTF JSON
// (so alphaMode and extras go through the real loader) and optional embedded PNG images.
export interface GlbMesh {
  positions: number[];
  normals: number[];
  uvs?: number[];
  indices: number[];
  material?: number;
}
export interface GlbInput {
  /** glTF material objects, written as given (texture index n = images[n]). */
  materials: Record<string, unknown>[];
  meshes: GlbMesh[];
  nodes: { name: string; mesh?: number; translation?: [number, number, number]; scale?: [number, number, number] }[];
  /** PNG files; without `textures`, texture i samples image i with no sampler. */
  images?: Uint8Array[];
  /** glTF textures, written as given (`{ source, sampler? }`), in place of one per image. */
  textures?: Record<string, unknown>[];
  /** glTF samplers, written as given (default `[{}]`). */
  samplers?: Record<string, unknown>[];
}

export function buildGlb(input: GlbInput): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  const views: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  let length = 0;
  const addView = (bytes: Uint8Array, target?: number) => {
    chunks.push(bytes);
    const pad = (4 - (bytes.byteLength % 4)) % 4;
    if (pad) chunks.push(new Uint8Array(pad));
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    length += bytes.byteLength + pad;
    return views.length - 1;
  };
  const addAccessor = (data: number[], type: "SCALAR" | "VEC2" | "VEC3", componentType: 5125 | 5126, bounds = false) => {
    const typed = componentType === 5126 ? new Float32Array(data) : new Uint32Array(data);
    const view = addView(new Uint8Array(typed.buffer), componentType === 5126 ? 34962 : 34963);
    const n = type === "VEC3" ? 3 : type === "VEC2" ? 2 : 1;
    const extra: Record<string, unknown> = {};
    if (bounds) {
      extra.min = [0, 1, 2].map((k) => Math.min(...data.filter((_, i) => i % n === k)));
      extra.max = [0, 1, 2].map((k) => Math.max(...data.filter((_, i) => i % n === k)));
    }
    accessors.push({ bufferView: view, componentType, count: data.length / n, type, ...extra });
    return accessors.length - 1;
  };
  const meshes = input.meshes.map((m, i) => {
    const attributes: Record<string, number> = {
      POSITION: addAccessor(m.positions, "VEC3", 5126, true),
      NORMAL: addAccessor(m.normals, "VEC3", 5126),
    };
    if (m.uvs) attributes.TEXCOORD_0 = addAccessor(m.uvs, "VEC2", 5126);
    const indices = addAccessor(m.indices, "SCALAR", 5125);
    return { name: `mesh_${i}`, primitives: [{ attributes, indices, ...(m.material !== undefined ? { material: m.material } : {}) }] };
  });
  const images = (input.images ?? []).map((png) => ({ bufferView: addView(png), mimeType: "image/png" }));
  const json = {
    asset: { version: "2.0", generator: "vgd test glb" },
    scene: 0,
    scenes: [{ nodes: input.nodes.map((_, i) => i) }],
    nodes: input.nodes.map((n) => ({ name: n.name, ...(n.mesh !== undefined ? { mesh: n.mesh } : {}), ...(n.translation ? { translation: n.translation } : {}), ...(n.scale ? { scale: n.scale } : {}) })),
    meshes,
    materials: input.materials,
    ...(images.length ? { images, textures: input.textures ?? images.map((_, i) => ({ source: i })), samplers: input.samplers ?? [{}] } : {}),
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: length }],
  };
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (text.byteLength % 4)) % 4;
  const total = 12 + 8 + text.byteLength + jsonPad + 8 + length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, text.byteLength + jsonPad, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.byteLength, 20 + text.byteLength + jsonPad);
  let o = 20 + text.byteLength + jsonPad;
  dv.setUint32(o, length, true);
  dv.setUint32(o + 4, 0x004e4942, true);
  o += 8;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out.buffer;
}

/** A unit quad in the XY plane facing +Z (two triangles), offset and scaled. */
export function quad(w: number, h: number, material: number): GlbMesh {
  const x = w / 2, y = h / 2;
  return {
    positions: [-x, -y, 0, x, -y, 0, x, y, 0, -x, y, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 1, 1, 1, 1, 0, 0, 0],
    indices: [0, 1, 2, 0, 2, 3],
    material,
  };
}

/** An axis-aligned box centred on its origin. */
export function box(sx: number, sy: number, sz: number, material: number): GlbMesh {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const half = [sx / 2, sy / 2, sz / 2];
  for (const [n, u, v] of faces) {
    const base = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) positions.push((n[k] + u[k] * a + v[k] * b) * half[k]);
      normals.push(...n);
      uvs.push((a + 1) / 2, (1 - b) / 2);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, uvs, indices, material };
}
