import { describe, expect, it } from "vitest";
import { overrides, tuningBasis } from "../src/dev/tuning";
import { DEFAULT_STYLE } from "../src/gpu/renderer";

const style = { ...DEFAULT_STYLE } as unknown as Record<string, number>; // includes colour arrays (shadowTint, sky…)

describe("DEV tuning overrides", () => {
  it("stamps saves with a basis that changes when any declared default changes", () => {
    const a = tuningBasis(style, { 0: 4, 1: 0.5 });
    expect(tuningBasis({ ...style }, { 1: 0.5, 0: 4 })).toBe(a); // key order does not matter
    expect(tuningBasis({ ...style, exposure: 1.2 }, { 0: 4, 1: 0.5 })).not.toBe(a); // a new lighting pass
    expect(tuningBasis(style, { 0: 4, 1: 0.6 })).not.toBe(a); // a retuned rule
    expect(tuningBasis(style, { 0: 4, 1: 0.5, 2: 1 })).not.toBe(a); // a new param
    expect(tuningBasis({ ...style, exposure: 1.00001 }, { 0: 4, 1: 0.5 })).toBe(a); // below the saved precision
    expect(tuningBasis({ ...style, shadowTint: [0.2, 0.3, 0.6] } as never, { 0: 4, 1: 0.5 })).not.toBe(a); // a new default colour
  });

  it("saves only the values that differ from the defaults", () => {
    expect(overrides({ ...style, exposure: 1.25, bloom: style.bloom + 1e-6 }, style)).toEqual({ exposure: 1.25 });
    expect(overrides({ 0: 4, 1: 0.75 }, { 0: 4, 1: 0.5 })).toEqual({ 1: 0.75 });
    expect(overrides({ stray: 3 }, style)).toEqual({}); // nothing for a value with no declared default
  });
});
