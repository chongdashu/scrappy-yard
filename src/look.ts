// Look input for first-person games: the pure parts. `Input` (src/input.ts) owns the DOM
// listeners; everything that turns a device reading into a view delta lives here so it can be
// tested without a browser.
//
// Conventions: a look delta is in RADIANS, x positive = the view turns RIGHT, y positive =
// the view turns DOWN (the same screen-space sense as the move stick). A game turns them into
// yaw and pitch (for the engine's yaw convention, yaw −= x; pitch −= y).

export interface LookOptions {
  /** Radians per pixel of pointer-locked mouse movement. */
  mouse: number;
  /** Radians per pixel of touch drag. */
  touch: number;
  /** Radians per second at full right-stick deflection (the response curve is squared for fine aim). */
  stick: number;
  /** Radians per second while an arrow key is held. */
  keys: number;
  /**
   * Touches that start left of this fraction of the play area's width drive the move stick;
   * touches to the right of it drag the view.
   */
  split: number;
}

export const DEFAULT_LOOK: LookOptions = { mouse: 0.0022, touch: 0.006, stick: 2.6, keys: 1.8, split: 0.45 };

/** Key codes that look instead of move while look input is on (WASD keeps moving). */
export const LOOK_KEYS = {
  left: ["ArrowLeft"],
  right: ["ArrowRight"],
  up: ["ArrowUp"],
  down: ["ArrowDown"],
} as const;

/** `true` → defaults, an object → defaults with overrides, `false`/`undefined` → no look input. */
export function resolveLook(o: boolean | Partial<LookOptions> | undefined): LookOptions | null {
  if (!o) return null;
  const merged = { ...DEFAULT_LOOK, ...(o === true ? {} : o) };
  for (const k of Object.keys(DEFAULT_LOOK) as (keyof LookOptions)[]) {
    if (!Number.isFinite(merged[k]) || merged[k] < 0) merged[k] = DEFAULT_LOOK[k];
  }
  merged.split = Math.min(0.9, Math.max(0.1, merged.split));
  return merged;
}

/** Arrow keys → a look delta for a frame of `dt` seconds. */
export function keyLook(held: ReadonlySet<string>, dt: number, o: LookOptions): [number, number] {
  const any = (codes: readonly string[]) => codes.some((c) => held.has(c));
  const x = (any(LOOK_KEYS.right) ? 1 : 0) - (any(LOOK_KEYS.left) ? 1 : 0);
  const y = (any(LOOK_KEYS.down) ? 1 : 0) - (any(LOOK_KEYS.up) ? 1 : 0);
  const step = o.keys * Math.max(0, Math.min(0.1, dt));
  return [x * step, y * step];
}

/** Right stick (raw axes) → a look delta: dead zone, then a squared response so small pushes aim finely. */
export function padLook(ax: number, ay: number, dt: number, o: LookOptions, deadzone = 0.2): [number, number] {
  const shape = (v: number) => {
    const a = Math.abs(v);
    if (!Number.isFinite(a) || a < deadzone) return 0;
    const t = Math.min(1, (a - deadzone) / (1 - deadzone));
    return Math.sign(v) * t * t;
  };
  const step = o.stick * Math.max(0, Math.min(0.1, dt));
  return [shape(ax) * step, shape(ay) * step];
}

/** Largest single mouse movement (px) accepted per event: some browsers report spikes when the lock engages. */
export const MOUSE_SPIKE_PX = 300;

/** Pointer-locked mouse movement (px) → a look delta. */
export function mouseLook(dx: number, dy: number, o: LookOptions): [number, number] {
  const clip = (v: number) => (Number.isFinite(v) && Math.abs(v) <= MOUSE_SPIKE_PX ? v : 0);
  return [clip(dx) * o.mouse, clip(dy) * o.mouse];
}

/** One finger dragging the view (the right part of the screen). Other fingers are ignored. */
export class TouchLook {
  private id = -1;
  private x = 0;
  private y = 0;

  get active() {
    return this.id !== -1;
  }

  /** A touch went down at (x, y) on a play area `width` px wide: does it start the drag? */
  begin(id: number, x: number, y: number, width: number, o: LookOptions): boolean {
    if (this.id !== -1 || x < width * o.split) return false;
    this.id = id;
    this.x = x;
    this.y = y;
    return true;
  }

  owns(id: number) {
    return this.id === id;
  }

  /** The finger moved: the look delta since its last position. */
  move(id: number, x: number, y: number, o: LookOptions): [number, number] {
    if (this.id !== id) return [0, 0];
    const d: [number, number] = [(x - this.x) * o.touch, (y - this.y) * o.touch];
    this.x = x;
    this.y = y;
    return d;
  }

  end(id: number): boolean {
    if (this.id !== id) return false;
    this.id = -1;
    return true;
  }

  clear() {
    this.id = -1;
  }
}

/** On-screen buttons currently held, by pointer (two fingers may hold two buttons, or one button twice). */
export class HeldActions {
  private pointers = new Map<number, string>();

  /** Returns true when this press took the action from up to held (an edge). */
  down(pointerId: number, action: string): boolean {
    const was = this.has(action);
    this.pointers.set(pointerId, action);
    return !was;
  }

  up(pointerId: number) {
    this.pointers.delete(pointerId);
  }

  has(action: string): boolean {
    for (const a of this.pointers.values()) if (a === action) return true;
    return false;
  }

  clear() {
    this.pointers.clear();
  }
}
