import { describe, expect, it } from "vitest";
import { freshSettings, sanitizeSettings } from "../src/settings";

describe("sanitizeSettings", () => {
  it("keeps valid values and repairs the rest", () => {
    const f = freshSettings();
    expect(sanitizeSettings({ volume: 0.3, muted: true, shadows: false, outlines: false, reducedMotion: true }, f)).toEqual({ volume: 0.3, muted: true, shadows: false, outlines: false, reducedMotion: true });
    expect(sanitizeSettings({ volume: 7 }, f).volume).toBe(1);
    expect(sanitizeSettings({ volume: -1 }, f).volume).toBe(0);
    expect(sanitizeSettings({ volume: "loud", shadows: "yes" }, f)).toEqual(f);
    expect(sanitizeSettings(null, f)).toEqual(f);
    expect(sanitizeSettings({ reducedMotion: "sometimes" }, f).reducedMotion).toBeNull();
  });
});
