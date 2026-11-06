// Scene routing and the oncoming camera's forward read (kickoff gym, owner read 2026-11-04).
import { describe, expect, it } from "vitest";
import { CAMERAS, framing, sceneFromUrl, sideRise, SIDE_GROW, strafeAxis, visibleAhead, WARN_SECONDS } from "../src/game";

describe("scenes", () => {
  it("routes ?scene= to gym, viewer and the character test (with aliases)", () => {
    expect(sceneFromUrl("")).toBe("gym");
    expect(sceneFromUrl("?scene=viewer")).toBe("viewer");
    expect(sceneFromUrl("?scene=character")).toBe("character");
    expect(sceneFromUrl("?scene=char-test")).toBe("character");
    expect(sceneFromUrl("?scene=nope")).toBe("gym");
  });
});

describe("heads-up camera", () => {
  it("is the default and shows far more oncoming track than mockup D", () => {
    expect(CAMERAS[0].name).toBe("heads-up");
    const d = CAMERAS.find((c) => c.name === "mockup D")!;
    for (const aspect of [0.46, 1.33, 1.78]) {
      const hu = visibleAhead(framing(CAMERAS[0], aspect));
      const md = visibleAhead(framing(d, aspect));
      expect(hu).toBeGreaterThan(md + 2.5);
      // At 8 m/s, at least ~0.6 s of track is on screen ahead of the player.
      expect(hu / 8).toBeGreaterThan(0.6);
    }
  });
  it("warns further out than the kickoff 2.2 s", () => {
    expect(WARN_SECONDS).toBeGreaterThanOrEqual(3);
  });
});

// Owner 2026-11-04: side dressing is full size whenever it is drawn (no grow-in).
describe("side scenery", () => {
  it("never scales in", () => {
    for (let d = -SIDE_GROW - 5; d <= 40; d += 0.5) expect(sideRise(d)).toBe(1);
  });
});

describe("strafe input", () => {
  it("has a dead band and reaches full speed before the stick's edge", () => {
    expect(strafeAxis(0.2)).toBe(0);
    expect(strafeAxis(-1)).toBe(-1);
    expect(strafeAxis(0.8)).toBeCloseTo(1);
    expect(strafeAxis(0.5)).toBeGreaterThan(0.4);
  });
});
