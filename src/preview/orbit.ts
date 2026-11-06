// Orbit camera for the model preview (mouse + touch), satisfying the
// renderer's CameraLike. Includes a "game" framing preset matching the
// gameplay camera rig (src/camera.ts DEFAULT_RIG). Games can use it too, for
// inspection scenes: widen its zoom limits and gate its input with `attach`.
import { clamp, mat4, type Vec3 } from "../math";
import { DEFAULT_RIG, type CameraRig } from "../camera";

export class OrbitCamera {
  yaw = 0.6;
  pitch = 0.35;
  distance = 4;
  /** Wheel and pinch zoom limits (metres from the target); widen `maxDistance` to inspect a whole scene. */
  minDistance = 0.3;
  maxDistance = 80;
  fovY = (36 * Math.PI) / 180;
  target: Vec3 = [0, 0.8, 0];
  view = mat4.identity();
  proj = mat4.identity();
  viewProj = mat4.identity();
  eye: [number, number, number] = [0, 1, 4];
  /** True while showing the fixed game framing (no free orbit). */
  gameView = false;
  /** Horizontal lens shift in NDC (keeps the subject centred beside a side panel). */
  shiftX = 0;

  private pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;

  /**
   * Drag to orbit, right/middle drag or Shift to pan, pinch or wheel to zoom, on `el`. `accept` gates input: return false
   * to leave an event to something else (a touch control, a paused scene); a drag it refuses part-way ends there. Held
   * pointers are dropped when the window loses focus, so a release outside the page cannot leave a drag stuck. Returns a
   * function that removes every listener.
   */
  attach(el: HTMLElement, onUserMove: () => void, accept: (e: PointerEvent | WheelEvent) => boolean = () => true): () => void {
    const listening = new AbortController(), signal = listening.signal;
    const drop = (id: number) => {
      this.pointers.delete(id);
      if (this.pointers.size < 2) this.pinch = 0;
    };
    el.addEventListener("pointerdown", (e) => {
      if (!accept(e)) return;
      // Under pointer lock (a game's look input) every pointer event already goes to the locked element, and
      // setPointerCapture throws InvalidStateError.
      if (!el.ownerDocument?.pointerLockElement) el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) this.pinch = this.pinchDist();
    }, { signal });
    el.addEventListener("pointermove", (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      if (!accept(e)) return drop(e.pointerId);
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 1) {
        const pan = e.buttons === 2 || e.buttons === 4 || e.shiftKey;
        if (pan) this.pan(dx, dy, el.clientHeight);
        else {
          this.yaw -= dx * 0.008;
          this.pitch = clamp(this.pitch + dy * 0.006, -0.2, 1.52);
        }
      } else if (this.pointers.size === 2) {
        const dist = this.pinchDist();
        if (this.pinch > 0) this.distance = clamp(this.distance * (this.pinch / dist), this.minDistance, this.maxDistance);
        this.pinch = dist;
        this.pan(dx * 0.5, dy * 0.5, el.clientHeight);
      }
      this.gameView = false;
      onUserMove();
    }, { signal });
    const end = (e: PointerEvent) => drop(e.pointerId);
    el.addEventListener("pointerup", end, { signal });
    el.addEventListener("pointercancel", end, { signal });
    el.addEventListener("contextmenu", (e) => e.preventDefault(), { signal });
    el.addEventListener(
      "wheel",
      (e) => {
        if (!accept(e)) return;
        e.preventDefault();
        this.distance = clamp(this.distance * Math.exp(e.deltaY * 0.0012), this.minDistance, this.maxDistance);
        this.gameView = false;
        onUserMove();
      },
      { passive: false, signal },
    );
    el.ownerDocument?.defaultView?.addEventListener("blur", () => {
      this.pointers.clear();
      this.pinch = 0;
    }, { signal });
    return () => listening.abort();
  }

  private pinchDist() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }

  private pan(dx: number, dy: number, h: number) {
    const scale = (2 * this.distance * Math.tan(this.fovY / 2)) / Math.max(1, h);
    const right: Vec3 = [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
    const up: Vec3 = [-Math.sin(this.pitch) * Math.sin(this.yaw), Math.cos(this.pitch), -Math.sin(this.pitch) * Math.cos(this.yaw)];
    for (let i = 0; i < 3; i++) this.target[i] += (-right[i] * dx + up[i] * dy) * scale;
  }

  /** Frame a bounding box from the current yaw/pitch. */
  fit(min: ArrayLike<number>, max: ArrayLike<number>, aspect: number) {
    const c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const r = Math.max(0.1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    const fov = Math.min(this.fovY, 2 * Math.atan(Math.tan(this.fovY / 2) * aspect));
    this.target = c;
    this.distance = (r / Math.sin(fov / 2)) * 1.05;
  }

  /** The gameplay framing (pitch, yaw, fov and ground span from the camera rig). */
  gamePreset(focus: Vec3, aspect: number, rig: CameraRig = DEFAULT_RIG) {
    this.gameView = true;
    this.yaw = rig.yaw ?? 0;
    this.pitch = rig.pitch;
    this.fovY = rig.fovY;
    const tanH = Math.tan(this.fovY / 2);
    this.distance = clamp(aspect < 1 ? rig.portraitWidth / (2 * tanH * aspect) : rig.landscapeHeight / (2 * tanH), rig.minDistance, rig.maxDistance);
    this.target = [focus[0], 0, focus[2]];
  }

  update(aspect: number) {
    const cp = Math.cos(this.pitch);
    this.eye = [
      this.target[0] + Math.sin(this.yaw) * cp * this.distance,
      this.target[1] + Math.sin(this.pitch) * this.distance,
      this.target[2] + Math.cos(this.yaw) * cp * this.distance,
    ];
    const near = Math.max(0.02, this.distance * 0.02);
    this.proj = mat4.perspective(this.fovY, aspect, near, Math.max(200, this.distance * 20));
    this.proj[8] = this.shiftX; // ndc.x −= shiftX
    this.view = mat4.lookAt(this.eye, this.target, [0, 1, 0]);
    this.viewProj = mat4.mul(this.proj, this.view);
  }
}
