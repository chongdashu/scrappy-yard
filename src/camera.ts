// Follow camera for a top-down/three-quarter game view, or a first-person eye the game
// positions (`mode = "first-person"`, fed each frame through `setEye`). Input picking uses the
// stable (unshaken) camera; shake is applied only to the rendered view, so it
// can never move the aim (feeding a moving camera back into cursor picking
// compounds). A cinematic `Shot` can be blended over the gameplay framing (either mode) for
// title showcases, countdown swoops and result close-ups.
import { clamp, damp, lerp, mat4, type Mat4, type Vec3 } from "./math";

export interface Shot {
  target: Vec3;
  pitch: number;
  /** Orbit around +Y; 0 = camera on the +Z side looking toward −Z. */
  yaw: number;
  distance: number;
}

/**
 * A first-person eye: where the player's head is and where it looks. The game owns it (its sim
 * holds yaw and pitch); the engine only renders it. Same conventions as the sim: metres, +Y up,
 * yaw 0 faces +Z and positive yaw turns counter-clockwise seen from above.
 */
export interface EyePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Radians, positive looks up. */
  pitch: number;
  /** Bank around the view axis (radians), before shake. */
  roll?: number;
  /** Vertical field of view override for this frame (radians); the rig's `fovY` otherwise. */
  fovY?: number;
  /** Ground point the sun shadow map centres on. Default: 4 m ahead of the eye. */
  shadowFocus?: [number, number];
}

/** Which camera drives gameplay: the tilted follow camera, or the game's own eye. */
export type CameraMode = "follow" | "first-person";

/** Framing choices for a game (GameModule.rig). The defaults suit a ~12–20 m play area. */
export interface CameraRig {
  /** Downward tilt of the gameplay view (radians). */
  pitch: number;
  /**
   * Orbit yaw of the follow view around its focus (radians, as `Shot.yaw`; default 0). 0 puts the camera on the +Z
   * side looking toward −Z; π puts it on the −Z side looking toward +Z, behind a player who faces +Z (a rear chase
   * view). The HUD cover shift, the bounds clamp, the shake and `groundBasis()` turn with it.
   */
  yaw?: number;
  fovY: number;
  /** Metres of ground across the width of a portrait screen. */
  portraitWidth: number;
  /** Metres of ground top to bottom on landscape screens. */
  landscapeHeight: number;
  minDistance: number;
  maxDistance: number;
  /** Follow responsiveness (1/s). */
  follow: number;
  /**
   * Metres of backdrop the view may show past the level bounds. The clamp
   * keeps the visible ground footprint (near and far edges of the tilted
   * view, not just its centre) inside bounds + margin, and centres the level
   * on an axis where it is smaller than the view.
   */
  edgeMargin: number;
}

/** Near plane of the first-person camera (metres): arms and carried bodies sit well inside the follow camera's 0.3. */
export const FIRST_PERSON_NEAR = 0.05;

export const DEFAULT_RIG: CameraRig = {
  pitch: (58 * Math.PI) / 180,
  yaw: 0,
  fovY: (38 * Math.PI) / 180,
  portraitWidth: 8.5,
  landscapeHeight: 9.5,
  minDistance: 6,
  maxDistance: 40,
  follow: 6,
  edgeMargin: 1.5,
};

export class Camera {
  rig: CameraRig;
  mode: CameraMode = "follow";
  /** First-person only: the sun shadow map's ground focus for this frame (null in follow mode). */
  shadowFocus: [number, number] | null = null;
  private eye_: EyePose | null = null;
  private fov: number;
  target: Vec3 = [0, 0, 0];
  distance = 14;
  aspect = 1;
  trauma = 0;
  shakeScale = 1;
  /** Framing multiplier (>1 pulls back). */
  zoom = 1;
  /**
   * How much of the view the HUD covers across the middle, as fractions of its
   * height [top, bottom]. Gameplay framing centres the focus in the band left
   * uncovered, so a tall portrait HUD doesn't sit over the player.
   */
  cover: [number, number] = [0, 0];
  /** Cinematic shot blended over gameplay framing by `shotBlend` (0 gameplay … 1 shot). */
  shot: Shot | null = null;
  shotBlend = 0;
  private t = 0;
  view = mat4.identity();
  proj = mat4.identity();
  viewProj = mat4.identity();
  /** Unshaken view-projection for picking. */
  stableViewProj = mat4.identity();
  stableInv = mat4.identity();
  eye: Vec3 = [0, 10, 10];

  constructor(rig: Partial<CameraRig> = {}, mode: CameraMode = "follow") {
    this.rig = { ...DEFAULT_RIG, ...rig };
    this.fov = this.rig.fovY;
    this.mode = mode;
  }

  /** Vertical field of view of the frame being rendered (radians). */
  get fovY() {
    return this.fov;
  }

  /** The follow view's orbit yaw (`rig.yaw`, 0 when a rig leaves it out). */
  private get yaw() {
    return this.rig.yaw ?? 0;
  }

  /** First-person mode: this frame's eye (call before `update`). */
  setEye(e: EyePose) {
    this.eye_ = e;
  }

  /**
   * The gameplay view expressed as an orbit `Shot`, so the flow can blend from it (the round's
   * ending swoops from where the player is looking to the results framing).
   */
  gameplayShot(): Shot {
    if (this.mode === "first-person" && this.eye_) return eyeAsShot(this.eye_);
    return { target: [this.target[0], 0, this.target[2]], pitch: this.rig.pitch, yaw: this.yaw, distance: this.distance };
  }

  /** Gameplay distance for an aspect: portrait fits width, landscape fits height. */
  frameFor(aspect: number): number {
    const { fovY, portraitWidth, landscapeHeight, minDistance, maxDistance } = this.rig;
    const tanH = Math.tan(fovY / 2);
    const d = aspect < 1 ? portraitWidth / (2 * tanH * aspect) : landscapeHeight / (2 * tanH);
    return clamp(d, minDistance, maxDistance);
  }

  /** Jump straight to the gameplay framing for a focus point (no easing). */
  snap(focusX: number, focusZ: number, aspect: number, bounds?: [number, number, number, number]) {
    this.aspect = aspect;
    this.distance = this.frameFor(aspect) * this.zoom;
    const [fx, fz] = bounds ? this.clampFocus(focusX, focusZ, bounds) : [focusX, focusZ];
    const shift = this.coverShift(this.distance);
    this.target[0] = fx - Math.sin(this.yaw) * shift;
    this.target[2] = fz - Math.cos(this.yaw) * shift;
  }

  /**
   * Metres to move the look point up the screen (away from the camera along the
   * ground: −Z at yaw 0) so the focus lands halfway down the uncovered band.
   */
  private coverShift(dist: number): number {
    const below = clamp((this.cover[0] - this.cover[1]) / 2, -0.15, 0.2);
    if (below === 0) return 0;
    const pitch = this.rig.pitch;
    const a = Math.atan(2 * below * Math.tan(this.rig.fovY / 2));
    const h = Math.sin(pitch) * dist;
    return Math.cos(pitch) * dist - h / Math.tan(Math.min(pitch + a, 1.55));
  }

  /**
   * Ground extent of the gameplay view around its look point: `near` toward
   * the camera (+Z at yaw 0), `far` away from it (−Z), `half` across at the look point.
   */
  footprint(distance = this.distance, aspect = this.aspect): { near: number; far: number; half: number } {
    const { pitch, fovY } = this.rig;
    const h = Math.sin(pitch) * distance;
    const across = Math.cos(pitch) * distance;
    const near = across - h / Math.tan(Math.min(pitch + fovY / 2, 1.5707));
    const farAngle = pitch - fovY / 2;
    const far = farAngle > 0.05 ? h / Math.tan(farAngle) - across : 1e3;
    return { near, far, half: Math.tan(fovY / 2) * aspect * distance };
  }

  /** Clamp a focus point so the visible ground stays within bounds + edgeMargin. */
  clampFocus(fx: number, fz: number, bounds: [number, number, number, number]): [number, number] {
    const [x0, z0, x1, z1] = bounds;
    const m = this.rig.edgeMargin;
    const { near, far, half } = this.footprint();
    const axis = (v: number, lo: number, hi: number, below: number, above: number) =>
      below + above >= hi - lo + 2 * m ? (lo + hi) / 2 + (below - above) / 2 : clamp(v, lo - m + below, hi + m - above);
    // The footprint's corners turned by the yaw (across = the view's right, along = toward the camera), then its extent on each world axis.
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const xs: number[] = [], zs: number[] = [];
    for (const across of [-half, half]) for (const along of [-far, near]) {
      xs.push(c * across + s * along);
      zs.push(c * along - s * across);
    }
    return [axis(fx, x0, x1, -Math.min(...xs), Math.max(...xs)), axis(fz, z0, z1, -Math.min(...zs), Math.max(...zs))];
  }

  addTrauma(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt: number, focusX: number, focusZ: number, aspect: number, bounds: [number, number, number, number]) {
    this.t += dt;
    this.aspect = aspect;
    const fp = this.mode === "first-person" && this.eye_ !== null;
    // The gameplay framing as an orbit: look-at point, tilt, yaw around it and distance.
    let base: Shot;
    if (fp) {
      base = eyeAsShot(this.eye_!);
      this.fov = this.eye_!.fovY ?? this.rig.fovY;
      this.distance = base.distance;
      const [ex, ez] = [this.eye_!.x, this.eye_!.z];
      this.shadowFocus = this.eye_!.shadowFocus ?? [ex + Math.sin(this.eye_!.yaw) * 4, ez + Math.cos(this.eye_!.yaw) * 4];
    } else {
      const wantDist = this.frameFor(aspect) * this.zoom;
      this.distance = damp(this.distance, wantDist, 4, dt);
      const [fx, fz] = this.clampFocus(focusX, focusZ, bounds);
      // After the clamp: near the far edge, the covered strip shows backdrop, not play area.
      const shift = this.coverShift(this.distance);
      this.target[0] = damp(this.target[0], fx - Math.sin(this.yaw) * shift, this.rig.follow, dt);
      this.target[2] = damp(this.target[2], fz - Math.cos(this.yaw) * shift, this.rig.follow, dt);
      base = { target: [this.target[0], 0, this.target[2]], pitch: this.rig.pitch, yaw: this.yaw, distance: this.distance };
      this.fov = this.rig.fovY;
      this.shadowFocus = null;
    }

    const b = this.shot ? clamp(this.shotBlend, 0, 1) : 0;
    const shot = this.shot;
    const pitch = shot ? lerp(base.pitch, shot.pitch, b) : base.pitch;
    const yaw = shot ? lerpAngle(base.yaw, shot.yaw, b) : base.yaw;
    const dist = shot ? lerp(base.distance, shot.distance, b) : base.distance;
    const look: Vec3 = shot
      ? [lerp(base.target[0], shot.target[0], b), lerp(base.target[1], shot.target[1], b), lerp(base.target[2], shot.target[2], b)]
      : [base.target[0], base.target[1], base.target[2]];
    const eyeOf = (tx: number, ty: number, tz: number): Vec3 => [
      tx + Math.sin(yaw) * Math.cos(pitch) * dist,
      ty + Math.sin(pitch) * dist,
      tz + Math.cos(yaw) * Math.cos(pitch) * dist,
    ];
    // Far plane 200 m, or 4 × the orbit distance for shots pulled back further (a whole-scene or portrait framing past 50 m),
    // so the framed scene stays inside clip depth. Depth of field and the sky read depth through invViewProj, so they follow.
    this.proj = mat4.perspective(this.fov, aspect, fp ? FIRST_PERSON_NEAR : 0.3, Math.max(200, dist * 4));

    const stableEye = eyeOf(look[0], look[1], look[2]);
    const bankNow = fp ? (this.eye_!.roll ?? 0) * (1 - b) : 0;
    const stableView = mat4.lookAt(stableEye, look, bankUp(stableEye, look, bankNow));
    this.stableViewProj = mat4.mul(this.proj, stableView);
    this.stableInv = mat4.invert(this.stableViewProj);

    // Trauma shake: squared falloff, smooth noise, decays over time. In first person it is a
    // small aim wobble (radians at the one-metre look-at point) instead of a ground-plane shove.
    // The shove and the roll follow the view's yaw (screen right and toward the camera), as at yaw 0.
    const s = this.trauma * this.trauma * this.shakeScale;
    const n = (f: number, o: number) => Math.sin(this.t * f + o) * 0.6 + Math.sin(this.t * f * 2.3 + o * 1.7) * 0.4;
    const amp = fp ? 0.05 * dist : 0.18;
    const ox = s * amp * n(37, 1.3);
    const oz = s * amp * n(41, 4.1);
    const roll = s * 0.02 * n(29, 2.2);
    this.trauma = Math.max(0, this.trauma - dt * 1.8);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const tgt: Vec3 = fp ? [look[0] + ox * cy, look[1] + oz, look[2] - ox * sy] : [look[0] + ox * cy + oz * sy, look[1], look[2] - ox * sy + oz * cy];
    this.eye = eyeOf(tgt[0], tgt[1], tgt[2]);
    if (fp) {
      // The eye stays put; only where it looks wobbles.
      this.eye = stableEye;
      this.view = mat4.lookAt(this.eye, tgt, bankUp(this.eye, tgt, bankNow + roll));
    } else {
      const rolledUp: Vec3 = [cy * Math.sin(roll), Math.cos(roll), -sy * Math.sin(roll)];
      this.view = mat4.lookAt(this.eye, tgt, rolledUp);
    }
    this.viewProj = mat4.mul(this.proj, this.view);
  }

  /** CSS-pixel screen point → ground (y = 0) through the stable camera. */
  pickGround(sx: number, sy: number, w: number, h: number): [number, number] | null {
    const nx = (sx / w) * 2 - 1;
    const ny = 1 - (sy / h) * 2;
    const a = mat4.transformPoint(this.stableInv, [nx, ny, 0]);
    const b = mat4.transformPoint(this.stableInv, [nx, ny, 1]);
    const p0: Vec3 = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
    const p1: Vec3 = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
    const dy = p1[1] - p0[1];
    if (Math.abs(dy) < 1e-6) return null;
    const t = -p0[1] / dy;
    if (t < 0) return null;
    return [p0[0] + (p1[0] - p0[0]) * t, p0[2] + (p1[2] - p0[2]) * t];
  }

  /** World point → CSS pixels (rendered camera), or null behind the camera. */
  project(p: Vec3, w: number, h: number): [number, number] | null {
    const c = mat4.transformPoint(this.viewProj, p);
    if (c[3] <= 0) return null;
    return [((c[0] / c[3]) * 0.5 + 0.5) * w, (1 - ((c[1] / c[3]) * 0.5 + 0.5)) * h];
  }

  /** Screen-space "up" as a world ground direction (for camera-relative movement). */
  groundBasis(): { right: [number, number]; up: [number, number] } {
    if (this.mode === "first-person" && this.eye_ && !(this.shot && this.shotBlend > 0.5)) {
      // Looking along the eye's yaw: screen up is where the player faces.
      const y = this.eye_.yaw;
      return { right: [-Math.cos(y), Math.sin(y)], up: [Math.sin(y), Math.cos(y)] };
    }
    const yaw = this.shot ? lerpAngle(this.yaw, this.shot.yaw, clamp(this.shotBlend, 0, 1)) : this.yaw;
    return { right: [Math.cos(yaw), -Math.sin(yaw)], up: [-Math.sin(yaw), -Math.cos(yaw)] };
  }
}

/**
 * A first-person eye as an orbit shot: the look-at point one metre ahead of the eye, orbited
 * from the far side (yaw + π) with the pitch mirrored, which puts the orbit's eye exactly on the
 * first-person eye.
 */
export function eyeAsShot(e: EyePose): Shot {
  const cp = Math.cos(e.pitch);
  return {
    target: [e.x + Math.sin(e.yaw) * cp, e.y + Math.sin(e.pitch), e.z + Math.cos(e.yaw) * cp],
    pitch: -e.pitch,
    yaw: e.yaw + Math.PI,
    distance: 1,
  };
}

/** World up tilted `roll` radians about the view axis (0 → plain up). */
function bankUp(eye: Vec3, target: Vec3, roll: number): Vec3 {
  if (Math.abs(roll) < 1e-6) return [0, 1, 0];
  const f = vecNormalize([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  // right = f × up (up = +Y), then up' = up·cos + right·sin
  const r = vecNormalize([f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0]);
  return [r[0] * Math.sin(roll), Math.cos(roll), r[2] * Math.sin(roll)];
}

const vecNormalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function lerpAngle(a: number, b: number, t: number) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

export type { Mat4 };
