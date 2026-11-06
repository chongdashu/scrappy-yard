// CPU animation: samples clips into a local pose with body-part masks,
// applies procedural bone rotations (e.g. a chest twist toward an aim) and
// produces node world matrices plus skinning joint matrices.
import { composeTRS, IDENTITY, mulMat, type GltfClip, type GltfDoc } from "./glb";

export type Mask = "all" | "upper" | "lower";

export interface Layer {
  clip: string;
  time: number;
  /** 0..1, blends over the layers below within the mask (default 1). */
  weight?: number;
  mask?: Mask;
  /** Wrap time into the clip (default true); otherwise clamp. */
  loop?: boolean;
}

type Quat = [number, number, number, number];

export class Animator {
  readonly doc: GltfDoc;
  readonly skin: number;
  /** World matrices of every node after `update`, 16 floats per node. */
  readonly world: Float32Array;
  /** Per skin joint: world(joint) · inverseBind — vertices go straight to world. */
  readonly jointMatrices: Float32Array;
  private t: Float32Array;
  private r: Float32Array;
  private s: Float32Array;
  private local = new Float32Array(16);
  private byName = new Map<string, number>();
  private clips = new Map<string, GltfClip>();
  private upper = new Set<number>();

  /**
   * `upperRoot`: the bone whose subtree is the "upper" mask (layer an upper-body
   * clip over walking legs). Missing bone = empty upper mask.
   */
  constructor(doc: GltfDoc, skin = doc.skins.length ? 0 : -1, upperRoot = "spine") {
    this.doc = doc;
    this.skin = skin;
    const n = doc.nodes.length;
    this.world = new Float32Array(n * 16);
    this.t = new Float32Array(n * 3);
    this.r = new Float32Array(n * 4);
    this.s = new Float32Array(n * 3);
    doc.nodes.forEach((node, i) => this.byName.set(node.name, i));
    doc.clips.forEach((c) => this.clips.set(c.name, c));
    this.jointMatrices = new Float32Array((skin >= 0 ? doc.skins[skin].joints.length : 0) * 16);
    // Upper body = `upperRoot` and everything below it in the hierarchy.
    const spine = this.byName.get(upperRoot);
    if (spine !== undefined) {
      const stack = [spine];
      while (stack.length) {
        const i = stack.pop()!;
        this.upper.add(i);
        stack.push(...doc.nodes[i].children);
      }
    }
    this.update([], IDENTITY);
  }

  get clipNames(): string[] {
    return [...this.clips.keys()];
  }

  clipDuration(name: string): number {
    return this.clips.get(name)?.duration ?? 0;
  }

  nodeIndex(name: string): number {
    return this.byName.get(name) ?? -1;
  }

  /** World matrix view of a node (valid until the next update), or null. */
  nodeWorld(name: string): Float32Array | null {
    const i = this.byName.get(name);
    return i === undefined ? null : this.world.subarray(i * 16, i * 16 + 16);
  }

  isUpper(node: number): boolean {
    return this.upper.has(node);
  }

  update(layers: Layer[], root: Float32Array, boneOffsets?: Record<string, Quat>): void {
    const { doc, t, r, s } = this;
    // Rest pose.
    doc.nodes.forEach((node, i) => {
      t.set(node.t, i * 3);
      r.set(node.r, i * 4);
      s.set(node.s, i * 3);
    });
    const v = new Float32Array(4);
    for (const layer of layers) {
      const clip = this.clips.get(layer.clip);
      if (!clip || clip.duration <= 0) continue;
      const w = Math.max(0, Math.min(1, layer.weight ?? 1));
      if (w <= 0) continue;
      const mask = layer.mask ?? "all";
      let time = layer.time;
      if (layer.loop ?? true) time = ((time % clip.duration) + clip.duration) % clip.duration;
      else time = Math.max(0, Math.min(clip.duration, time));
      for (const ch of clip.channels) {
        if (mask === "upper" && !this.upper.has(ch.node)) continue;
        if (mask === "lower" && this.upper.has(ch.node)) continue;
        const comps = ch.path === "rotation" ? 4 : 3;
        sample(ch.times, ch.values, ch.interp, comps, time, ch.path === "rotation", v);
        const dst = ch.path === "rotation" ? r : ch.path === "translation" ? t : s;
        const o = ch.node * comps;
        if (w >= 1) {
          for (let k = 0; k < comps; k++) dst[o + k] = v[k];
        } else if (comps === 4) {
          slerpInto(dst, o, dst[o], dst[o + 1], dst[o + 2], dst[o + 3], v[0], v[1], v[2], v[3], w);
        } else {
          for (let k = 0; k < 3; k++) dst[o + k] += (v[k] - dst[o + k]) * w;
        }
      }
    }
    // Procedural local rotations applied after sampling: r' = r · q.
    if (boneOffsets) {
      for (const name in boneOffsets) {
        const i = this.byName.get(name);
        if (i === undefined) continue;
        const q = boneOffsets[name];
        const o = i * 4;
        const ax = r[o], ay = r[o + 1], az = r[o + 2], aw = r[o + 3];
        r[o] = aw * q[0] + ax * q[3] + ay * q[2] - az * q[1];
        r[o + 1] = aw * q[1] - ax * q[2] + ay * q[3] + az * q[0];
        r[o + 2] = aw * q[2] + ax * q[1] - ay * q[0] + az * q[3];
        r[o + 3] = aw * q[3] - ax * q[0] - ay * q[1] - az * q[2];
      }
    }
    // World matrices.
    const visit = (i: number, parent: Float32Array, po: number) => {
      composeTRS(this.local, 0, t.subarray(i * 3, i * 3 + 3), r.subarray(i * 4, i * 4 + 4), s.subarray(i * 3, i * 3 + 3));
      mulMat(this.world, i * 16, parent, po, this.local, 0);
      for (const c of doc.nodes[i].children) visit(c, this.world, i * 16);
    };
    for (const root_ of doc.roots) visit(root_, root, 0);
    // Joint matrices.
    if (this.skin >= 0) {
      const sk = doc.skins[this.skin];
      for (let j = 0; j < sk.joints.length; j++) mulMat(this.jointMatrices, j * 16, this.world, sk.joints[j] * 16, sk.inverseBind, j * 16);
    }
  }
}

/** Axis–angle quaternion (axis need not be normalized). */
export function quatAxisAngle(ax: number, ay: number, az: number, angle: number): Quat {
  const l = Math.hypot(ax, ay, az) || 1;
  const s = Math.sin(angle / 2) / l;
  return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
}

function findKey(times: Float32Array, time: number): number {
  let lo = 0, hi = times.length - 1;
  if (time <= times[0]) return 0;
  if (time >= times[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  return lo;
}

function sample(times: Float32Array, values: Float32Array, interp: string, comps: number, time: number, isRot: boolean, out: Float32Array) {
  const n = times.length;
  if (n === 0) return;
  const cubic = interp === "CUBICSPLINE";
  const stride = cubic ? comps * 3 : comps;
  const vo = cubic ? comps : 0; // value offset inside a key
  const k = findKey(times, time);
  if (n === 1 || time <= times[0] || time >= times[n - 1] || interp === "STEP") {
    const kk = time >= times[n - 1] ? n - 1 : k;
    for (let c = 0; c < comps; c++) out[c] = values[kk * stride + vo + c];
    if (isRot) normalizeQuat(out);
    return;
  }
  const t0 = times[k], t1 = times[k + 1];
  const dt = t1 - t0;
  const u = dt > 0 ? (time - t0) / dt : 0;
  if (cubic) {
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    for (let c = 0; c < comps; c++) {
      const p0 = values[k * stride + comps + c];
      const m0 = values[k * stride + 2 * comps + c] * dt; // out-tangent of k
      const p1 = values[(k + 1) * stride + comps + c];
      const m1 = values[(k + 1) * stride + c] * dt; // in-tangent of k+1
      out[c] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
    }
    if (isRot) normalizeQuat(out);
    return;
  }
  const a = k * stride, b = (k + 1) * stride;
  if (isRot) {
    slerpInto(out, 0, values[a], values[a + 1], values[a + 2], values[a + 3], values[b], values[b + 1], values[b + 2], values[b + 3], u);
  } else {
    for (let c = 0; c < comps; c++) out[c] = values[a + c] + (values[b + c] - values[a + c]) * u;
  }
}

function normalizeQuat(q: Float32Array) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= l; q[1] /= l; q[2] /= l; q[3] /= l;
}

function slerpInto(out: Float32Array, o: number, ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number, u: number) {
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  let k0: number, k1: number;
  if (cos > 0.9995) {
    k0 = 1 - u;
    k1 = u;
  } else {
    const th = Math.acos(cos);
    const sn = Math.sin(th);
    k0 = Math.sin((1 - u) * th) / sn;
    k1 = Math.sin(u * th) / sn;
  }
  let x = ax * k0 + bx * k1, y = ay * k0 + by * k1, z = az * k0 + bz * k1, w = aw * k0 + bw * k1;
  const l = Math.hypot(x, y, z, w) || 1;
  x /= l; y /= l; z /= l; w /= l;
  out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = w;
}
