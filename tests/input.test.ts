import { describe, expect, it } from "vitest";
import { STICK_RADIUS, keyAxes, stickAxes, type TouchStick } from "../src/input";

describe("keyAxes", () => {
  it("maps WASD/arrows to screen axes and normalises diagonals", () => {
    expect(keyAxes(new Set())).toEqual([0, 0]);
    expect(keyAxes(new Set(["KeyD"]))).toEqual([1, 0]);
    expect(keyAxes(new Set(["ArrowUp"]))).toEqual([0, -1]);
    const [x, y] = keyAxes(new Set(["KeyW", "KeyA"]));
    expect(Math.hypot(x, y)).toBeCloseTo(1, 6);
    expect(x).toBeLessThan(0);
    expect(y).toBeLessThan(0);
    expect(keyAxes(new Set(["KeyA", "KeyD"]))).toEqual([0, 0]);
  });
});

describe("stickAxes", () => {
  const s = (dx: number, dy: number): TouchStick => ({ id: 1, ox: 100, oy: 100, x: 100 + dx, y: 100 + dy });
  it("has a dead zone and saturates at the radius", () => {
    expect(stickAxes(s(3, 0))).toEqual([0, 0]);
    const [x] = stickAxes(s(STICK_RADIUS / 2, 0));
    expect(x).toBeCloseTo(0.5, 5);
    const [x2, y2] = stickAxes(s(0, STICK_RADIUS));
    expect(x2).toBeCloseTo(0, 6);
    expect(y2).toBeCloseTo(1, 6);
  });
  it("drags the origin along when the thumb overshoots", () => {
    const st = s(STICK_RADIUS * 3, 0);
    const [x] = stickAxes(st);
    expect(x).toBeCloseTo(1, 6);
    expect(st.ox).toBeCloseTo(100 + STICK_RADIUS * 2, 6);
  });
});
