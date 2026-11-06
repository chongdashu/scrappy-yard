// Character animation test scene (`?scene=character`, alias `?scene=char-test`): one character
// GLB on a ground plane with an orbit camera, and a clip picker. No gym rules run (the sim is in
// viewer mode). It exists to watch every clip at game speed before the gym swaps its placeholder
// raccoon for the GLB: loop seams, foot contact, stride against the 8 m/s treadmill, the one-shot
// jump → land timing, scale against a 1.1 m post and the +Z front.
//
// Keys: 1–4 (or the buttons) pick a clip · Space next clip · S sequence (run → jump → land → run,
// on the sim's jump timing) · P pause · , / . step a frame while paused · [ / ] speed ·
// T treadmill · X bounds · drag orbit · wheel/pinch zoom.
import type { EyePose, Shot } from "@engine/camera";
import type { InputSnapshot } from "@engine/input";
import type { GameRuntime } from "@engine/runtime";
import { Animator } from "@engine/gltf/animator";
import { IDENTITY, loadGlb, type GltfDoc } from "@engine/gltf/glb";
import { MESH, hex, type InstanceBatch } from "@engine/gpu/meshes";
import { ModelRenderer, type GpuModel } from "@engine/gpu/model";
import { OrbitCamera } from "@engine/preview/orbit";
import { ASSETS } from "./assets";

/** The sim's run speed (params.rs) for the treadmill, and its jump airtime (JUMP_SPEED 7.6, GRAVITY 24). */
const RUN_SPEED = 8;
const AIRTIME = (2 * 7.6) / 24;
const SPEEDS = [0.1, 0.25, 0.5, 1, 1.5, 2];
const ONE_SHOT = new Set(["jump", "land", "stumble"]);
/** Hold the last frame of a one-shot this long before it repeats. */
const HOLD = 0.5;

const COL = {
  floor: hex(0x2c2c34), line: hex(0x4a4a58), lane: hex(0xd8dde6), post: hex(0x39ff88),
  x: hex(0xff4040), y: hex(0x40ff60), z: hex(0x4080ff), measured: hex(0x48f0ff),
};

/** Rest-pose bounds of a skinned GLB (bind-space positions), [min, max]. */
export function measure(doc: GltfDoc): [number[], number[]] | null {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const n of doc.nodes) {
    if (n.mesh < 0) continue;
    for (const p of doc.meshes[n.mesh].primitives) {
      const v = p.positions;
      for (let k = 0; k < v.length; k += 3) for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], v[k + a]); hi[a] = Math.max(hi[a], v[k + a]);
      }
    }
  }
  return Number.isFinite(lo[0]) ? [lo, hi] : null;
}

type Step = { clip: string; until: number };

export class CharacterTest {
  private orbit = new OrbitCamera();
  private clip = 0;
  private time = 0;
  private speed = 3; // index into SPEEDS (1×)
  private paused = false;
  private treadmill = true;
  private sequence = false;
  private seqTime = 0;
  private scroll = 0;
  private root = new Float32Array(16);
  private panel: HTMLElement;
  readonly id: string;

  private constructor(
    private rt: GameRuntime,
    private models: ModelRenderer,
    private model: GpuModel | null,
    private animator: Animator | null,
    private clips: string[],
    private measured: [number[], number[]] | null,
    private status: string,
  ) {
    this.id = ASSETS[0].id;
    this.orbit.maxDistance = 12;
    this.orbit.minDistance = 0.6;
    this.orbit.fovY = (40 * Math.PI) / 180;
    this.orbit.target = [0, 0.6, 0];
    this.orbit.distance = 3.2;
    this.orbit.yaw = 0.55;
    this.orbit.pitch = 0.18;
    this.orbit.attach(rt.canvas, () => {}, () => rt.phase === "playing");
    this.panel = document.createElement("div");
    this.panel.id = "char-panel";
    this.panel.className = "viewer-list char-panel";
    this.panel.addEventListener("click", (e) => this.onClick(e));
    document.body.appendChild(this.panel);
    this.render();
  }

  static async load(rt: GameRuntime, progress: (p: number, label?: string) => void, id = "char_raccoon_player"): Promise<CharacterTest> {
    const models = new ModelRenderer(rt.renderer);
    rt.renderer.sceneHooks.push(() => models.draw());
    const spec = ASSETS.find((a) => a.id === id) ?? ASSETS[0];
    progress(0.2, `Loading ${spec.id}…`);
    try {
      const doc = await loadGlb(new URL(spec.url, document.baseURI).href);
      const animator = doc.skins.length ? new Animator(doc) : null;
      const clips = animator ? animator.clipNames : [];
      // Contract order first (idle, run, jump, land…), then anything extra.
      clips.sort((a, b) => (spec.clips.indexOf(a) + 1 || 99) - (spec.clips.indexOf(b) + 1 || 99));
      progress(1, "Ready");
      return new CharacterTest(rt, models, models.upload(doc), animator, clips, measure(doc), `GLB · ${doc.clips.length} clip(s) · ${doc.skins[0]?.joints.length ?? 0} joints`);
    } catch (e) {
      console.warn(`[character] ${spec.url} did not load; showing a placeholder`, e);
      return new CharacterTest(rt, models, null, null, [], null, "placeholder (no GLB yet)");
    }
  }

  info() {
    return { id: this.id, loaded: !!this.model, clips: this.clips, clip: this.clips[this.clip] ?? null, time: this.time, paused: this.paused, sequence: this.sequence, speed: SPEEDS[this.speed], measured: this.measured };
  }

  reset() {
    this.time = this.seqTime = 0;
  }

  /** Select a clip by index or name (also used by tests through the hooks). */
  pick(c: number | string) {
    const i = typeof c === "number" ? c : this.clips.indexOf(c);
    if (i < 0 || i >= this.clips.length) return;
    this.clip = i;
    this.time = 0;
    this.sequence = false;
    this.render();
  }

  private onClick(e: Event) {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!el) return;
    const act = el.dataset.act!;
    if (act === "clip") this.pick(Number(el.dataset.i));
    else if (act === "seq") this.toggleSequence();
    else if (act === "pause") this.paused = !this.paused;
    else if (act === "slower") this.speed = Math.max(0, this.speed - 1);
    else if (act === "faster") this.speed = Math.min(SPEEDS.length - 1, this.speed + 1);
    else if (act === "tread") this.treadmill = !this.treadmill;
    this.render();
  }

  private toggleSequence() {
    this.sequence = !this.sequence && this.clips.includes("run");
    this.seqTime = 0;
  }

  /** run (1.5 s) → jump (sim airtime) → land → run, on repeat. */
  private seqSteps(): Step[] {
    const has = (c: string) => this.clips.includes(c);
    const steps: Step[] = [{ clip: "run", until: 1.5 }];
    if (has("jump")) steps.push({ clip: "jump", until: 1.5 + AIRTIME });
    if (has("land")) steps.push({ clip: "land", until: steps[steps.length - 1].until + this.duration("land") });
    steps.push({ clip: "run", until: steps[steps.length - 1].until + 1.0 });
    return steps;
  }

  private duration(c: string) {
    return this.animator?.clipDuration(c) ?? 0;
  }

  private render() {
    const sp = SPEEDS[this.speed];
    const m = this.measured ? this.measured[1].map((v, k) => (v - this.measured![0][k]).toFixed(2)).join(" × ") : "—";
    const btns = this.clips.map((c, i) =>
      `<button type="button" class="gym-toggle${!this.sequence && i === this.clip ? " on" : ""}" data-act="clip" data-i="${i}">${i + 1} ${c} <i>${this.duration(c).toFixed(2)}s</i></button>`).join("");
    this.panel.innerHTML = `<b>Character test</b><code>${this.id}</code><span>${this.status} · rest ${m} m (W×H×D)</span>` +
      `<span class="char-clips">${btns || "<i>no clips</i>"}</span>` +
      `<span class="char-clips"><button type="button" class="gym-toggle${this.sequence ? " on" : ""}" data-act="seq">S sequence</button>` +
      `<button type="button" class="gym-toggle${this.paused ? " on" : ""}" data-act="pause">P ${this.paused ? "play" : "pause"}</button>` +
      `<button type="button" class="gym-toggle" data-act="slower">[ −</button><b class="char-speed">${sp}×</b><button type="button" class="gym-toggle" data-act="faster">] +</button>` +
      `<button type="button" class="gym-toggle${this.treadmill ? " on" : ""}" data-act="tread">T treadmill ${RUN_SPEED} m/s</button></span>` +
      `<span>1–${Math.max(1, this.clips.length)} clip · Space next · , . step · X bounds · drag orbit · wheel zoom</span>` +
      `<span id="char-time"></span>`;
  }

  /** Action names are bound in index.ts (charClip1–4, charSeq, charPause, charStepBack/Fwd, charSlower/Faster, charTread). */
  input(snap: InputSnapshot) {
    const k = snap.pressed;
    for (let i = 0; i < Math.min(4, this.clips.length); i++) if (k.has(`charClip${i + 1}`)) this.pick(i);
    if (k.has("jump") && this.clips.length) this.pick((this.clip + 1) % this.clips.length);
    if (k.has("charSeq")) { this.toggleSequence(); this.render(); }
    if (k.has("charPause")) { this.paused = !this.paused; this.render(); }
    if (k.has("charTread")) { this.treadmill = !this.treadmill; this.render(); }
    if (k.has("charSlower")) { this.speed = Math.max(0, this.speed - 1); this.render(); }
    if (k.has("charFaster")) { this.speed = Math.min(SPEEDS.length - 1, this.speed + 1); this.render(); }
    if (this.paused && (k.has("charStepBack") || k.has("charStepFwd"))) {
      const d = (k.has("charStepBack") ? -1 : 1) / 24;
      this.time = Math.max(0, this.time + d);
      this.seqTime = Math.max(0, this.seqTime + d);
    }
  }

  frame(dt: number) {
    if (this.paused) return;
    const d = dt * SPEEDS[this.speed];
    this.time += d;
    this.seqTime += d;
    this.scroll = (this.scroll + d * RUN_SPEED) % 2;
  }

  /** The clip and its local time this frame. */
  private current(): { clip: string; t: number; loop: boolean } | null {
    if (!this.clips.length) return null;
    if (this.sequence) {
      const steps = this.seqSteps();
      const total = steps[steps.length - 1].until;
      const t = this.seqTime % total;
      let start = 0;
      for (const s of steps) {
        if (t < s.until) {
          const lt = t - start;
          return s.clip === "jump" ? { clip: s.clip, t: lt * (this.duration("jump") / AIRTIME), loop: false } : { clip: s.clip, t: lt, loop: !ONE_SHOT.has(s.clip) };
        }
        start = s.until;
      }
    }
    const clip = this.clips[this.clip];
    if (ONE_SHOT.has(clip)) {
      const d = this.duration(clip);
      return { clip, t: Math.min(d, this.time % (d + HOLD)), loop: false };
    }
    return { clip, t: this.time, loop: true };
  }

  eye(): EyePose {
    const aspect = this.rt.canvas.clientWidth / Math.max(1, this.rt.canvas.clientHeight);
    this.orbit.update(aspect);
    const [x, y, z] = this.orbit.eye;
    return { x, y, z, yaw: this.orbit.yaw + Math.PI, pitch: -this.orbit.pitch, fovY: this.orbit.fovY };
  }

  menuShot(t: number): Shot {
    return { target: [0, 0.6, 0], pitch: 0.2, yaw: 0.5 + 0.3 * Math.sin(t * 0.25), distance: 3.4 };
  }

  draw(showBounds: boolean) {
    const box = this.rt.batches[MESH.box];
    // Ground: a 6 m pad with lane lines (1.4 m lanes) and cross stripes every metre that scroll
    // toward −Z at run speed when the treadmill is on, to judge foot slide against the stride.
    box.push(0, -0.05, 0, 0, 0, 0, 6, 0.1, 10, COL.floor, 0.1, 0, 0, 0);
    for (const lx of [-0.7, 0.7]) box.push(lx, 0.004, 0, 0, 0, 0, 0.03, 0.008, 10, COL.lane, 0.2, 0, 0, 0);
    const off = this.treadmill && this.isRunning() ? this.scroll : 0;
    for (let i = -5; i <= 5; i++) {
      const z = i - (off % 1);
      if (z < -5 || z > 5) continue;
      box.push(0, 0.003, z, 0, 0, 0, 6, 0.006, 0.03, COL.line, 0.1, 0, 0, 0);
    }
    // Scale post: 1.1 m (the contract height) a metre to the character's left.
    box.push(-1.0, 0.55, 0, 0, 0, 0, 0.04, 1.1, 0.04, COL.post, 0.4, 0, 0, 0, 1.2);
    box.push(-1.0, 1.1, 0, 0, 0, 0, 0.18, 0.02, 0.02, COL.post, 0.4, 0, 0, 0, 1.2);
    this.axes(box);
    const cur = this.current();
    const el = document.getElementById("char-time");
    if (el && cur) el.textContent = `${cur.clip} ${cur.t.toFixed(2)} / ${this.duration(cur.clip).toFixed(2)} s${this.sequence ? " (sequence)" : ""}`;
    if (this.model) {
      this.root.set(IDENTITY);
      if (this.animator && cur) {
        this.animator.update([{ clip: cur.clip, time: cur.t, loop: cur.loop }], this.root);
        this.models.prepareSkinned(this.model, this.animator);
      } else this.models.prepareStatic(this.model, { root: this.root });
      this.rt.blob(0, 0, 0.36, 0.5);
    } else {
      box.push(0, 0.55, 0, 0, 0, 0, 0.7, 1.1, 0.55, hex(0x7a7f8a), 0.2);
    }
    if (showBounds && this.measured) {
      const [lo, hi] = this.measured;
      this.wire(box, (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2, (hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2, COL.measured);
    }
  }

  private isRunning() {
    const c = this.current();
    return !!c && (c.clip === "run" || this.sequence);
  }

  private axes(box: InstanceBatch) {
    const t = 0.02;
    box.push(0.25, 0.01, 0, 0, 0, 0, 0.5, t, t, COL.x, 0, 0, 0, 0, 1.5);
    box.push(0, 0.01, 0.25, 0, 0, 0, t, t, 0.5, COL.z, 0, 0, 0, 0, 1.5);
  }

  private wire(box: InstanceBatch, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, col: [number, number, number], t = 0.01) {
    for (const sy of [-1, 1]) for (const sz of [-1, 1]) box.push(cx, cy + sy * hy, cz + sz * hz, 0, 0, 0, hx * 2, t, t, col, 0, 0, 0, 0, 2);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box.push(cx + sx * hx, cy, cz + sz * hz, 0, 0, 0, t, hy * 2, t, col, 0, 0, 0, 0, 2);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) box.push(cx + sx * hx, cy + sy * hy, cz, 0, 0, 0, t, t, hz * 2, col, 0, 0, 0, 0, 2);
  }
}
