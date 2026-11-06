// GameRuntime.onPhase: listeners hear each phase change once, in order, with the phase it left; a failing listener
// is reported without stopping the others; the returned function stops one. (The runtime is built from fakes: only
// its phase plumbing runs here.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameRuntime } from "../src/runtime";
import type { Phase } from "../src/game";

beforeEach(() => {
  vi.stubGlobal("location", { search: "" });
  vi.stubGlobal("document", { querySelector: () => ({}) });
});
afterEach(() => vi.unstubAllGlobals());

const make = () => {
  const Ctor = GameRuntime as unknown as new (...args: unknown[]) => GameRuntime;
  return new Ctor({}, {}, {}, {}, {}, {}, {}, 1);
};

describe("GameRuntime.onPhase", () => {
  it("tells each listener every change once, with the phase it left", () => {
    const rt = make();
    const heard: [Phase, Phase][] = [];
    rt.onPhase((phase, previous) => heard.push([phase, previous]));
    expect(rt.phase).toBe("boot");
    rt.phase = "title";
    rt.phase = "menu";
    rt.phase = "menu"; // no change, no call
    rt.phase = "playing";
    expect(heard).toEqual([["title", "boot"], ["menu", "title"], ["playing", "menu"]]);
  });

  it("keeps going past a listener that throws, and stops one on request", () => {
    const rt = make();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = vi.fn(() => {
      throw new Error("listener bug");
    });
    const b = vi.fn();
    const stopB = rt.onPhase(b);
    rt.onPhase(a);
    rt.phase = "menu";
    expect(rt.phase).toBe("menu");
    expect(b).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    stopB();
    rt.phase = "countdown";
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledTimes(2);
  });
});
