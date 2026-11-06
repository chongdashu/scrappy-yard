// Posing a skin from world-space bone transforms instead of clips: the counterpart of the Animator
// for bodies that something else moves (a physics-driven body, a verlet chain, IK). `SkinPose` has the same
// output shape as the Animator (`world`, `jointMatrices`), so `ModelRenderer.prepareSkinned` draws
// either. The caller works only in WORLD space and never reads the file's node rotations (which
// carry bone roll): it says where a bone's head is now, and which rotation takes the bone from its
// rest orientation to the current one. The small maths helpers below build those rotations from
// joint positions: a frame from two directions, or the minimal swing that keeps a bone's twist
// from its parent. Pose storage is reused; some helpers allocate temporary arrays.
//
// A 3×3 rotation is 9 numbers, column-major (the images of the x, y and z axes); a 4×4 matrix is
// column-major like the rest of the engine (`composeTRS`, `mulMat`).
import { IDENTITY, mulMat, worldMatrices, type GltfDoc } from "./glb";

export type Vec3 = [number, number, number];
/** A 3×3 matrix, column-major (`Float64Array` or a plain array of 9). */
export type Mat3 = ArrayLike<number>;
type Out3 = number[] | Float64Array;

const EPS = 1e-9;

export const IDENTITY3: Readonly<number[]> = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const len3 = (x: number, y: number, z: number) => Math.hypot(x, y, z);

/** Write a matrix that maps rest world space to posed world space: `T(posedHead) · linear · T(−restHead)`. `linear` is a 3×3 (rotation, optionally with stretch). */
export function boneDelta(out: Float32Array, o: number, restHead: ArrayLike<number>, posedHead: ArrayLike<number>, linear: Mat3): void {
  for (let c = 0; c < 3; c++) {
    out[o + c * 4] = linear[c * 3];
    out[o + c * 4 + 1] = linear[c * 3 + 1];
    out[o + c * 4 + 2] = linear[c * 3 + 2];
    out[o + c * 4 + 3] = 0;
  }
  // translation = posedHead − linear · restHead
  for (let r = 0; r < 3; r++) out[o + 12 + r] = posedHead[r] - (linear[r] * restHead[0] + linear[3 + r] * restHead[1] + linear[6 + r] * restHead[2]);
  out[o + 15] = 1;
}

/** out = a · b (3×3). `out` may not alias an input. */
export function mul3(out: Out3, a: Mat3, b: Mat3): void {
  for (let c = 0; c < 3; c++) {
    const b0 = b[c * 3], b1 = b[c * 3 + 1], b2 = b[c * 3 + 2];
    out[c * 3] = a[0] * b0 + a[3] * b1 + a[6] * b2;
    out[c * 3 + 1] = a[1] * b0 + a[4] * b1 + a[7] * b2;
    out[c * 3 + 2] = a[2] * b0 + a[5] * b1 + a[8] * b2;
  }
}

/** out = a · bᵀ (3×3), the rotation from one orthonormal frame to another when `a` is the target frame and `b` the source. */
export function mul3T(out: Out3, a: Mat3, b: Mat3): void {
  for (let c = 0; c < 3; c++) {
    // column c of bᵀ is row c of b: (b[c], b[3 + c], b[6 + c])
    const b0 = b[c], b1 = b[3 + c], b2 = b[6 + c];
    out[c * 3] = a[0] * b0 + a[3] * b1 + a[6] * b2;
    out[c * 3 + 1] = a[1] * b0 + a[4] * b1 + a[7] * b2;
    out[c * 3 + 2] = a[2] * b0 + a[5] * b1 + a[8] * b2;
  }
}

/** m · v. */
export function apply3(m: Mat3, x: number, y: number, z: number): Vec3 {
  return [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
}

/**
 * An orthonormal frame (right-handed, columns x y z) whose z is `axis` and whose x is `ref` made
 * perpendicular to it. When `ref` is (nearly) parallel to `axis` the frame is still valid: it
 * picks a stable perpendicular. Returns false in that degenerate case so a caller can prefer
 * another reference.
 */
export function frame3(out: Out3, axis: ArrayLike<number>, ref: ArrayLike<number>): boolean {
  let zl = len3(axis[0], axis[1], axis[2]);
  if (zl < EPS) {
    for (let i = 0; i < 9; i++) out[i] = IDENTITY3[i];
    return false;
  }
  const zx = axis[0] / zl, zy = axis[1] / zl, zz = axis[2] / zl;
  let xx = ref[0], xy = ref[1], xz = ref[2];
  const d = xx * zx + xy * zy + xz * zz;
  xx -= d * zx; xy -= d * zy; xz -= d * zz;
  let xl = len3(xx, xy, xz);
  let ok = true;
  if (xl < 1e-6 * Math.max(1, len3(ref[0], ref[1], ref[2]))) {
    ok = false;
    // Any perpendicular: cross with the world axis least aligned with z.
    const ax = Math.abs(zx), ay = Math.abs(zy), az = Math.abs(zz);
    const [ux, uy, uz] = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
    xx = uy * zz - uz * zy; xy = uz * zx - ux * zz; xz = ux * zy - uy * zx;
    xl = len3(xx, xy, xz);
  }
  xx /= xl; xy /= xl; xz /= xl;
  // y = z × x
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = xy; out[2] = xz;
  out[3] = yx; out[4] = yy; out[5] = yz;
  out[6] = zx; out[7] = zy; out[8] = zz;
  return ok;
}

/**
 * The minimal rotation taking unit-ish vector `from` to `to` (a swing: no twist about either).
 * For (almost) opposite vectors the axis is any perpendicular to `from`, preferring the
 * perpendicular part of `hint` when given so the result is stable from frame to frame.
 */
export function swing3(out: Out3, from: ArrayLike<number>, to: ArrayLike<number>, hint?: ArrayLike<number>): void {
  const fl = len3(from[0], from[1], from[2]), tl = len3(to[0], to[1], to[2]);
  if (fl < EPS || tl < EPS) {
    for (let i = 0; i < 9; i++) out[i] = IDENTITY3[i];
    return;
  }
  const fx = from[0] / fl, fy = from[1] / fl, fz = from[2] / fl;
  const tx = to[0] / tl, ty = to[1] / tl, tz = to[2] / tl;
  const c = fx * tx + fy * ty + fz * tz;
  const vx = fy * tz - fz * ty, vy = fz * tx - fx * tz, vz = fx * ty - fy * tx;
  if (c < -0.999999) {
    // Half a turn: about a perpendicular axis.
    let ax: number, ay: number, az: number;
    if (hint) {
      const d = hint[0] * fx + hint[1] * fy + hint[2] * fz;
      ax = hint[0] - d * fx; ay = hint[1] - d * fy; az = hint[2] - d * fz;
    } else {
      ax = 0; ay = 0; az = 0;
    }
    let al = len3(ax, ay, az);
    if (al < 1e-6) {
      const px = Math.abs(fx), py = Math.abs(fy), pz = Math.abs(fz);
      const [ux, uy, uz] = px <= py && px <= pz ? [1, 0, 0] : py <= pz ? [0, 1, 0] : [0, 0, 1];
      ax = fy * uz - fz * uy; ay = fz * ux - fx * uz; az = fx * uy - fy * ux;
      al = len3(ax, ay, az);
    }
    ax /= al; ay /= al; az /= al;
    // R = 2 a aᵀ − I
    out[0] = 2 * ax * ax - 1; out[1] = 2 * ax * ay; out[2] = 2 * ax * az;
    out[3] = 2 * ay * ax; out[4] = 2 * ay * ay - 1; out[5] = 2 * ay * az;
    out[6] = 2 * az * ax; out[7] = 2 * az * ay; out[8] = 2 * az * az - 1;
    return;
  }
  const k = 1 / (1 + c);
  // Rodrigues: R = I + [v]× + [v]×² · k
  out[0] = 1 + k * (-vz * vz - vy * vy);
  out[1] = vz + k * (vx * vy);
  out[2] = -vy + k * (vx * vz);
  out[3] = -vz + k * (vx * vy);
  out[4] = 1 + k * (-vz * vz - vx * vx);
  out[5] = vx + k * (vy * vz);
  out[6] = vy + k * (vx * vz);
  out[7] = -vx + k * (vy * vz);
  out[8] = 1 + k * (-vy * vy - vx * vx);
}

/**
 * A bone's rotation that keeps its twist from its parent: the parent's rotation, then the minimal
 * swing taking the parent-rotated rest direction to the posed direction. `out` = swing · parent.
 * With an identity `parent` and a posed direction equal to `restDir` the result is the identity.
 */
export function followSwing(out: Out3, parent: Mat3, restDir: ArrayLike<number>, posedDir: ArrayLike<number>, hint?: ArrayLike<number>): void {
  const p = apply3(parent, restDir[0], restDir[1], restDir[2]);
  const s = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  swing3(s, p, posedDir, hint);
  mul3(out, s, parent);
}

/** A skin joint's stretch along its rest direction: `I + (s − 1) d dᵀ` (d unit), for scaling a bone toward its posed length. */
export function stretchAlong(out: Out3, dir: ArrayLike<number>, s: number): void {
  const l = len3(dir[0], dir[1], dir[2]) || 1;
  const dx = dir[0] / l, dy = dir[1] / l, dz = dir[2] / l;
  const k = s - 1;
  out[0] = 1 + k * dx * dx; out[1] = k * dx * dy; out[2] = k * dx * dz;
  out[3] = k * dy * dx; out[4] = 1 + k * dy * dy; out[5] = k * dy * dz;
  out[6] = k * dz * dx; out[7] = k * dz * dy; out[8] = 1 + k * dz * dz;
}

/** A skin posed from world-space bone transforms. Same outputs as `Animator`, so `ModelRenderer.prepareSkinned` takes either. */
export class SkinPose {
  readonly doc: GltfDoc;
  readonly skin: number;
  /** World matrices of every node after `update`, 16 floats per node (rest pose until a bone is set). */
  readonly world: Float32Array;
  /** Per skin joint: world(joint) · inverseBind, vertices go straight to world. */
  readonly jointMatrices: Float32Array;
  /** Rest world matrices of every node (from the file's node transforms, before any pose). */
  readonly rest: Float32Array;
  private delta: Float32Array;
  private has: Uint8Array;
  private effective: Float32Array;
  private byName = new Map<string, number>();
  /** Nodes with parents before children. */
  private order: number[] = [];

  constructor(doc: GltfDoc, skin = doc.skins.length ? 0 : -1) {
    this.doc = doc;
    this.skin = skin;
    const n = doc.nodes.length;
    this.rest = worldMatrices(doc);
    this.world = new Float32Array(n * 16);
    this.delta = new Float32Array(n * 16);
    this.effective = new Float32Array(n * 16);
    this.has = new Uint8Array(n);
    this.jointMatrices = new Float32Array((skin >= 0 ? doc.skins[skin].joints.length : 0) * 16);
    doc.nodes.forEach((node, i) => this.byName.set(node.name, i));
    const seen = new Uint8Array(n);
    const visit = (i: number) => {
      if (seen[i]) return;
      seen[i] = 1;
      this.order.push(i);
      for (const c of doc.nodes[i].children) visit(c);
    };
    for (const r of doc.roots) visit(r);
    for (let i = 0; i < n; i++) visit(i);
    this.reset();
    this.update(IDENTITY);
  }

  nodeIndex(name: string): number {
    return this.byName.get(name) ?? -1;
  }

  /** Rest world position of a node (its head), or null for an unknown name. */
  restPosition(name: string): Vec3 | null {
    const i = this.byName.get(name);
    if (i === undefined) return null;
    const o = i * 16;
    return [this.rest[o + 12], this.rest[o + 13], this.rest[o + 14]];
  }

  /** Every bone back to the rest pose. */
  reset(): void {
    this.has.fill(0);
    for (let i = 0; i < this.delta.length; i += 16) this.delta.set(IDENTITY, i);
  }

  /**
   * Pose a node by a world-space delta (the matrix that maps its rest world space to its posed
   * world space; see `boneDelta`). Nodes without one follow their nearest posed ancestor, so
   * anything attached to a bone rides along.
   */
  set(node: number | string, delta: Float32Array, offset = 0): void {
    const i = typeof node === "number" ? node : this.byName.get(node);
    if (i === undefined || i < 0) return;
    for (let k = 0; k < 16; k++) this.delta[i * 16 + k] = delta[offset + k];
    this.has[i] = 1;
  }

  /** Recompute `world` and `jointMatrices`. `root` places the whole model (default identity). */
  update(root: Float32Array = IDENTITY): void {
    const { doc, order, effective, delta, has, rest, world } = this;
    const tmp = new Float32Array(16);
    for (const i of order) {
      const p = doc.nodes[i].parent;
      if (has[i]) effective.set(delta.subarray(i * 16, i * 16 + 16), i * 16);
      else if (p >= 0) effective.copyWithin(i * 16, p * 16, p * 16 + 16);
      else effective.set(IDENTITY, i * 16);
      mulMat(tmp, 0, effective, i * 16, rest, i * 16);
      mulMat(world, i * 16, root, 0, tmp, 0);
    }
    if (this.skin >= 0) {
      const sk = doc.skins[this.skin];
      for (let j = 0; j < sk.joints.length; j++) mulMat(this.jointMatrices, j * 16, world, sk.joints[j] * 16, sk.inverseBind, j * 16);
    }
  }
}
