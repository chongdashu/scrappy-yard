// Look input through the real `Input` class, with a minimal fake browser: mouse look under pointer lock,
// touch drag on the right and the move stick on the left, the arrow keys, the gamepad's right stick,
// on-screen buttons, and the rules around them (popups own their keys, held input clears, losing the
// mouse capture is reported so the flow can pause).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOOK } from "../src/look";
import { Input, type InputSnapshot } from "../src/input";

type Handler = (e: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

class Target {
  handlers = new Map<string, Handler[]>();
  addEventListener(type: string, fn: Handler) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  fire(type: string, e: object = {}) {
    for (const fn of this.handlers.get(type) ?? []) fn(e);
  }
}

let win: Target, doc: Target & { hidden: boolean; pointerLockElement: unknown; exitPointerLock: () => void };
let el: Target & { clientWidth: number; setPointerCapture: () => void; requestPointerLock: () => void };
let pads: unknown[];

beforeEach(() => {
  win = new Target();
  pads = [];
  doc = Object.assign(new Target(), {
    hidden: false,
    pointerLockElement: null as unknown,
    exitPointerLock: vi.fn(() => {
      doc.pointerLockElement = null;
      doc.fire("pointerlockchange");
    }),
  });
  el = Object.assign(new Target(), {
    clientWidth: 800,
    setPointerCapture: vi.fn(),
    requestPointerLock: vi.fn(() => {
      doc.pointerLockElement = el;
      doc.fire("pointerlockchange");
    }),
  });
  vi.stubGlobal("addEventListener", (t: string, fn: Handler) => win.addEventListener(t, fn));
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", { getGamepads: () => pads });
  vi.stubGlobal("location", { search: "" });
  vi.stubGlobal("innerWidth", 800);
});
afterEach(() => vi.unstubAllGlobals());

const keyEvent = (code: string, over: object = {}) => ({ code, target: {}, repeat: false, metaKey: false, ctrlKey: false, altKey: false, preventDefault: vi.fn(), ...over });
const ptr = (type: string, o: object) => el.fire(type, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 400, clientY: 300, ...o });
const make = (look: boolean | object = true) => new Input(el as unknown as HTMLElement, { verb: ["Mouse:0", "Space", "Pad:0"], wiggle: ["KeyQ"] }, look as never);
const near = (v: number, want: number) => expect(v).toBeCloseTo(want, 5);

describe("arrow keys", () => {
  it("look instead of move when look input is on; WASD still moves", () => {
    const i = make();
    win.fire("keydown", keyEvent("ArrowRight"));
    win.fire("keydown", keyEvent("KeyW"));
    const s = i.poll(1 / 60);
    near(s.lookX, DEFAULT_LOOK.keys / 60);
    expect(s.lookY).toBe(0);
    expect([s.moveX, s.moveY]).toEqual([0, -1]);
    win.fire("keyup", { code: "ArrowRight" });
    expect(i.poll(1 / 60).lookX).toBe(0);
  });
  it("still move a game that did not opt in to look", () => {
    const i = make(false);
    win.fire("keydown", keyEvent("ArrowRight"));
    const s = i.poll(1 / 60);
    expect([s.moveX, s.lookX]).toEqual([1, 0]);
  });
  it("a key the UI already handled is not a game key (the Escape that closed the pause card must not pause again)", () => {
    const i = new Input(el as unknown as HTMLElement, { pause: ["Escape"] }, true);
    win.fire("keydown", keyEvent("Escape", { defaultPrevented: true }));
    win.fire("keydown", keyEvent("KeyW", { defaultPrevented: true }));
    const s = i.poll(1 / 60);
    expect(s.pressed.has("pause")).toBe(false);
    expect(s.moveY).toBe(0);
    win.fire("keydown", keyEvent("Escape"));
    expect(i.poll(1 / 60).pressed.has("pause")).toBe(true);
  });
  it("belong to popups and screens while they are open", () => {
    const i = make();
    win.fire("keydown", keyEvent("ArrowRight", { target: { closest: () => ({}) } }));
    expect(i.poll(1 / 60).lookX).toBe(0);
  });
  it("only stop the browser scrolling while the game is being played", () => {
    const i = make();
    const off = keyEvent("ArrowLeft");
    win.fire("keydown", off);
    expect(off.preventDefault).not.toHaveBeenCalled();
    i.gameplay = true;
    const on = keyEvent("ArrowLeft");
    win.fire("keydown", on);
    expect(on.preventDefault).toHaveBeenCalled();
  });
});

describe("mouse look under pointer lock", () => {
  it("the first click in play captures the mouse and is not a press; later clicks are", () => {
    const i = make();
    i.gameplay = true;
    ptr("pointerdown", {});
    expect(el.requestPointerLock).toHaveBeenCalledTimes(1);
    expect(i.locked).toBe(true);
    const first = i.poll();
    expect(first.held.has("verb") || first.pressed.has("verb")).toBe(false);
    ptr("pointerdown", {});
    const s = i.poll();
    expect(s.held.has("verb") && s.pressed.has("verb")).toBe(true);
    expect(i.poll().pressed.has("verb")).toBe(false);
    ptr("pointerup", {});
    expect(i.poll().held.has("verb")).toBe(false);
  });
  it("turns mouse movement into radians only while locked and playing, and drops spikes", () => {
    const i = make({ mouse: 0.002 });
    i.gameplay = true;
    doc.fire("mousemove", { movementX: 100, movementY: 50 });
    expect(i.poll().lookX).toBe(0); // not locked yet
    ptr("pointerdown", {}); // captures
    doc.fire("mousemove", { movementX: 100, movementY: -50 });
    doc.fire("mousemove", { movementX: 20, movementY: 0 });
    doc.fire("mousemove", { movementX: 5000, movementY: 0 }); // a spike
    const s = i.poll();
    near(s.lookX, 0.24);
    near(s.lookY, -0.1);
    expect(s.locked).toBe(true);
    expect(i.poll().lookX).toBe(0); // deltas are consumed by a poll
    i.gameplay = false;
    doc.fire("mousemove", { movementX: 100, movementY: 0 });
    expect(i.poll().lookX).toBe(0);
  });
  it("tells the flow when the capture is lost (Esc): it pauses", () => {
    const i = make();
    const lost = vi.fn();
    i.onUnlock = lost;
    i.gameplay = true;
    ptr("pointerdown", {});
    doc.pointerLockElement = null; // the browser released it (and swallowed the Esc keypress)
    doc.fire("pointerlockchange");
    expect(lost).toHaveBeenCalledTimes(1);
    // ...but the game's own clear() (pause, menus) releases it without saying so twice.
    ptr("pointerdown", {});
    i.clear();
    expect(doc.exitPointerLock).toHaveBeenCalled();
  });
  it("leaves clicks alone when the browser refuses the lock (or ?nolock), and after a touch", () => {
    const refuse = make();
    refuse.gameplay = true;
    el.requestPointerLock = vi.fn(() => doc.fire("pointerlockerror"));
    ptr("pointerdown", {}); // refused once: could be a timing rule, click again
    ptr("pointerup", {});
    expect(refuse.lockBlocked).toBe(false);
    ptr("pointerdown", {}); // refused twice: it is not going to work here
    ptr("pointerup", {});
    expect(refuse.lockBlocked).toBe(true);
    ptr("pointerdown", {});
    expect(refuse.poll().held.has("verb")).toBe(true);
    vi.stubGlobal("location", { search: "?nolock" });
    const nolock = make();
    nolock.gameplay = true;
    ptr("pointerdown", { pointerId: 2 });
    expect(nolock.poll().held.has("verb")).toBe(true);
    const phone = make();
    ptr("pointerdown", { pointerType: "touch", pointerId: 3, clientX: 100, clientY: 100 });
    phone.requestLook();
    expect(phone.lockBlocked).toBe(true);
  });
  it("a refusal to the flow's own request (Resume by keyboard) is not a verdict: the next click still captures", () => {
    const i = make();
    i.gameplay = true;
    el.requestPointerLock = vi.fn(() => doc.fire("pointerlockerror"));
    i.requestLook(); // the flow, with no fresh activation
    expect(i.lockBlocked).toBe(false);
    el.requestPointerLock = vi.fn(() => {
      doc.pointerLockElement = el;
      doc.fire("pointerlockchange");
    });
    ptr("pointerdown", {}); // the player's click captures
    expect(i.locked).toBe(true);
  });
  it.each(["event-first", "promise-first"])("counts one refusal when both APIs report it (%s)", async order => {
    const i = make();
    i.gameplay = true;
    el.requestPointerLock = vi.fn(() => {
      if (order === "event-first") doc.fire("pointerlockerror");
      return Promise.reject(new Error("not activated"));
    });
    ptr("pointerdown", {});
    await Promise.resolve();
    if (order === "promise-first") doc.fire("pointerlockerror");
    expect(i.lockBlocked).toBe(false);
    ptr("pointerdown", {});
    await Promise.resolve();
    if (order === "promise-first") doc.fire("pointerlockerror");
    expect(i.lockBlocked).toBe(true);
  });
  it("keeps mouse action clicks usable after switching from touch", () => {
    const i = make();
    win.fire("pointerdown", { pointerType: "touch" });
    i.gameplay = true;
    ptr("pointerdown", {});
    expect(el.requestPointerLock).not.toHaveBeenCalled();
    const snap = i.poll();
    expect(snap.held.has("verb") && snap.pressed.has("verb")).toBe(true);
  });
  it("a round that starts from the click that captured the mouse keeps the capture: clear(true) holds it, clear() gives it back", () => {
    const i = make();
    i.requestLook(); // the Play click (a fresh activation)
    expect(i.locked).toBe(true);
    i.gameplay = false; // ...then the menu's exit, the intro and the countdown (the click has gone stale by GO): no mouse look yet
    win.fire("keydown", keyEvent("KeyW"));
    i.clear(true); // the round's setup drops held input, not the capture
    expect(doc.exitPointerLock).not.toHaveBeenCalled();
    expect(i.locked).toBe(true);
    expect(i.poll(1 / 60).moveY).toBe(0); // (the held key went; nothing else changed)
    i.gameplay = true; // GO: the first mouse move already looks around
    doc.fire("mousemove", { movementX: 40, movementY: 0 });
    expect(i.poll(1 / 60).lookX).not.toBe(0);
    i.clear(); // pause, menus and the end of the round give the mouse back
    expect(doc.exitPointerLock).toHaveBeenCalledTimes(1);
    expect(i.locked).toBe(false);
  });
  it("ignores mouse movement until the round is in play, even with the mouse captured", () => {
    const i = make();
    i.requestLook();
    doc.fire("mousemove", { movementX: 80, movementY: 80 }); // (the countdown)
    i.gameplay = true;
    const s = i.poll(1 / 60);
    expect([s.lookX, s.lookY]).toEqual([0, 0]);
  });
  it("requestLook is a no-op without look input", () => {
    const i = make(false);
    i.requestLook();
    expect(el.requestPointerLock).not.toHaveBeenCalled();
  });
});

describe("touch", () => {
  it("the left of the screen drives the stick, the right drags the view, at the same time", () => {
    const i = make({ touch: 0.01 });
    ptr("pointerdown", { pointerType: "touch", pointerId: 5, clientX: 100, clientY: 600 });
    ptr("pointerdown", { pointerType: "touch", pointerId: 6, clientX: 600, clientY: 300 });
    ptr("pointermove", { pointerType: "touch", pointerId: 5, clientX: 100, clientY: 560 });
    ptr("pointermove", { pointerType: "touch", pointerId: 6, clientX: 650, clientY: 280 });
    const s = i.poll();
    expect(s.moveY).toBeLessThan(-0.5); // dragged up: forward
    near(s.lookX, 0.5);
    near(s.lookY, -0.2);
    expect(i.touchStick).not.toBeNull();
    expect(i.touchEver).toBe(true);
    // Releasing the look finger stops the drag; a third finger on the right doesn't start a second one.
    ptr("pointerup", { pointerType: "touch", pointerId: 6 });
    ptr("pointermove", { pointerType: "touch", pointerId: 6, clientX: 700, clientY: 280 });
    expect(i.poll().lookX).toBe(0);
  });
  it("owns the stick's and the look drag's pointers, so a game's canvas gesture can skip them", () => {
    const i = make({ touch: 0.01 });
    ptr("pointerdown", { pointerType: "touch", pointerId: 5, clientX: 100, clientY: 600 });
    ptr("pointerdown", { pointerType: "touch", pointerId: 6, clientX: 600, clientY: 300 });
    expect([i.ownsPointer(5), i.ownsPointer(6), i.ownsPointer(7)]).toEqual([true, true, false]);
    ptr("pointerup", { pointerType: "touch", pointerId: 5 });
    ptr("pointerup", { pointerType: "touch", pointerId: 6 });
    expect([i.ownsPointer(5), i.ownsPointer(6)]).toEqual([false, false]);
  });
  it("a touch on the right doesn't start the stick, and a game without look keeps the old anywhere-stick", () => {
    const i = make();
    ptr("pointerdown", { pointerType: "touch", pointerId: 5, clientX: 700, clientY: 600 });
    expect(i.touchStick).toBeNull();
    const old = make(false);
    ptr("pointerdown", { pointerType: "touch", pointerId: 7, clientX: 700, clientY: 600 });
    expect(old.touchStick).not.toBeNull();
  });
});

describe("emulateTouch (a dev phone preview on a desktop)", () => {
  it("is off by default: the mouse is a mouse", () => {
    expect(make().emulateTouch).toBe(false);
  });
  it("turns a left-button mouse drag into the touch stick: no click, no capture, the pointer stays still", () => {
    const i = make();
    i.emulateTouch = true;
    i.gameplay = true;
    ptr("pointerdown", { pointerId: 1, clientX: 100, clientY: 600 });
    ptr("pointermove", { pointerId: 1, clientX: 100, clientY: 540 });
    const s = i.poll(1 / 60);
    expect(s.moveY).toBeLessThan(-0.5);
    expect(s.pressed.has("verb")).toBe(false);
    expect(s.pointer.down).toBe(false);
    expect(el.requestPointerLock).not.toHaveBeenCalled();
    i.requestLook();
    expect(el.requestPointerLock).not.toHaveBeenCalled();
    ptr("pointerup", { pointerId: 1 });
    expect(i.touchStick).toBeNull();
  });
  it("drags the view on the right, like a finger; other mouse buttons do nothing", () => {
    const i = make({ touch: 0.01 });
    i.emulateTouch = true;
    i.gameplay = true;
    ptr("pointerdown", { pointerId: 2, button: 2, clientX: 100, clientY: 600 });
    expect(i.touchStick).toBeNull();
    ptr("pointerdown", { pointerId: 3, clientX: 600, clientY: 300 });
    ptr("pointermove", { pointerId: 3, clientX: 650, clientY: 300 });
    near(i.poll().lookX, 0.5);
  });
});

describe("touchControls and body.touch-controls (a phone layout written once)", () => {
  const body = () => {
    const names = new Set<string>();
    const classList = { contains: (n: string) => names.has(n), toggle: vi.fn((n: string, on: boolean) => (on ? names.add(n) : names.delete(n), on)) };
    Object.assign(doc, { body: { classList } });
    return classList;
  };
  it("is off on a desktop that has had no touch, and the page is not marked", () => {
    const classList = body();
    const i = make();
    expect(i.touchControls).toBe(false);
    expect(classList.contains("touch-controls")).toBe(false);
  });
  it("turns on, and marks the page, at the first touch", () => {
    const classList = body();
    const i = make();
    ptr("pointerdown", { pointerType: "touch", clientX: 100, clientY: 600 });
    expect(i.touchControls).toBe(true);
    expect(classList.contains("touch-controls")).toBe(true);
    ptr("pointerdown", { pointerType: "touch", pointerId: 2, clientX: 120, clientY: 600 });
    expect(classList.toggle).toHaveBeenCalledTimes(1); // (once: the mark is sticky like touchEver)
  });
  it("follows emulateTouch both ways (the dev Mobile view)", () => {
    const classList = body();
    const i = make();
    i.emulateTouch = true;
    expect(i.touchControls).toBe(true);
    expect(classList.contains("touch-controls")).toBe(true);
    i.emulateTouch = false;
    expect(classList.contains("touch-controls")).toBe(false);
  });
  it("is on from the start on a touch screen (a coarse pointer)", () => {
    const classList = body();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(pointer: coarse)" }));
    expect(make().touchControls).toBe(true);
    expect(classList.contains("touch-controls")).toBe(true);
  });
});

describe("gamepad", () => {
  it("the right stick looks (dead zone, squared response) and A is a verb press", () => {
    const i = make();
    pads = [{ connected: true, axes: [0, 0, 0.1, 0.1], buttons: Array.from({ length: 16 }, () => ({ pressed: false })) }];
    expect(i.poll(1 / 60).lookX).toBe(0);
    pads = [{ connected: true, axes: [0, 0, 1, -1], buttons: Array.from({ length: 16 }, (_, k) => ({ pressed: k === 0 })) }];
    const s = i.poll(1 / 60);
    near(s.lookX, DEFAULT_LOOK.stick / 60);
    near(s.lookY, -DEFAULT_LOOK.stick / 60);
    expect(s.held.has("verb") && s.pressed.has("verb")).toBe(true);
    expect(s.device).toBe("gamepad");
  });
});

describe("on-screen buttons", () => {
  it("hold an action while a finger is on them and give one press edge", () => {
    const i = make();
    i.buttonDown(11, "verb");
    let s = i.poll();
    expect(s.held.has("verb") && s.pressed.has("verb")).toBe(true);
    s = i.poll();
    expect(s.held.has("verb")).toBe(true);
    expect(s.pressed.has("verb")).toBe(false);
    i.buttonDown(12, "verb"); // a second finger on the same button is not a new press
    expect(i.poll().pressed.has("verb")).toBe(false);
    i.buttonUp(11);
    expect(i.poll().held.has("verb")).toBe(true);
    i.buttonUp(12);
    expect(i.poll().held.has("verb")).toBe(false);
    expect(i.touchEver).toBe(true);
  });
  it("are released with everything else on blur, hidden tabs and clear()", () => {
    const i = make();
    i.buttonDown(11, "verb");
    win.fire("blur");
    expect(i.poll().held.has("verb")).toBe(false);
    i.buttonDown(11, "verb");
    ptr("pointerdown", { pointerType: "touch", pointerId: 5, clientX: 600, clientY: 300 });
    doc.hidden = true;
    doc.fire("visibilitychange");
    const s = i.poll();
    expect(s.held.has("verb")).toBe(false);
    expect(i.touchStick).toBeNull();
  });
});

describe("the snapshot", () => {
  it("carries look, capture and the neutral form zeroes them", async () => {
    const { neutralInput } = await import("../src/input");
    const i = make();
    win.fire("keydown", keyEvent("ArrowDown"));
    const s: InputSnapshot = i.poll(0.1);
    expect(s.lookY).toBeGreaterThan(0);
    const n = neutralInput(s);
    expect([n.lookX, n.lookY]).toEqual([0, 0]);
  });
});


describe("look activation from a menu", () => {
  it("a touch on UI suppresses the Play click's mouse-lock request before any canvas touch", () => {
    const input = new Input(el as unknown as HTMLElement, {}, true);
    win.fire("pointerdown", { pointerType: "touch" });
    input.requestLook();
    expect(input.touchEver).toBe(true);
    expect(el.requestPointerLock).not.toHaveBeenCalled();
    expect(input.poll().device).toBe("touch");
  });
});
