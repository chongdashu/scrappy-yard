// Model data, animation poses and material edits shared by both graphics backends.
// GPU resources are private to ModelDriver; instances share geometry, not pose/material state.
import { composeTRS, IDENTITY, isColliderNode, mulMat, MATERIAL_KINDS, type AlphaMode, type GltfDoc, type GltfMaterial } from "../gltf/glb";
import type { Renderer } from "./renderer";

/** What `prepareSkinned` draws from: an `Animator` (clips) or a `SkinPose` (world-space bone transforms). */
export interface SkinnedPose {
  /** World matrices of every node, 16 floats per node. */
  readonly world: Float32Array;
  /** Per skin joint: world(joint) · inverseBind. */
  readonly jointMatrices: Float32Array;
}

export interface ModelGeometry {
  vertices: Float32Array;
  indices: Uint32Array;
  skin?: Uint8Array;
  hull: Float32Array;
}
export interface GpuPrimitive {
  node: number;
  geometry: ModelGeometry;
  indexCount: number;
  skinned: boolean;
  material: number;
  mesh: number;
  primitive: number;
  /** Centre of the primitive's bounds in its mesh space (bind space when skinned): the translucent pass sorts by it. */
  center: [number, number, number];
}
/** A backend-neutral uploaded model handle. Retains the historical name for game imports. */
export interface GpuModel {
  doc: GltfDoc;
  primitives: GpuPrimitive[];
  world: Float32Array;
  hidden: Uint8Array;
  matBase: Float32Array;
  drawBase: Uint32Array;
  nodes: Float32Array;
  joints: Float32Array;
  materials: Float32Array;
  draws: Uint32Array;
  params: Float32Array;
}
/** What a model driver holds on the GPU right now (buffers and textures it created and has not freed). */
export interface GpuResourceCounts {
  buffers: number;
  textures: number;
  /** Bytes in those buffers (textures are counted by number only). */
  bytes: number;
}
/** One BLEND primitive for the translucent pass (`model.primitives[primitive]`), already sorted back to front. */
export interface TranslucentDraw {
  model: GpuModel;
  primitive: number;
}
export interface ModelDriver {
  upload(model: GpuModel, source: GpuModel | null): void;
  update(model: GpuModel): void;
  retexture(model: GpuModel, material: number, image: ImageBitmap | OffscreenCanvas | null): void;
  /** Opaque and MASK primitives (fill, ink, shadow casters). BLEND primitives are left to `drawTranslucent`. */
  draw(models: readonly GpuModel[], outline: boolean, shadow: boolean): { draws: number; triangles: number };
  /** BLEND primitives in the given order, inside the renderer's translucent hooks. A driver without it never draws them. */
  drawTranslucent?(items: readonly TranslucentDraw[]): { draws: number; triangles: number };
  /**
   * Free the GPU resources of models: a source with its geometry (release it only with all its instances), an instance with only its own buffers.
   * Image textures are shared by every source that uses the same ImageBitmap (and, on WebGL, the same sampler) and go with the last of them.
   */
  release?(models: readonly GpuModel[]): void;
  /** Live GPU resource counts (for leak checks). */
  resources?(): GpuResourceCounts;
}
/** Per-draw options shared by prepareStatic/prepareSkinned. */
export interface DrawOptions {
  /** Whole-model hit flash 0..1 (mixes toward white). */
  flash?: number;
  /** Extra emissive multiplier (0 = as authored). */
  glow?: number;
}

export interface StaticOptions extends DrawOptions {
  skip?: (nodeName: string) => boolean;
  /** node → world matrix; descendants follow the overridden node. */
  override?: Map<number, Float32Array>;
  /** node → hit flash 0..1 (applies to the node's own primitives). */
  tint?: Map<number, number>;
  /** Places the whole model (defaults to identity). */
  root?: Float32Array;
}

const NODE_FLOATS = 20; // mat4 + vec4
/** Extra material slots per model for node-scoped recolours. */
const SPARE_MATERIALS = 16;
/**
 * Floats per material slot (`Material` in model.wgsl): base rgba | emissive rgb × strength, has texture |
 * gloss, kind, alpha mode, alpha cutoff. Kind is the index in MATERIAL_KINDS; alpha mode is ALPHA_MODE.
 */
export const MAT_FLOATS = 12;
export const ALPHA_MODE: Record<AlphaMode, number> = { OPAQUE: 0, MASK: 1, BLEND: 2 };
const PARAM_FLOATS = 4;

/** The 12 floats of a material slot. */
export function materialSlot(m: GltfMaterial): number[] {
  const s = m.emissiveStrength;
  return [
    ...m.baseColor,
    m.emissive[0] * s, m.emissive[1] * s, m.emissive[2] * s, m.texture ? 1 : 0,
    1 - (m.roughness ?? 0.6), Math.max(0, MATERIAL_KINDS.indexOf(m.kind ?? "default")), ALPHA_MODE[m.alphaMode ?? "OPAQUE"], m.alphaCutoff ?? 0.5,
  ];
}

/** The alpha mode (ALPHA_MODE value) of primitive `i` as drawn now (recolours may point it at a spare slot). */
export function alphaModeOf(model: GpuModel, i: number): number {
  return model.materials[model.draws[i * 4 + 1] * MAT_FLOATS + 10];
}

// (Defined with the GLB parser, so code without a GPU, such as a game server reading colliders, can use it; re-exported for older imports.)
export { isColliderNode } from "../gltf/glb";

export class ModelRenderer {
  castShadows = true;
  flatten = 0;
  outline = 1;
  /** Last frame's draws: `translucent` of them in the translucent pass (counted into draws and triangles once it has run). */
  stats = { draws: 0, triangles: 0, translucent: 0 };
  private queue: GpuModel[] = [];
  /** Models drawn this frame, kept for their BLEND primitives until the renderer's translucent pass. */
  private drawn: GpuModel[] = [];
  private driver: ModelDriver;
  constructor(renderer: Renderer) {
    this.driver = renderer.createModelDriver();
    renderer.shadowHooks.push(() => this.drawShadow());
    // (Older renderer subclasses without translucent hooks simply never draw BLEND primitives.)
    renderer.translucentHooks?.push((eye) => this.drawTranslucent(eye));
  }
  drawShadow() { if (this.castShadows) this.driver.draw(this.queue, false, true); }
  /** Opaque and MASK primitives now (from a scene hook); BLEND primitives wait for the translucent pass. */
  draw() {
    this.stats = { ...this.driver.draw(this.queue, this.outline > 0, false), translucent: 0 };
    for (const m of this.queue) this.drawn.push(m);
    this.queue.length = 0;
  }
  /**
   * The BLEND primitives of the models drawn this frame, back to front by the distance from `eye` to each
   * primitive's bounds centre (one order per primitive: triangles inside a primitive are not sorted, so
   * intersecting or self-overlapping translucent surfaces can show the wrong one in front).
   */
  drawTranslucent(eye: readonly [number, number, number]) {
    const items: (TranslucentDraw & { d: number })[] = [];
    const seen = new Set<GpuModel>();
    for (const model of this.drawn) {
      if (seen.has(model)) continue;
      seen.add(model);
      model.primitives.forEach((p, i) => {
        if (model.hidden[p.node] || alphaModeOf(model, i) !== ALPHA_MODE.BLEND) return;
        // Skinned: the first joint's skinning matrix places the bind-space centre near where the skin is now.
        const m = p.skinned ? model.joints : model.world;
        const o = p.skinned ? 0 : p.node * 16;
        const [x, y, z] = p.center;
        const dx = m[o] * x + m[o + 4] * y + m[o + 8] * z + m[o + 12] - eye[0];
        const dy = m[o + 1] * x + m[o + 5] * y + m[o + 9] * z + m[o + 13] - eye[1];
        const dz = m[o + 2] * x + m[o + 6] * y + m[o + 10] * z + m[o + 14] - eye[2];
        items.push({ model, primitive: i, d: dx * dx + dy * dy + dz * dz });
      });
    }
    this.drawn.length = 0;
    if (!items.length || !this.driver.drawTranslucent) return;
    items.sort((a, b) => b.d - a.d);
    const r = this.driver.drawTranslucent(items);
    this.stats.draws += r.draws;
    this.stats.triangles += r.triangles;
    this.stats.translucent = r.draws;
  }
  upload(doc: GltfDoc): GpuModel {
    // One buffer set per mesh primitive, shared by every node that uses the mesh.
    const shared = doc.meshes.map((m) =>
      m.primitives.map((p) => {
        const n = p.positions.length / 3;
        const inter = new Float32Array(n * 8);
        for (let i = 0; i < n; i++) {
          inter.set(p.positions.subarray(i * 3, i * 3 + 3), i * 8);
          inter.set(p.normals.subarray(i * 3, i * 3 + 3), i * 8 + 3);
          if (p.uvs) inter.set(p.uvs.subarray(i * 2, i * 2 + 2), i * 8 + 6);
        }
        let skin: Uint8Array | undefined;
        if (p.joints && p.weights) {
          const raw = new ArrayBuffer(n * 24);
          const u16 = new Uint16Array(raw);
          const f32 = new Float32Array(raw);
          for (let i = 0; i < n; i++) {
            for (let k = 0; k < 4; k++) u16[i * 12 + k] = p.joints[i * 4 + k];
            // Renormalize weights (exporters can drift slightly from 1).
            const w0 = p.weights[i * 4], w1 = p.weights[i * 4 + 1], w2 = p.weights[i * 4 + 2], w3 = p.weights[i * 4 + 3];
            const sum = w0 + w1 + w2 + w3 || 1;
            f32.set([w0 / sum, w1 / sum, w2 / sum, w3 / sum], i * 6 + 2);
          }
          skin = new Uint8Array(raw);
        }
        return {
          geometry: { vertices: inter, indices: p.indices, skin, hull: hullNormals(p.positions, p.normals) },
          material: p.material,
          center: boundsCenter(p.positions),
        };
      }),
    );
    const primitives: GpuPrimitive[] = [];
    doc.nodes.forEach((node, ni) => {
      if (node.mesh < 0) return;
      shared[node.mesh].forEach((s, pi) => {
        primitives.push({
          node: ni,
          geometry: s.geometry,
          indexCount: s.geometry.indices.length,
          skinned: node.skin >= 0 && !!s.geometry.skin,
          material: s.material,
          mesh: node.mesh,
          primitive: pi,
          center: s.center,
        });
      });
    });

    return this.createModel(doc, primitives, null);
  }

  /**
   * Another copy of an uploaded model: shares vertex/index/skin buffers and
   * textures, but owns its node/joint/material buffers, so each copy can be
   * posed, recoloured and flashed independently in the same frame.
   */
  instance(source: GpuModel): GpuModel {
    return this.createModel(source.doc, source.primitives, source);
  }

  private createModel(doc: GltfDoc, primitives: GpuPrimitive[], source: GpuModel | null): GpuModel {
    // Materials (+ a default for primitives without one).
    const defaultMat = doc.materials.length;
    // Spare slots after the default let recolor() give one node its own copy of a shared material.
    const matData = new Float32Array((doc.materials.length + 1 + SPARE_MATERIALS) * MAT_FLOATS);
    doc.materials.forEach((m, i) => matData.set(materialSlot(m), i * MAT_FLOATS));
    matData.set([0.8, 0.8, 0.8, 1, 0, 0, 0, 0, 0.3, 0, 0, 0.5], defaultMat * MAT_FLOATS);
    const drawData = new Uint32Array(Math.max(1, primitives.length) * 4);
    primitives.forEach((p, i) => drawData.set([p.node, p.material >= 0 ? p.material : defaultMat, 0, 0], i * 4));

    const n = doc.nodes.length;
    const jointCount = doc.skins.reduce((a, skin) => Math.max(a, skin.joints.length), 0);
    const model: GpuModel = {
      doc, primitives, world: new Float32Array(n * 16), hidden: new Uint8Array(n),
      matBase: matData, drawBase: drawData,
      nodes: new Float32Array(n * NODE_FLOATS), joints: new Float32Array(Math.max(1, jointCount) * 16),
      materials: new Float32Array(matData), draws: new Uint32Array(drawData), params: new Float32Array(PARAM_FLOATS),
    };
    this.driver.upload(model, source);
    this.prepareStatic(model); // sensible defaults until the caller prepares
    this.queue.pop(); // remove only this default preparation; preserve already queued draws
    return model;
  }

  retexture(model: GpuModel, material: number, image: ImageBitmap | OffscreenCanvas | null) {
    this.driver.retexture(model, material, image);
  }

  /**
   * Free the GPU resources of models that will not be drawn again. A source (from `upload`) takes its geometry and textures with it, so release a source only
   * together with every instance made from it; instances (from `instance`) can be released alone, and give back only what is theirs. A texture another source
   * still uses (the same ImageBitmap: the same doc uploaded twice, or docs built from one) stays until that source goes too. They leave the draw queue. A
   * backend without `release` keeps them (the garbage collector gets the handles when the models are unreachable).
   */
  release(models: readonly GpuModel[]): void {
    const gone = new Set(models);
    this.queue = this.queue.filter((m) => !gone.has(m));
    this.drawn = this.drawn.filter((m) => !gone.has(m));
    this.driver.release?.(models);
  }

  /** Live GPU buffer and texture counts, or null when the backend does not count (leak checks in tests and drivers). */
  resources(): GpuResourceCounts | null {
    return this.driver.resources?.() ?? null;
  }

  /**
   * Reskin: override base colours (linear RGB). A key is a material name ("mat_body", every use)
   * or "node/material" ("prop_crate_a/mat_wood", only that node's primitives, via a spare
   * material slot). Anything not listed reverts to the file's colours. Semantic material names
   * in the export make reskins pure data.
   *
   * `glow` does the same for the EMISSIVE colour (a neon tube has a dark base colour and a bright emissive one, so the base colour alone
   * changes almost nothing you can see); the file's emissive strength is kept. A node-scoped entry (`node/material`) takes a slot of its
   * own, shared by that pair's colour and glow. Without `glow` this is exactly the base-colour recolour it always was.
   */
  recolor(model: GpuModel, colors: Map<string, [number, number, number]> | null, glow?: Map<string, [number, number, number]> | null): void {
    const mats = new Float32Array(model.matBase);
    const draws = new Uint32Array(model.drawBase);
    const { materials, nodes } = model.doc;
    let spare = materials.length + 1;
    const slots = new Map<string, number>();
    const edit = (key: string, rgb: [number, number, number], at: number, k: number) => {
      const [nodeName, matName] = key.includes("/") ? key.split("/") : [null, key];
      const mi = materials.findIndex((m) => m.name === matName);
      if (mi < 0) return;
      const scaled = k === 1 ? rgb : ([rgb[0] * k, rgb[1] * k, rgb[2] * k] as [number, number, number]);
      if (!nodeName) {
        mats.set(scaled, mi * MAT_FLOATS + at);
        return;
      }
      let slot = slots.get(key);
      if (slot === undefined) {
        if (spare >= materials.length + 1 + SPARE_MATERIALS) return; // out of slots: skip rather than overwrite
        slot = spare++;
        slots.set(key, slot);
        mats.set(model.matBase.subarray(mi * MAT_FLOATS, (mi + 1) * MAT_FLOATS), slot * MAT_FLOATS);
        model.primitives.forEach((p, pi) => {
          if (p.material === mi && nodes[p.node]?.name === nodeName) draws[pi * 4 + 1] = slot!;
        });
      }
      mats.set(scaled, slot * MAT_FLOATS + at);
    };
    for (const [key, rgb] of colors ?? []) edit(key, rgb, 0, 1);
    for (const [key, rgb] of glow ?? []) edit(key, rgb, 4, materials.find((m) => m.name === (key.includes("/") ? key.split("/")[1] : key))?.emissiveStrength ?? 1);
    model.materials.set(mats);
    model.draws.set(draws);
    this.driver.update(model);
  }

  /** Compute node world matrices (rest pose + overrides) and queue a static draw. */
  prepareStatic(model: GpuModel, opts: StaticOptions = {}): void {
    const { doc } = model;
    const local = new Float32Array(16);
    const root = opts.root ?? IDENTITY;
    const visit = (i: number, parent: Float32Array, po: number, hidden: boolean) => {
      const node = doc.nodes[i];
      const ov = opts.override?.get(i);
      if (ov) model.world.set(ov, i * 16);
      else {
        composeTRS(local, 0, node.t, node.r, node.s);
        mulMat(model.world, i * 16, parent, po, local, 0);
      }
      const hide = hidden || isColliderNode(node.name) || (opts.skip?.(node.name) ?? false);
      model.hidden[i] = hide ? 1 : 0;
      for (const c of node.children) visit(c, model.world, i * 16, hide);
    };
    for (const r of doc.roots) visit(r, root, 0, false);
    this.writeNodes(model, opts.tint);
    this.writeParams(model, opts);
    this.driver.update(model);
    this.queue.push(model);
  }

  /** Use an Animator or SkinPose: joints for skinned meshes, node worlds for the rest. */
  prepareSkinned(model: GpuModel, animator: SkinnedPose, opts: DrawOptions & { skip?: (nodeName: string) => boolean } = {}): void {
    model.world.set(animator.world.subarray(0, model.world.length));
    model.doc.nodes.forEach((node, i) => (model.hidden[i] = isColliderNode(node.name) || (opts.skip?.(node.name) ?? false) ? 1 : 0));
    this.writeNodes(model);
    model.joints.set(animator.jointMatrices);
    this.writeParams(model, opts);
    this.driver.update(model);
    this.queue.push(model);
  }

  private writeNodes(model: GpuModel, tint?: Map<number, number>) {
    const n = model.doc.nodes.length;
    const data = model.nodes;
    for (let i = 0; i < n; i++) {
      data.set(model.world.subarray(i * 16, i * 16 + 16), i * NODE_FLOATS);
      data[i * NODE_FLOATS + 16] = tint?.get(i) ?? 0;
    }
  }

  private writeParams(model: GpuModel, opts: DrawOptions) {
    model.params.set([opts.flash ?? 0, this.flatten, this.outline, opts.glow ?? 0]);
  }

}

function boundsCenter(pos: Float32Array): [number, number, number] {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], pos[i + k]);
      hi[k] = Math.max(hi[k], pos[i + k]);
    }
  }
  return pos.length ? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] : [0, 0, 0];
}

/** Normals averaged over vertices that share a position (0.1 mm grid), for
 *  the ink shell: split normals at hard edges would open gaps in it. Where
 *  the average cancels out (two-sided cards), the vertex keeps its own. */
function hullNormals(pos: Float32Array, nrm: Float32Array): Float32Array {
  const n = pos.length / 3;
  const out = new Float32Array(n * 3);
  const groups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos[i * 3] * 1e4)},${Math.round(pos[i * 3 + 1] * 1e4)},${Math.round(pos[i * 3 + 2] * 1e4)}`;
    const g = groups.get(k);
    if (g) g.push(i);
    else groups.set(k, [i]);
  }
  for (const g of groups.values()) {
    let x = 0, y = 0, z = 0;
    for (const i of g) {
      x += nrm[i * 3];
      y += nrm[i * 3 + 1];
      z += nrm[i * 3 + 2];
    }
    const l = Math.hypot(x, y, z);
    for (const i of g) {
      if (l > 1e-3 * g.length) out.set([x / l, y / l, z / l], i * 3);
      else out.set(nrm.subarray(i * 3, i * 3 + 3), i * 3);
    }
  }
  return out;
}

/** Axis-aligned world bounds of all drawable (non-collider) geometry in a model. */
export function modelBounds(model: GpuModel): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const seen = new Set<string>();
  for (const p of model.primitives) {
    if (model.hidden[p.node]) continue;
    const key = `${p.node}:${p.mesh}:${p.primitive}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pos = model.doc.meshes[p.mesh].primitives[p.primitive].positions;
    const m = model.world.subarray(p.node * 16, p.node * 16 + 16);
    // Skinned meshes are bound in world space by their joints; treat as identity.
    const ident = p.skinned;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const wx = ident ? x : m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = ident ? y : m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = ident ? z : m[2] * x + m[6] * y + m[10] * z + m[14];
      if (wx < min[0]) min[0] = wx;
      if (wy < min[1]) min[1] = wy;
      if (wz < min[2]) min[2] = wz;
      if (wx > max[0]) max[0] = wx;
      if (wy > max[1]) max[1] = wy;
      if (wz > max[2]) max[2] = wz;
    }
  }
  return { min, max };
}
