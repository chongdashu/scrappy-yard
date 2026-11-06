// Asset viewer scene (`?scene=viewer`): lists the contract's asset ids, loads each GLB that
// exists under public/assets/ and shows a placeholder at the contract's target size when it
// doesn't. Every asset sits on its pivot at the origin of its slot, with +X (red), +Y (green) and
// +Z (blue, the front) axis sticks, so a reimport can be checked for scale, pivot and facing.
//
// TODO(blender leg): once rigged GLBs exist, check clip playback here (Space cycles clips),
// measure loop seams and root drift per clip and record them in docs/asset-contract.md.
import type { EyePose, Shot } from "@engine/camera";
import type { InputSnapshot } from "@engine/input";
import type { GameRuntime } from "@engine/runtime";
import { Animator } from "@engine/gltf/animator";
import { IDENTITY, loadGlb, type GltfDoc } from "@engine/gltf/glb";
import { MESH, hex, type InstanceBatch } from "@engine/gpu/meshes";
import { ModelRenderer, type GpuModel } from "@engine/gpu/model";
import { OrbitCamera } from "@engine/preview/orbit";
import { ASSETS, type AssetSpec } from "./assets";

interface Slot {
  spec: AssetSpec;
  x: number;
  model: GpuModel | null;
  animator: Animator | null;
  clips: string[];
  clip: number;
  time: number;
  /** Measured rest-pose bounds of the GLB [min, max], or null. */
  measured: [number[], number[]] | null;
  status: string;
}

const GAP = 1.6;
const COL = { proxy: hex(0x7a7f8a), target: hex(0x39ff88), measured: hex(0x48f0ff), x: hex(0xff4040), y: hex(0x40ff60), z: hex(0x4080ff), floor: hex(0x2c2c34) };

/** Rest-pose bounds of a GLB: node world matrices (from an Animator at rest) times positions. */
export function measure(doc: GltfDoc): [number[], number[]] | null {
  const a = new Animator(doc);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  doc.nodes.forEach((n, i) => {
    if (n.mesh < 0) return;
    const m = a.world.subarray(i * 16, i * 16 + 16);
    for (const p of doc.meshes[n.mesh].primitives) {
      const v = p.positions;
      for (let k = 0; k < v.length; k += 3) {
        // Skinned primitives are in bind space already; their node matrix is the skin root.
        const [x, y, z] = n.skin >= 0 ? [v[k], v[k + 1], v[k + 2]] : [
          m[0] * v[k] + m[4] * v[k + 1] + m[8] * v[k + 2] + m[12],
          m[1] * v[k] + m[5] * v[k + 1] + m[9] * v[k + 2] + m[13],
          m[2] * v[k] + m[6] * v[k + 1] + m[10] * v[k + 2] + m[14],
        ];
        lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); lo[2] = Math.min(lo[2], z);
        hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y); hi[2] = Math.max(hi[2], z);
      }
    }
  });
  return Number.isFinite(lo[0]) ? [lo, hi] : null;
}

export class AssetViewer {
  private orbit = new OrbitCamera();
  private selected = 0;
  private armed = true;
  private list: HTMLElement;
  private root = new Float32Array(16);

  private constructor(private rt: GameRuntime, private slots: Slot[], private models: ModelRenderer) {
    this.orbit.maxDistance = 40;
    this.orbit.fovY = (45 * Math.PI) / 180;
    this.orbit.attach(rt.canvas, () => {}, () => rt.phase === "playing");
    this.list = document.createElement("div");
    this.list.id = "viewer-list";
    this.list.className = "viewer-list";
    document.body.appendChild(this.list);
    this.select(0);
  }

  static async load(rt: GameRuntime, progress: (p: number, label?: string) => void): Promise<AssetViewer> {
    const models = new ModelRenderer(rt.renderer);
    rt.renderer.sceneHooks.push(() => models.draw());
    const slots: Slot[] = [];
    let x = 0;
    for (const [i, spec] of ASSETS.entries()) {
      progress(i / ASSETS.length, `Looking for ${spec.id}…`);
      const slot: Slot = { spec, x: 0, model: null, animator: null, clips: [], clip: 0, time: 0, measured: null, status: "placeholder (no GLB yet)" };
      try {
        const doc = await loadGlb(new URL(spec.url, document.baseURI).href);
        slot.model = models.upload(doc);
        slot.measured = measure(doc);
        if (doc.skins.length) {
          slot.animator = new Animator(doc);
          slot.clips = slot.animator.clipNames;
        }
        slot.status = `GLB loaded · ${doc.clips.length} clip(s)`;
      } catch {
        // Missing (a dev server may answer with index.html, which fails to parse): keep the placeholder.
      }
      const w = slot.measured ? slot.measured[1][0] - slot.measured[0][0] : spec.size[0];
      slot.x = x + w / 2;
      x += w + GAP;
      slots.push(slot);
    }
    // Centre the row on the origin.
    const shift = (x - GAP) / 2;
    for (const s of slots) s.x -= shift;
    return new AssetViewer(rt, slots, models);
  }

  reset() {
    for (const s of this.slots) s.time = 0;
  }

  private select(i: number) {
    this.selected = (i + this.slots.length) % this.slots.length;
    const s = this.slots[this.selected];
    const h = s.measured ? s.measured[1][1] : s.spec.size[1];
    this.orbit.target = [s.x, h * 0.5, 0];
    this.orbit.distance = Math.max(3.2, Math.max(h, s.spec.size[0], s.spec.size[2]) * 2.6);
    this.orbit.yaw = 0.5;
    this.orbit.pitch = 0.25;
    this.renderList();
  }

  private renderList() {
    const rows = this.slots.map((s, i) => {
      const m = s.measured ? s.measured[1].map((v, k) => (v - s.measured![0][k]).toFixed(2)).join(" × ") : "—";
      const clip = s.clips.length ? ` · clip <b>${s.clips[s.clip]}</b>` : s.spec.clips.length ? ` · expects ${s.spec.clips.join(", ")}` : "";
      return `<li class="${i === this.selected ? "on" : ""}"><code>${s.spec.id}</code><span>${s.status}${clip}</span>` +
        `<span>target ${s.spec.size.join(" × ")} m · measured ${m}</span></li>`;
    });
    this.list.innerHTML = `<b>Asset viewer</b><span>← → select · drag orbit · wheel/pinch zoom · Space next clip · X bounds</span><ol>${rows.join("")}</ol>`;
  }

  info() {
    return this.slots.map((s) => ({ id: s.spec.id, loaded: !!s.model, clips: s.clips, measured: s.measured, x: s.x }));
  }

  input(snap: InputSnapshot) {
    if (Math.abs(snap.moveX) < 0.3) this.armed = true;
    else if (this.armed && Math.abs(snap.moveX) > 0.5) {
      this.armed = false;
      // The orbit camera looks along −Z by default, so screen-right is +X: next slot.
      this.select(this.selected + (snap.moveX > 0 ? 1 : -1));
    }
    if (snap.pressed.has("jump")) {
      const s = this.slots[this.selected];
      if (s.clips.length) {
        s.clip = (s.clip + 1) % s.clips.length;
        s.time = 0;
        this.renderList();
      }
    }
  }

  frame(dt: number) {
    for (const s of this.slots) s.time += dt;
  }

  eye(): EyePose {
    const aspect = this.rt.canvas.clientWidth / Math.max(1, this.rt.canvas.clientHeight);
    this.orbit.update(aspect);
    const [x, y, z] = this.orbit.eye;
    return { x, y, z, yaw: this.orbit.yaw + Math.PI, pitch: -this.orbit.pitch, fovY: this.orbit.fovY };
  }

  menuShot(t: number): Shot {
    return { target: [0, 1.2, 0], pitch: 0.25, yaw: 0.4 + 0.2 * Math.sin(t * 0.2), distance: 14 };
  }

  draw(showBounds: boolean) {
    const b = this.rt.batches, box = b[MESH.box];
    box.push(0, -0.05, 0, 0, 0, 0, 60, 0.1, 14, COL.floor, 0.1, 0, 0, 0);
    for (const s of this.slots) {
      const [w, h, d] = s.spec.size;
      if (s.model) {
        this.root.set(IDENTITY);
        this.root[12] = s.x;
        if (s.animator && s.clips.length) {
          const clip = s.clips[s.clip];
          s.animator.update([{ clip, time: s.time, loop: true }], this.root);
          this.models.prepareSkinned(s.model, s.animator);
        } else this.models.prepareStatic(s.model, { root: this.root });
      } else {
        // Placeholder at the contract's target size, resting on its pivot (ground contact).
        box.push(s.x, h / 2, 0, 0, 0, 0, w, h, d, COL.proxy, 0.2);
      }
      this.axes(box, s.x);
      if (showBounds || !s.model) this.wire(box, s.x, h / 2, 0, w / 2, h / 2, d / 2, COL.target);
      if (s.measured) {
        const [lo, hi] = s.measured;
        this.wire(box, s.x + (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2, (hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2, COL.measured);
      }
    }
  }

  /** Pivot marker with +X / +Y / +Z (front) sticks, 0.5 m each. */
  private axes(box: InstanceBatch, x: number) {
    const t = 0.03;
    box.push(x + 0.25, 0.01, 0, 0, 0, 0, 0.5, t, t, COL.x, 0, 0, 0, 0, 1.5);
    box.push(x, 0.25, 0, 0, 0, 0, t, 0.5, t, COL.y, 0, 0, 0, 0, 1.5);
    box.push(x, 0.01, 0.25, 0, 0, 0, t, t, 0.5, COL.z, 0, 0, 0, 0, 1.5);
  }

  private wire(box: InstanceBatch, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, col: [number, number, number], t = 0.015) {
    for (const sy of [-1, 1]) for (const sz of [-1, 1]) box.push(cx, cy + sy * hy, cz + sz * hz, 0, 0, 0, hx * 2, t, t, col, 0, 0, 0, 0, 2);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box.push(cx + sx * hx, cy, cz + sz * hz, 0, 0, 0, t, hy * 2, t, col, 0, 0, 0, 0, 2);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) box.push(cx + sx * hx, cy + sy * hy, cz, 0, 0, 0, t, t, hz * 2, col, 0, 0, 0, 0, 2);
  }
}
