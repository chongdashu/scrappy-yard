import { describe, expect, it } from "vitest";
import { PIXEL_BUDGET_LIMITS, applyBudget, captureBudget, parseMaxPixels } from "../src/capture";

const q = (s: string) => new URLSearchParams(s);

describe("capture render budget (?capture&maxpx&maxdpr, __game.pixelBudget)", () => {
  it("reads a pixel count or a size", () => {
    expect(parseMaxPixels("8294400")).toBe(8_294_400);
    expect(parseMaxPixels("5120x2880")).toBe(5120 * 2880);
    expect(parseMaxPixels(" 3840 × 2160 ")).toBe(3840 * 2160);
    for (const bad of [null, "", "0", "-5", "big", "10x", "x10"]) expect(parseMaxPixels(bad)).toBeNull();
  });

  it("only applies in capture mode, and clamps", () => {
    expect(captureBudget(q("maxpx=9000000&maxdpr=3"))).toEqual({});
    expect(captureBudget(q("capture"))).toEqual({});
    expect(captureBudget(q("capture&maxpx=5120x2880&maxdpr=2"))).toEqual({ maxPixels: 14_745_600, maxDpr: 2 });
    expect(captureBudget(q("capture&maxpx=1e12&maxdpr=99"))).toEqual({ maxPixels: PIXEL_BUDGET_LIMITS.maxPixels[1], maxDpr: 4 });
    expect(captureBudget(q("capture&maxpx=nope&maxdpr=0"))).toEqual({});
  });

  it("changes only what it is given and reports the caps in force", () => {
    const r = { maxPixels: 2_600_000, maxDpr: 2 };
    expect(applyBudget(r)).toEqual({ maxPixels: 2_600_000, maxDpr: 2 });
    expect(applyBudget(r, { maxPixels: 2560 * 1440 * 4 })).toEqual({ maxPixels: 14_745_600, maxDpr: 2 });
    expect(applyBudget(r, { maxDpr: 0.1 })).toEqual({ maxPixels: 14_745_600, maxDpr: 0.5 });
    expect(applyBudget(r, { maxPixels: -1, maxDpr: NaN })).toEqual({ maxPixels: 14_745_600, maxDpr: 0.5 });
    expect(r).toEqual({ maxPixels: 14_745_600, maxDpr: 0.5 });
  });
});
