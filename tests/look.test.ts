import { describe, expect, it } from "vitest";
import { DEFAULT_LOOK, HeldActions, MOUSE_SPIKE_PX, TouchLook, keyLook, mouseLook, padLook, resolveLook } from "../src/look";
import { keyAxes, neutralInput, type InputSnapshot } from "../src/input";

const o = { ...DEFAULT_LOOK };

describe("resolveLook", () => {
  it("is off unless a game opts in, and repairs bad sensitivities", () => {
    expect(resolveLook(undefined)).toBeNull();
    expect(resolveLook(false)).toBeNull();
    expect(resolveLook(true)).toEqual(DEFAULT_LOOK);
    expect(resolveLook({ mouse: 0.004 })?.mouse).toBe(0.004);
    expect(resolveLook({ touch: Number.NaN })?.touch).toBe(DEFAULT_LOOK.touch);
    expect(resolveLook({ keys: -1 })?.keys).toBe(DEFAULT_LOOK.keys);
    expect(resolveLook({ split: 5 })?.split).toBeLessThanOrEqual(0.9);
  });
});

describe("keyLook and keyAxes", () => {
  it("arrow keys look at a rate (x right, y down) and cap a hitch frame", () => {
    expect(keyLook(new Set(), 1 / 60, o)).toEqual([0, 0]);
    const [x, y] = keyLook(new Set(["ArrowRight", "ArrowDown"]), 0.5, o);
    expect(x).toBeCloseTo(o.keys * 0.1, 6); // dt is capped at 0.1 s
    expect(y).toBeCloseTo(o.keys * 0.1, 6);
    expect(keyLook(new Set(["ArrowLeft"]), 1 / 60, o)[0]).toBeCloseTo(-o.keys / 60, 6);
    expect(keyLook(new Set(["ArrowLeft", "ArrowRight"]), 1 / 60, o)).toEqual([0, 0]);
    expect(keyLook(new Set(["KeyA", "KeyW"]), 1 / 60, o)).toEqual([0, 0]);
  });
  it("arrows stop moving once they look; WASD keeps moving", () => {
    expect(keyAxes(new Set(["ArrowUp"]))).toEqual([0, -1]);
    expect(keyAxes(new Set(["ArrowUp"]), false)).toEqual([0, 0]);
    expect(keyAxes(new Set(["KeyW", "ArrowLeft"]), false)).toEqual([0, -1]);
    const [x] = keyAxes(new Set(["KeyD"]), false);
    expect(x).toBe(1);
  });
});

describe("padLook", () => {
  it("has a dead zone and a squared response", () => {
    expect(padLook(0.1, -0.15, 1 / 60, o)).toEqual([0, 0]);
    const [half] = padLook(0.6, 0, 1 / 60, o);
    const [full, fullY] = padLook(1, 1, 1 / 60, o);
    expect(full).toBeCloseTo(o.stick / 60, 6);
    expect(fullY).toBeCloseTo(o.stick / 60, 6);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full * 0.5);
    expect(padLook(-1, 0, 1 / 60, o)[0]).toBeCloseTo(-o.stick / 60, 6);
    expect(padLook(Number.NaN, 0, 1 / 60, o)).toEqual([0, 0]);
  });
});

describe("mouseLook", () => {
  it("scales pixels to radians and drops the spike some browsers send when the lock engages", () => {
    expect(mouseLook(100, -50, o)).toEqual([100 * o.mouse, -50 * o.mouse]);
    expect(mouseLook(MOUSE_SPIKE_PX + 1, 5, o)[0]).toBe(0);
    expect(mouseLook(Number.NaN, 0, o)).toEqual([0, 0]);
  });
});

describe("TouchLook", () => {
  it("only the right of the screen drags the view, one finger at a time", () => {
    const t = new TouchLook();
    expect(t.begin(1, 100, 300, 800, o)).toBe(false); // left: that is the move stick
    expect(t.begin(2, 600, 300, 800, o)).toBe(true);
    expect(t.begin(3, 700, 300, 800, o)).toBe(false); // already looking
    const [dx, dy] = t.move(2, 650, 280, o);
    expect(dx).toBeCloseTo(50 * o.touch, 6);
    expect(dy).toBeCloseTo(-20 * o.touch, 6);
    expect(t.move(3, 900, 900, o)).toEqual([0, 0]);
    expect(t.move(2, 650, 280, o)).toEqual([0, 0]);
    expect(t.end(3)).toBe(false);
    expect(t.end(2)).toBe(true);
    expect(t.active).toBe(false);
    expect(t.begin(4, 500, 100, 800, o)).toBe(true);
    t.clear();
    expect(t.active).toBe(false);
  });
});

describe("HeldActions", () => {
  it("reports an edge only when the action goes from up to held, and holds while any finger is on it", () => {
    const h = new HeldActions();
    expect(h.has("verb")).toBe(false);
    expect(h.down(1, "verb")).toBe(true);
    expect(h.down(2, "verb")).toBe(false);
    h.up(1);
    expect(h.has("verb")).toBe(true);
    h.up(2);
    expect(h.has("verb")).toBe(false);
    expect(h.down(3, "verb")).toBe(true);
    h.clear();
    expect(h.has("verb")).toBe(false);
  });
});

describe("neutralInput", () => {
  it("drops look with the rest of the player's control but keeps the capture state", () => {
    const snap: InputSnapshot = {
      moveX: 1, moveY: 1, lookX: 0.3, lookY: -0.2, held: new Set(["verb"]), pressed: new Set(["verb"]),
      pointer: { x: 1, y: 2, down: true, inside: true }, locked: true, device: "mouse", touchActive: false,
    };
    const n = neutralInput(snap);
    expect([n.moveX, n.moveY, n.lookX, n.lookY]).toEqual([0, 0, 0, 0]);
    expect(n.held.size + n.pressed.size).toBe(0);
    expect(n.pointer.down).toBe(false);
    expect(n.locked).toBe(true);
  });
});
