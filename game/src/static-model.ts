// Static (unskinned) GLBs for the gym: the junk mech, oil barrel, scrap car, hex nut and the
// scrapyard lane tile. One `ModelRenderer` holds every source upload; each kind keeps a pool of
// `instance()` copies (shared geometry and textures, own node buffers), so the same GLB can be
// drawn many times a frame. `begin()` rewinds the pools each frame and `put()` places the next
// copy. A GLB that fails to load is simply absent (`get(id)` → null) and the gym keeps its
// placeholder shapes for it.
//
// Loading is progressive: `attach()` registers the drawer, `ensure(id)` fetches one GLB (hot-swaps
// into the map when ready), and `loadBackground(ids)` walks the rest without blocking Play. Soft
// fail: a failed id stays missing for the session.
import { Animator } from "@engine/gltf/animator";
import { composeTRS, loadGlb } from "@engine/gltf/glb";
import { ModelRenderer, type GpuModel } from "@engine/gpu/model";
import type { GameRuntime } from "@engine/runtime";
import { ASSETS } from "./assets";
import { measure as measureSkinned } from "./character";
import { measure } from "./viewer";

export type Quat = [number, number, number, number];
export const QI: Quat = [0, 0, 0, 1];
/** Rotation of `a` radians about the unit axis (x, y, z). */
export const quatAxis = (x: number, y: number, z: number, a: number): Quat => {
  const s = Math.sin(a / 2);
  return [x * s, y * s, z * s, Math.cos(a / 2)];
};
/** a * b (apply b, then a). */
export const quatMul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

export const STATIC_IDS = ["char_junk_mech", "prop_oil_barrel", "prop_scrap_car", "prop_hex_nut", "env_scrapyard_lane", "env_side_terrain",
  "env_tire_stack", "env_corrugated_sheets", "env_pallet_stack", "env_drum_cluster", "env_scrap_pipes", "env_fence_panel", "env_neon_billboard",
  "env_container_stack", "env_scrap_heap", "env_skyline", "env_clouds", "env_crane", "prop_scrap_plane"] as const;
/** Side fill props (Blender); while none is loaded the procedural junk boxes stay. */
export const FILL_IDS: readonly StaticId[] = ["env_tire_stack", "env_corrugated_sheets", "env_pallet_stack", "env_drum_cluster", "env_scrap_pipes", "env_fence_panel"];
export type StaticId = (typeof STATIC_IDS)[number];

/** After the raccoon: lane first (floor), then small nut, then hazards, mech last (behind the player). */
export const STATIC_LOAD_ORDER: readonly StaticId[] = [
  "env_scrapyard_lane",
  "env_side_terrain",
  "prop_hex_nut",
  "prop_oil_barrel",
  "prop_scrap_car",
  "char_junk_mech",
  // Env dressing last (lazy; ~1.3 MB total): small fill, sky, then the Tripo crane + plane.
  "env_tire_stack", "env_drum_cluster", "env_pallet_stack", "env_corrugated_sheets", "env_scrap_pipes", "env_fence_panel", "env_neon_billboard",
  "env_skyline", "env_clouds", "env_container_stack", "env_scrap_heap", "env_crane", "prop_scrap_plane",
];

export class StaticKind {
  private pool: GpuModel[];
  private used = 0;
  private root = new Float32Array(16);
  /** Set when the GLB has a skin (the junk mech): `putAnimated` poses it; one copy only. */
  readonly animator: Animator | null;
  private lastClip = "";
  constructor(private models: ModelRenderer, source: GpuModel, readonly id: string, readonly bounds: [number[], number[]] | null, animator: Animator | null = null) {
    this.pool = [source];
    this.animator = animator;
  }
  get clips(): string[] {
    return this.animator?.clipNames ?? [];
  }
  /** Skinned copy at `t`/`r`/`s`, posed at `clip` (looping) `time` s. Falls back to the rest pose without a rig. */
  putAnimated(t: ArrayLike<number>, r: ArrayLike<number>, s: ArrayLike<number>, clip: string, time: number, flash = 0) {
    if (!this.animator || !this.animator.clipNames.includes(clip)) return this.put(t, r, s, flash);
    this.used++;
    this.lastClip = clip;
    composeTRS(this.root, 0, t, r, s);
    this.animator.update([{ clip, time, loop: true }], this.root);
    this.models.prepareSkinned(this.pool[0], this.animator, { flash });
  }
  get size() {
    const b = this.bounds;
    return b ? [b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]] : null;
  }
  begin() {
    this.used = 0;
  }
  /** Queue one copy at translation `t`, rotation `r`, scale `s` (the GLB pivot goes to `t`). */
  put(t: ArrayLike<number>, r: ArrayLike<number> = QI, s: ArrayLike<number> = [1, 1, 1], flash = 0, glow = 0) {
    if (this.used >= this.pool.length) this.pool.push(this.models.instance(this.pool[0]));
    const m = this.pool[this.used++];
    composeTRS(this.root, 0, t, r, s);
    this.models.prepareStatic(m, { root: this.root, flash, glow });
  }
  info() {
    return { id: this.id, copies: this.pool.length, drawn: this.used, size: this.size, skinned: !!this.animator, clip: this.lastClip || null };
  }
}

export class StaticModels {
  private pending = new Set<string>();
  private missingList: string[] = [];
  private inflight = new Map<string, Promise<void>>();

  private constructor(private models: ModelRenderer, private kinds: Map<string, StaticKind>) {}

  /** Register the static drawer; no GLBs yet (placeholders until `ensure` / `loadBackground`). */
  static attach(rt: GameRuntime): StaticModels {
    const models = new ModelRenderer(rt.renderer);
    rt.renderer.sceneHooks.push(() => models.draw());
    return new StaticModels(models, new Map());
  }

  /**
   * Eager load of every id (viewer / tests). Prefer `attach` + `ensure` / `loadBackground` for Play
   * so the first frame does not wait on ~15 MB of GLBs.
   */
  static async load(rt: GameRuntime, progress: (p: number, label?: string) => void, ids: readonly string[] = STATIC_IDS): Promise<StaticModels> {
    const sm = StaticModels.attach(rt);
    for (const [i, id] of ids.entries()) {
      progress(0.05 + (0.25 * i) / ids.length, `Loading ${id}…`);
      await sm.ensure(id);
    }
    return sm;
  }

  get missing(): string[] {
    return this.missingList;
  }

  get(id: StaticId): StaticKind | null {
    return this.kinds.get(id) ?? null;
  }

  begin() {
    for (const k of this.kinds.values()) k.begin();
  }

  /**
   * Fetch and upload one GLB. Idempotent: already loaded / missing / in-flight is a no-op.
   * Soft-fail: errors land in `missing` and stay placeholders for the session.
   */
  ensure(id: string): Promise<void> {
    if (this.kinds.has(id) || this.missingList.includes(id)) return Promise.resolve();
    const existing = this.inflight.get(id);
    if (existing) return existing;
    this.pending.add(id);
    const work = this.fetchOne(id).finally(() => {
      this.pending.delete(id);
      this.inflight.delete(id);
    });
    this.inflight.set(id, work);
    return work;
  }

  /** Load ids in order without blocking the caller (fire-and-forget). */
  loadBackground(ids: readonly string[]): void {
    void (async () => {
      for (const id of ids) await this.ensure(id);
    })();
  }

  private async fetchOne(id: string) {
    const spec = ASSETS.find((a) => a.id === id);
    if (!spec) {
      console.warn(`[gym] ${id} is not in ASSETS; its placeholder shapes stay`);
      if (!this.missingList.includes(id)) this.missingList.push(id);
      return;
    }
    try {
      const doc = await loadGlb(new URL(spec.url, document.baseURI).href);
      // A concurrent ensure of the same id is deduped via inflight; still guard the map.
      if (this.kinds.has(id)) return;
      const skinned = doc.skins.length > 0;
      this.kinds.set(id, new StaticKind(this.models, this.models.upload(doc), id, skinned ? measureSkinned(doc) : measure(doc), skinned ? new Animator(doc) : null));
    } catch (e) {
      console.warn(`[gym] ${id} did not load; its placeholder shapes stay`, e);
      if (!this.missingList.includes(id)) this.missingList.push(id);
    }
  }

  info() {
    return {
      loaded: [...this.kinds.keys()],
      missing: this.missingList,
      pending: [...this.pending],
      kinds: [...this.kinds.values()].map((k) => k.info()),
    };
  }
}
