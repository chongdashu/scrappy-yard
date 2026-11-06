// Keyboard, mouse, touch and gamepad → one input snapshot per frame.
//
// - Movement is a screen-space stick: x right, y down, magnitude 0..1. The
//   game maps it to the world through the camera (Camera.groundBasis).
// - Actions are named and bound to keys ("KeyP"), gamepad buttons ("Pad:9")
//   or mouse buttons ("Mouse:2"). `held` is the current state, `pressed` the
//   presses since the last poll (one-shot edges). On-screen touch buttons
//   (src/ui/touch-buttons.ts) drive the same actions.
// - Look (first-person games opt in through GameModule.look): the snapshot carries look
//   deltas in radians since the last poll, from the pointer-locked mouse (click to capture,
//   Esc releases), a touch drag on the right of the screen, the gamepad's right stick and the
//   arrow keys (which then stop moving). See src/look.ts.
// - Key handling is scoped: events aimed at menus/popups (`.screen`,
//   `.popup`, form fields) are left to them, and default browser behaviour
//   (scrolling on arrows/Space) is only suppressed while `gameplay` is on.
// - Held state is dropped on blur, on hidden tabs and whenever the owner of
//   the screen changes (call `clear()`), so nothing stays stuck down.
import { HeldActions, TouchLook, keyLook, mouseLook, padLook, resolveLook, type LookOptions } from "./look";

export type Device = "keyboard" | "mouse" | "touch" | "gamepad";

export type ActionMap = Record<string, string[]>;

/** Engine-level actions; a game adds its own through GameModule.actions (src/game.ts). */
export const DEFAULT_ACTIONS: ActionMap = {
  pause: ["Escape", "KeyP", "Pad:9"],
  mute: ["KeyM"],
};

export const MOVE_KEYS = {
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  up: ["KeyW", "ArrowUp"],
  down: ["KeyS", "ArrowDown"],
};

/** WASD only: what moves while the arrow keys look instead. */
const WASD_KEYS = {
  left: ["KeyA"],
  right: ["KeyD"],
  up: ["KeyW"],
  down: ["KeyS"],
};

export interface TouchStick {
  id: number;
  /** Origin (CSS px); drags along when the thumb goes past the radius. */
  ox: number;
  oy: number;
  x: number;
  y: number;
}

export interface InputSnapshot {
  /** Screen-space movement, x right / y down, length ≤ 1. */
  moveX: number;
  moveY: number;
  /**
   * Look delta since the last poll, radians (0 unless the game enabled look input): x positive
   * turns the view right, y positive turns it down.
   */
  lookX: number;
  lookY: number;
  held: ReadonlySet<string>;
  pressed: ReadonlySet<string>;
  /** Mouse pointer in CSS px; `down` = left button held over the play area. */
  pointer: { x: number; y: number; down: boolean; inside: boolean };
  /** The mouse is captured by the page (pointer lock): look deltas come from it. */
  locked: boolean;
  /** The device that produced the latest input. */
  device: Device;
  /** A touch happened recently: show touch UI instead of key hints. */
  touchActive: boolean;
}

export const STICK_RADIUS = 56;
const DEADZONE = 0.12;
const PAD_DEADZONE = 0.2;
const TOUCH_MEMORY_MS = 8000;

const isFormTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable);
};

const NONE: ReadonlySet<string> = new Set();

/**
 * The snapshot a game gets outside active play (menus, countdown, pause, a round's ending):
 * no movement, no look, no actions held or pressed, no pointer button. Device, touch and
 * mouse-capture state are kept so HUD hints don't flicker.
 */
export function neutralInput(snap: InputSnapshot): InputSnapshot {
  return { ...snap, moveX: 0, moveY: 0, lookX: 0, lookY: 0, held: NONE, pressed: NONE, pointer: { ...snap.pointer, down: false } };
}

/**
 * Pure: keyboard codes held → screen-space axes (normalised diagonals). With `arrowsMove` off
 * (look input on) only WASD moves; the arrow keys look.
 */
export function keyAxes(held: ReadonlySet<string>, arrowsMove = true): [number, number] {
  const keys = arrowsMove ? MOVE_KEYS : WASD_KEYS;
  const any = (codes: string[]) => codes.some((c) => held.has(c));
  let x = (any(keys.right) ? 1 : 0) - (any(keys.left) ? 1 : 0);
  let y = (any(keys.down) ? 1 : 0) - (any(keys.up) ? 1 : 0);
  const l = Math.hypot(x, y);
  if (l > 1) {
    x /= l;
    y /= l;
  }
  return [x, y];
}

/** Pure: a floating stick → axes (and drags the origin along past the radius). */
export function stickAxes(s: TouchStick, radius = STICK_RADIUS): [number, number] {
  const dx = s.x - s.ox, dy = s.y - s.oy;
  const d = Math.hypot(dx, dy);
  if (d > radius) {
    s.ox = s.x - (dx / d) * radius;
    s.oy = s.y - (dy / d) * radius;
  }
  let x = (s.x - s.ox) / radius, y = (s.y - s.oy) / radius;
  const l = Math.hypot(x, y);
  if (l < DEADZONE) return [0, 0];
  if (l > 1) {
    x /= l;
    y /= l;
  }
  return [x, y];
}

export class Input {
  actions: ActionMap;
  /** On while the player controls the game: arrows/Space/Tab don't scroll or move focus. */
  gameplay = false;
  /** Where touches may start the stick (defaults to anywhere on the element). */
  stickZone: (x: number, y: number) => boolean = () => true;
  /** Look input settings, or null when the game did not opt in. */
  readonly look: LookOptions | null;
  /** The mouse capture was lost while the player was in control (Esc, alt-tab): the flow pauses. */
  onUnlock: (() => void) | null = null;
  /** Any touch or on-screen button press happened since the page loaded (sticky, unlike `touchActive`). */
  touchEver = false;
  private _emulateTouch = false;
  /**
   * The mouse stands in for a finger (off by default; the dev server's Mobile view turns it on, see src/dev/mobile-view.ts): a
   * left-button drag on the play area drives the touch stick or the look drag, other buttons do nothing, the touch buttons show,
   * the mouse is never captured and `snap.pointer` stays still. One mouse is one finger, so two-finger gestures still need a
   * real touch screen.
   */
  get emulateTouch(): boolean {
    return this._emulateTouch;
  }
  set emulateTouch(on: boolean) {
    this._emulateTouch = on;
    this.markTouch();
  }
  private coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  /**
   * The player uses touch controls: a touch screen (a coarse pointer), any touch since the page loaded, or `emulateTouch`. The
   * touch buttons show by it, and `<body>` has the class `touch-controls` while it holds, so a game writes its phone layout
   * once as `body.touch-controls …`. (A `pointer: coarse` media query never matches the dev Mobile view.)
   */
  get touchControls(): boolean {
    return this.coarse || this.touchEver || this._emulateTouch;
  }
  private keys = new Set<string>();
  private edges = new Set<string>();
  private mouse = { x: 0, y: 0, inside: false, down: false };
  private stick: TouchStick | null = null;
  private touchLook = new TouchLook();
  private buttons = new HeldActions();
  private lookAcc: [number, number] = [0, 0];
  private lastTouch = -1e9;
  private padPrev: boolean[] = [];
  private device: Device = "keyboard";
  private wasLocked = false;
  /** Pointer lock was refused (or is unavailable, or ?nolock): clicks stay ordinary presses. */
  private lockFailed: boolean;
  /** Who asked for the lock that is pending: the flow at GO/Resume (a refusal there is normal: no fresh click) or a click. */
  private lockAsker: "flow" | "click" | null = null;
  /** Clicks whose lock request was refused in a row; two mean pointer lock is not available here. */
  private clickRefusals = 0;
  /** For the touch HUD: the live stick, if any. */
  get touchStick(): TouchStick | null {
    return this.stick;
  }

  /**
   * The engine is using this pointer: the touch move stick or the look drag (a mouse under `emulateTouch` too). A game's own
   * gesture on the canvas (a camera pan, a pinch) skips it. Listen on the canvas: the engine's listener there runs first (it
   * is added at boot, before `load()`), so a new pointer is already assigned in the game's `pointerdown`.
   */
  ownsPointer(id: number): boolean {
    return this.stick?.id === id || (this.look !== null && this.touchLook.owns(id));
  }

  constructor(private el: HTMLElement, actions: ActionMap = DEFAULT_ACTIONS, look: boolean | Partial<LookOptions> = false) {
    this.actions = { ...actions };
    this.look = resolveLook(look);
    // ?nolock: never capture the mouse (tests, hosts that refuse pointer lock); keys, touch and pad still look.
    this.lockFailed = typeof location !== "undefined" && new URLSearchParams(location.search).has("nolock");
    this.markTouch();
    addEventListener("keydown", (e) => {
      // A key the UI already handled (the Frontend closing a popup on Escape, which resumes the round) is not also a game key:
      // with focus outside the popup (a click on the card's ribbon), the Escape that closed the pause card used to arrive here
      // after the resume and pause the round again on the next frame. (The Frontend's listener is registered before this one.)
      if (e.defaultPrevented) return;
      if (isFormTarget(e.target)) return;
      // Menus and popups keep their own keys (focus moves, button presses, Escape).
      if ((e.target as HTMLElement)?.closest?.(".popup, .screen")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      this.device = "keyboard";
      if (!e.repeat) this.edges.add(e.code);
      this.keys.add(e.code);
      if (this.gameplay && this.isGameKey(e.code)) e.preventDefault();
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    // A menu tap precedes Flow.play's click. Remember it before that click asks
    // for mouse lock; a touch-only player may never have touched the canvas yet.
    addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      this.touched();
    });
    addEventListener("blur", () => this.clear());
    document.addEventListener("visibilitychange", () => document.hidden && this.clear());

    // Mouse look: only while the pointer is locked to the canvas.
    document.addEventListener("mousemove", (e) => {
      if (!this.look || !this.locked || !this.gameplay) return;
      const [dx, dy] = mouseLook(e.movementX, e.movementY, this.look);
      this.lookAcc[0] += dx;
      this.lookAcc[1] += dy;
    });
    document.addEventListener("pointerlockchange", () => {
      if (this.locked) {
        this.wasLocked = true;
        this.lockAsker = null;
        this.clickRefusals = 0;
        this.device = "mouse";
      } else if (this.wasLocked) {
        this.wasLocked = false;
        this.mouse.down = false;
        this.onUnlock?.();
      }
    });
    // A refusal to a click means pointer lock is not going to work here; a refusal to the flow's own request
    // (Resume by keyboard has no fresh activation) only means "click to capture".
    document.addEventListener("pointerlockerror", () => {
      if (this.lockAsker === "click") this.refused();
      this.lockAsker = null;
    });

    /** A mouse, unless it stands in for a finger (`emulateTouch`). */
    const isMouse = (e: PointerEvent) => e.pointerType === "mouse" && !this.emulateTouch;
    el.addEventListener("pointermove", (e) => {
      if (isMouse(e)) {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
        this.mouse.inside = true;
      } else if (this.stick?.id === e.pointerId) {
        this.stick.x = e.clientX;
        this.stick.y = e.clientY;
      } else if (this.look && this.touchLook.owns(e.pointerId)) {
        const [dx, dy] = this.touchLook.move(e.pointerId, e.clientX, e.clientY, this.look);
        this.lookAcc[0] += dx;
        this.lookAcc[1] += dy;
      }
    });
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && this.emulateTouch && e.button !== 0) return; // (a finger has no right button)
      if (isMouse(e)) {
        this.device = "mouse";
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
        this.mouse.inside = true;
        // In play with look on, the first click captures the mouse and is not a press.
        if (this.look && this.gameplay && !this.locked && !this.lockBlocked) {
          this.requestLook("click");
          return;
        }
        if (e.button === 0) this.mouse.down = true;
        this.edges.add(`Mouse:${e.button}`);
        // (A captured mouse needs no pointer capture, and Chrome refuses it there with an InvalidStateError.)
        if (!this.locked) el.setPointerCapture(e.pointerId);
      } else {
        this.touched();
        if (this.look && this.touchLook.begin(e.pointerId, e.clientX, e.clientY, el.clientWidth || innerWidth, this.look)) {
          el.setPointerCapture(e.pointerId);
        } else if (!this.stick && this.stickZone(e.clientX, e.clientY) && (!this.look || e.clientX < (el.clientWidth || innerWidth) * this.look.split)) {
          el.setPointerCapture(e.pointerId);
          this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
        }
      }
    });
    const up = (e: PointerEvent) => {
      if (isMouse(e)) {
        if (e.button === 0 || e.type === "pointercancel") this.mouse.down = false;
      } else if (this.stick?.id === e.pointerId) {
        this.stick = null;
      } else {
        this.touchLook.end(e.pointerId);
      }
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse") this.mouse.inside = false;
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private isGameKey(code: string) {
    if (Object.values(MOVE_KEYS).some((c) => c.includes(code))) return true;
    if (code === "Space" || code === "Tab") return true;
    return Object.values(this.actions).some((codes) => codes.includes(code));
  }

  /** Mouse capture is unavailable (refused by the browser, ?nolock) or beside the point (a touch device): don't ask the player to click for it. */
  get lockBlocked(): boolean {
    return this.lockFailed || this.touchEver || this.emulateTouch;
  }

  /** The mouse is captured (pointer lock) by this page's canvas. */
  get locked(): boolean {
    return typeof document !== "undefined" && document.pointerLockElement === this.el;
  }

  /**
   * Ask the browser to capture the mouse for look input. Needs a recent user activation (the
   * caller must request it before awaiting transitions); fails quietly otherwise, and the player's next click on
   * the canvas captures instead. No-op without look input or after a touch.
   */
  requestLook(asker: "flow" | "click" = "flow") {
    if (!this.look || this.locked || this.lockBlocked) return;
    this.lockAsker = asker;
    try {
      const r = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
      r?.catch?.(() => {
        // Browsers may report the same refusal through both this promise and
        // pointerlockerror. Count that request once, whichever arrives first.
        if (this.lockAsker !== asker) return;
        if (asker === "click") this.refused();
        this.lockAsker = null;
      });
    } catch {
      if (asker === "click") this.lockFailed = true;
      this.lockAsker = null;
    }
  }

  /** The browser refused a lock the player clicked for: once may be a timing rule (it insists on a moment after Esc), twice is a verdict. */
  private refused() {
    if (++this.clickRefusals >= 2) this.lockFailed = true;
  }

  /** Give the mouse back (pause, menus). */
  releaseLook() {
    if (this.locked) document.exitPointerLock();
  }

  /**
   * Drop held state (blocking screen changes, blur). Edges too. The mouse capture is released, unless `keepLook`: a round that starts from the click
   * that captured the mouse keeps it (the browser would not give it back without a fresh click, and the countdown is longer than that click stays fresh).
   */
  clear(keepLook = false) {
    this.keys.clear();
    this.edges.clear();
    this.mouse.down = false;
    this.stick = null;
    this.padPrev = [];
    this.touchLook.clear();
    this.buttons.clear();
    this.lookAcc = [0, 0];
    if (!keepLook) this.releaseLook();
  }

  /** A finger (or the mouse standing in for one) went down: touch is the device now, and for the rest of the page's life. */
  private touched() {
    this.device = "touch";
    this.lastTouch = performance.now();
    if (this.touchEver) return;
    this.touchEver = true;
    this.markTouch();
  }

  /** `body.touch-controls` follows `touchControls` (no page in unit tests). */
  private markTouch() {
    const body = typeof document === "undefined" ? undefined : document.body;
    if (body && body.classList.contains("touch-controls") !== this.touchControls) body.classList.toggle("touch-controls", this.touchControls);
  }

  /** Trigger an action edge from UI (a HUD button). */
  press(action: string) {
    this.edges.add(`Action:${action}`);
  }

  /** An on-screen touch button went down: the action is held (and pressed) until `buttonUp`. */
  buttonDown(pointerId: number, action: string) {
    this.touched();
    if (this.buttons.down(pointerId, action)) this.edges.add(`Action:${action}`);
  }

  buttonUp(pointerId: number) {
    this.buttons.up(pointerId);
  }

  /** `dt`: seconds since the last poll (for the look sources that are rates: arrow keys, right stick). */
  poll(dt = 1 / 60): InputSnapshot {
    let [moveX, moveY] = keyAxes(this.keys, !this.look);
    if (this.stick) {
      [moveX, moveY] = stickAxes(this.stick);
      this.lastTouch = performance.now();
    }
    let lookX = this.lookAcc[0], lookY = this.lookAcc[1];
    this.lookAcc = [0, 0];
    if (this.look) {
      const [kx, ky] = keyLook(this.keys, dt, this.look);
      lookX += kx;
      lookY += ky;
    }

    // Gamepad: left stick / d-pad move, right stick looks; buttons map through the action table.
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads.find((p) => p && p.connected) ?? null;
    const padHeld = new Set<string>();
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < PAD_DEADZONE ? 0 : v);
      let lx = dz(pad.axes[0] ?? 0), ly = dz(pad.axes[1] ?? 0);
      const b = pad.buttons.map((x) => x.pressed);
      if (b[12]) ly = -1;
      if (b[13]) ly = 1;
      if (b[14]) lx = -1;
      if (b[15]) lx = 1;
      if (lx || ly) {
        const l = Math.hypot(lx, ly);
        moveX = l > 1 ? lx / l : lx;
        moveY = l > 1 ? ly / l : ly;
        this.device = "gamepad";
      }
      if (this.look) {
        const [px, py] = padLook(pad.axes[2] ?? 0, pad.axes[3] ?? 0, dt, this.look, PAD_DEADZONE);
        if (px || py) this.device = "gamepad";
        lookX += px;
        lookY += py;
      }
      b.forEach((on, i) => {
        if (!on) return;
        padHeld.add(`Pad:${i}`);
        if (!this.padPrev[i]) {
          this.edges.add(`Pad:${i}`);
          this.device = "gamepad";
        }
      });
      this.padPrev = b;
    }

    const held = new Set<string>();
    const pressed = new Set<string>();
    for (const [action, codes] of Object.entries(this.actions)) {
      if (codes.some((c) => this.keys.has(c) || padHeld.has(c) || (c === "Mouse:0" && this.mouse.down)) || this.buttons.has(action)) held.add(action);
      if (codes.some((c) => this.edges.has(c)) || this.edges.has(`Action:${action}`)) pressed.add(action);
    }
    this.edges.clear();
    return {
      moveX, moveY, lookX, lookY, held, pressed,
      pointer: { ...this.mouse },
      locked: this.locked,
      device: this.device,
      touchActive: performance.now() - this.lastTouch < TOUCH_MEMORY_MS,
    };
  }
}
