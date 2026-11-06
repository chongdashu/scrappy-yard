// The gym's player: the rigged raccoon GLB (char_raccoon_player) drawn at the sim's render pose,
// with idle / run / jump / land picked from sim state and short crossfades between them. The
// pattern matches the character test scene (loadGlb → ModelRenderer → Animator). If the GLB fails
// to load, `PlayerModel.load` returns null and the gym keeps its placeholder shapes.
// `swap(id)` hot-reloads another roster GLB for the Customise preview without stacking sceneHooks.
import { Animator, type Layer } from "@engine/gltf/animator";
import { composeTRS, loadGlb } from "@engine/gltf/glb";
import { ModelRenderer, type GpuModel } from "@engine/gpu/model";
import type { GameRuntime } from "@engine/runtime";
import { ASSETS } from "./assets";
import { measure } from "./character";
import { PL } from "./sim-abi";

/** The sim's run speed (params.rs): the run clip's stride is authored against it. */
const RUN_SPEED = 8;
/**
 * Run-clip playback rate at RUN_SPEED. The clip holds two strides in 1.25 s (0.625 s a cycle at
 * 1×), which read as gliding at 8 m/s; 2× gives 0.31 s cycles (~6.4 steps/s). Scales with speed,
 * so a stumble (0.4× speed) slows the legs too. Idle / jump / land play at their own rates.
 */
export const RUN_RATE = 2;
/** The sim's jump airtime (JUMP_SPEED 7.6, GRAVITY 24). */
const AIRTIME = (2 * 7.6) / 24;
/** Crossfade between clips (s). */
const FADE = 0.12;

type Pose = { clip: string; time: number; loop: boolean };

export class PlayerModel {
  private root = new Float32Array(16);
  private clip = "idle";
  private clipTime = 0;
  private prev: Pose | null = null;
  private fade = 1;
  private runTime = 0;
  private airTime = 0;
  private landTime = Infinity;
  private wasGrounded = true;
  /** Uniform scale to the contract height and the lift that puts the feet on y = 0. */
  private scale = 1;
  private lift = 0;
  private skinId: string;
  private model: GpuModel;
  private animator: Animator;
  /** Monotonic token so a slow swap does not clobber a newer browse. */
  private swapGen = 0;
  /** False while a hot-swap is loading — draw() is a no-op so the old mesh never lingers. */
  private visible = true;
  height: number;

  private constructor(
    private rt: GameRuntime,
    private models: ModelRenderer,
    model: GpuModel,
    animator: Animator,
    rest: [number[], number[]] | null,
    target: number,
    skinId: string,
  ) {
    this.model = model;
    this.animator = animator;
    this.skinId = skinId;
    this.applyRest(rest, target);
    this.height = rest ? (rest[1][1] - rest[0][1]) * this.scale : target;
  }

  private applyRest(rest: [number[], number[]] | null, target: number) {
    this.scale = 1;
    this.lift = 0;
    if (rest) {
      const h = rest[1][1] - rest[0][1];
      // Only rescale when the export is noticeably off the contract height (±5%).
      if (h > 0 && Math.abs(h / target - 1) > 0.05) this.scale = target / h;
      this.lift = -rest[0][1] * this.scale;
    }
    this.height = rest ? (rest[1][1] - rest[0][1]) * this.scale : target;
  }

  static async load(rt: GameRuntime, progress: (p: number, label?: string) => void, id = "char_raccoon_player"): Promise<PlayerModel | null> {
    const spec = ASSETS.find((a) => a.id === id);
    if (!spec) return null;
    progress(0.3, `Loading ${spec.id}…`);
    try {
      const doc = await loadGlb(new URL(spec.url, document.baseURI).href);
      if (!doc.skins.length) throw new Error("no skin");
      const animator = new Animator(doc);
      const models = new ModelRenderer(rt.renderer);
      rt.renderer.sceneHooks.push(() => models.draw());
      const pm = new PlayerModel(rt, models, models.upload(doc), animator, measure(doc), spec.size[1], id);
      progress(0.9, "Runner ready");
      return pm;
    } catch (e) {
      console.warn(`[gym] ${spec.url} did not load; the player stays a placeholder`, e);
      return null;
    }
  }

  info() {
    return { loaded: true, clip: this.clip, time: this.clipTime, scale: this.scale, height: this.height, clips: this.animator.clipNames, id: this.skinId, visible: this.visible };
  }

  /** Currently drawn asset id (owned selection or customise preview). */
  id() {
    return this.skinId;
  }

  /**
   * Hot-swap the drawn GLB for Customise browsing (and Select). Hides the current mesh
   * immediately (no stale/half-swapped look), loads the new GLB, then reveals it. Reuses the
   * same ModelRenderer / sceneHook; releases the previous GpuModel only after the new one is
   * ready. Safe to call for locked skins (preview only — persistence is setSkin's job).
   */
  async swap(id: string): Promise<boolean> {
    if (id === this.skinId && this.visible) return true;
    const spec = ASSETS.find((a) => a.id === id);
    if (!spec) return false;
    const gen = ++this.swapGen;
    const prevId = this.skinId;
    // Drop the old mesh from the frame right away — do not leave it up while loading.
    this.visible = false;
    this.skinId = id;
    try {
      const doc = await loadGlb(new URL(spec.url, document.baseURI).href);
      if (gen !== this.swapGen) return false; // a newer browse won
      if (!doc.skins.length) throw new Error("no skin");
      const animator = new Animator(doc);
      const next = this.models.upload(doc);
      const prev = this.model;
      this.model = next;
      this.animator = animator;
      this.applyRest(measure(doc), spec.size[1]);
      // Reset to idle so the menu keeps a calm pose after a swap.
      this.clip = "idle";
      this.clipTime = 0;
      this.prev = null;
      this.fade = 1;
      this.runTime = 0;
      this.models.release([prev]);
      this.visible = true;
      return true;
    } catch (e) {
      console.warn(`[gym] swap to ${spec.url} failed`, e);
      if (gen !== this.swapGen) return false;
      // Keep the previous mesh; put it back on screen.
      this.skinId = prevId;
      this.visible = true;
      return false;
    }
  }

  private has(c: string) {
    return this.animator.clipNames.includes(c);
  }

  private dur(c: string) {
    return this.animator.clipDuration(c) || 0.001;
  }

  private set(clip: string, time: number, loop: boolean) {
    if (clip !== this.clip) {
      this.prev = { clip: this.clip, time: this.clipTime, loop: this.clip === "run" || this.clip === "idle" };
      this.fade = 0;
      this.clip = clip;
    }
    this.clipTime = time;
    return { clip, time, loop };
  }

  /** Pick the clip from sim state and draw at the render pose. */
  /**
   * `deadT`: seconds since game over (< 0 while alive). Dead: crossfade to idle (no run loop) and
   * tip back procedurally. A real `death`/`stumble` clip can replace the procedural tip later.
   */
  draw(p: Float32Array, dt: number, landSquash: number, flash: number, deadT = -1) {
    if (!this.visible) return;
    const dead = deadT >= 0;
    const grounded = dead || p[PL.grounded] > 0.5;
    const speed = dead ? 0 : p[PL.speed];
    this.fade = Math.min(1, this.fade + dt / FADE);
    if (this.prev && !this.prev.loop) this.prev.time = Math.min(this.prev.time, this.dur(this.prev.clip));
    else if (this.prev) this.prev.time += dt * (this.prev.clip === "run" ? RUN_RATE * Math.max(0.3, speed / RUN_SPEED) : 1);
    this.runTime += dt * RUN_RATE * Math.max(0.3, speed / RUN_SPEED);

    if (!grounded && this.wasGrounded) this.airTime = 0;
    if (grounded && !this.wasGrounded) this.landTime = 0;
    this.wasGrounded = grounded;

    let cur: Pose;
    if (dead) {
      cur = this.has("idle") ? this.set("idle", this.clip === "idle" ? this.clipTime : 0, true) : { clip: this.clip, time: this.clipTime, loop: false };
    } else if (!grounded && this.has("jump")) {
      this.airTime += dt;
      // Stretch the jump clip over the sim airtime; hold the last frame while falling into a gap.
      cur = this.set("jump", Math.min(this.dur("jump"), this.airTime * (this.dur("jump") / AIRTIME)), false);
    } else if (this.landTime < this.dur("land") && this.has("land") && speed > 0.5) {
      this.landTime += dt;
      cur = this.set("land", Math.min(this.landTime, this.dur("land")), false);
    } else if (speed > 0.5 && this.has("run")) {
      cur = this.set("run", this.runTime, true);
    } else {
      cur = this.set("idle", this.clip === "idle" ? this.clipTime + dt : 0, true);
    }

    const layers: Layer[] = [];
    if (this.prev && this.fade < 1) layers.push({ clip: this.prev.clip, time: this.prev.time, loop: this.prev.loop });
    layers.push({ clip: cur.clip, time: cur.time, loop: cur.loop, weight: layers.length ? this.fade : 1 });

    // Root: sim render pose; stumble leans back about X; a landing squashes Y a touch.
    const lean = dead ? deathLean(deadT) : p[PL.stumble] > 0 ? -0.35 * p[PL.stumble] : 0;
    const s = this.scale, sq = 1 - landSquash * 0.12;
    const y = Math.max(-3, p[PL.ry]);
    composeTRS(this.root, 0, [p[PL.rx], y + this.lift * sq, p[PL.rz]], [Math.sin(lean / 2), 0, 0, Math.cos(lean / 2)], [s * (1 + landSquash * 0.06), s * sq, s * (1 + landSquash * 0.06)]);
    this.animator.update(layers, this.root);
    this.models.prepareSkinned(this.model, this.animator, { flash });
    if (y > -0.5) this.rt.blob(p[PL.rx], p[PL.rz], 0.36 * (1 - Math.min(0.6, y * 0.3)), 0.55);
  }
}

/** Procedural death tip: ease back about X to −1.2 rad over 0.65 s, then hold. */
export function deathLean(t: number) {
  const u = Math.min(1, Math.max(0, t) / 0.65);
  return -1.2 * (1 - (1 - u) * (1 - u) * (1 - u));
}
