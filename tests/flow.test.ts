// The round flow's start of play with fake screens, runtime and game: the ordinary 3-2-1-GO countdown, and a game
// that skips it (Game.skipCountdown) going straight to playing on Play, Restart round and ?autostart.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/platform", () => ({ platform: { gameplayStart: vi.fn(), gameplayStop: vi.fn(), celebrate: vi.fn() } }));
vi.mock("../src/ui/tween", () => ({ motion: { reduced: false }, tween: vi.fn() }));

import { Flow } from "../src/flow";
import { platform } from "../src/platform";
import type { Game, Phase } from "../src/game";
import type { InputSnapshot } from "../src/input";
import type { FocusPolicy, PauseOnBlur } from "../src/focus";

class El {
  hidden = false;
  textContent = "";
  dataset: Record<string, string> = {};
  listeners = new Map<string, (() => void)[]>();
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click() {
    for (const fn of this.listeners.get("click") ?? []) fn();
  }
}

let els: Map<string, El>;
/** Every phase the flow showed (body[data-phase]), in order. */
let shown: string[];
const el = (sel: string) => {
  if (!els.has(sel)) els.set(sel, new El());
  return els.get(sel)!;
};

beforeEach(() => {
  els = new Map();
  shown = [];
  el("#countdown").hidden = true;
  const page = { addEventListener: () => {}, hidden: false, hasFocus: () => true };
  const dataset = new Proxy({} as Record<string, string>, { set: (t, k, v) => ((t[k as string] = v), k === "phase" && shown.push(v), true) });
  vi.stubGlobal("document", { ...page, querySelector: el, body: { dataset } });
  vi.stubGlobal("window", { ...page, setTimeout, clearTimeout });
  vi.stubGlobal("addEventListener", () => {});
  vi.mocked(platform.gameplayStart).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

const shot = { target: [0, 0, 0] as [number, number, number], pitch: 0.3, yaw: 0, distance: 5 };
const snap = { pressed: new Set<string>() } as unknown as InputSnapshot;

function setup(over: Partial<Game> = {}, pauseOnBlur: PauseOnBlur = "pause") {
  const calls: string[] = [];
  const game = {
    reset: () => calls.push("reset"),
    startRound: () => calls.push("startRound"),
    countdown: (n: number) => calls.push(`countdown ${n}`),
    round: () => "playing",
    showHud: () => {},
    heroShot: () => shot,
    menuShot: () => shot,
    ...over,
  } as unknown as Game;
  const rt = {
    phase: "boot" as Phase,
    paused: false,
    rounds: 0,
    onFrame: null as null | ((dt: number, s: InputSnapshot) => void),
    canvas: { focus: () => {} },
    camera: { shot: null as unknown, shotBlend: 0, gameplayShot: () => shot },
    input: { gameplay: false, clear: () => {}, requestLook: () => {}, onUnlock: null },
    resetRound: () => (rt.rounds++, game.reset()),
    pauseOnBlur,
    inputSuspended: false,
    attached: null as FocusPolicy | null,
    attachFocusPolicy: (f: FocusPolicy) => (rt.attached = f),
  };
  const ui = { closePopup: () => {}, openPopupEl: () => {}, showMenu: vi.fn(), hideMenu: async () => {}, menuOpen: true };
  const flow = new Flow(rt as never, game, ui as never, { toggleMute: () => {} });
  const frame = (dt = 1 / 60) => rt.onFrame!(dt, snap);
  return { flow, rt, ui, calls, frame };
}

describe("start of play", () => {
  it("counts 3-2-1-GO by default, then plays", async () => {
    const { flow, rt, calls, frame } = setup();
    flow.enterMenu();
    await flow.play();
    expect(rt.phase).toBe("countdown");
    expect(rt.input.gameplay).toBe(false);
    for (let i = 0; i < 60 * 3 && rt.phase === "countdown"; i++) frame();
    expect(rt.phase).toBe("playing");
    expect(shown).toEqual(["menu", "countdown", "playing"]);
    expect(calls).toEqual(["reset", "countdown 3", "countdown 2", "countdown 1", "countdown 0", "startRound"]);
    expect(rt.input.gameplay).toBe(true);
    expect(platform.gameplayStart).toHaveBeenCalledTimes(1);
  });

  it("goes straight to playing when the game skips the countdown: no numbers, no intro", async () => {
    const beginIntro = vi.fn(() => true);
    const { flow, rt, calls, frame } = setup({ skipCountdown: () => true, beginIntro });
    flow.enterMenu();
    await flow.play();
    expect(rt.phase).toBe("playing");
    expect(shown).toEqual(["menu", "playing"]);
    expect(calls).toEqual(["reset", "startRound"]);
    expect(beginIntro).not.toHaveBeenCalled();
    expect(rt.input.gameplay).toBe(true);
    expect(rt.camera.shot).toBeNull();
    expect(rt.camera.shotBlend).toBe(0);
    expect(platform.gameplayStart).toHaveBeenCalledTimes(1);
    const cd = el("#countdown");
    expect(cd.hidden).toBe(true);
    frame();
    expect(cd.hidden).toBe(true);
    expect(cd.textContent).toBe("");
  });

  it("skips it again on Restart round and on ?autostart, laying out a new round each time", () => {
    const { flow, rt, calls } = setup({ skipCountdown: () => true });
    flow.autostart();
    expect(rt.phase).toBe("playing");
    expect(rt.rounds).toBe(1);
    flow.pause();
    expect(rt.phase).toBe("paused");
    calls.length = 0;
    el("#pause-restart").click();
    expect(rt.phase).toBe("playing");
    expect(shown).toEqual(["playing", "paused", "playing"]);
    expect(rt.paused).toBe(false);
    expect(rt.rounds).toBe(2);
    expect(calls).toEqual(["reset", "startRound"]);
  });

  it("sets the phase before asking for the hero shot, as v2.2.0 did (a game may frame it by phase)", async () => {
    const seen: Phase[] = [];
    let skip = false;
    const { flow, rt } = setup({ heroShot: () => (seen.push(rt.phase), shot), skipCountdown: () => skip });
    flow.enterMenu();
    await flow.play();
    flow.pause();
    skip = true;
    el("#pause-restart").click();
    expect(seen).toEqual(["countdown", "playing"]);
  });

  it("asks per start, after reset, so one scene can skip and another count down", async () => {
    let skip = true;
    const order: string[] = [];
    const { flow, rt, frame } = setup({
      reset: () => order.push("reset"),
      skipCountdown: () => (order.push("skipCountdown"), skip),
      beginIntro: () => (order.push("beginIntro"), false),
    });
    flow.enterMenu();
    await flow.play();
    expect(rt.phase).toBe("playing");
    flow.pause();
    skip = false;
    el("#pause-restart").click();
    expect(rt.phase).toBe("countdown");
    expect(order).toEqual(["reset", "skipCountdown", "reset", "skipCountdown", "beginIntro"]);
    frame();
    expect(el("#countdown").textContent).toBe("3");
  });
});

describe("into the menu", () => {
  const orbit = (t: number) => ({ target: [t, 0, 0] as [number, number, number], pitch: 0.3, yaw: 0, distance: 5 });

  it("opens the title on the menu's framing, and a cut start carries its camera and clock into the menu", () => {
    const asked: number[] = [];
    const { flow, rt, ui, frame } = setup({ menuShot: (t: number) => (asked.push(t), orbit(t)) });
    expect(asked).toEqual([0]);
    expect((rt.camera.shot as { target: number[] }).target[0]).toBe(0);
    rt.phase = "title";
    for (let i = 0; i < 30; i++) frame(0.02);
    asked.length = 0;
    flow.enterMenu(true);
    expect(rt.phase).toBe("menu");
    expect(asked).toEqual([]); // no snap back to t = 0
    expect(ui.showMenu).toHaveBeenLastCalledWith(false); // no fade: the menu is there at once
    frame(0.02);
    expect(asked[0]).toBeCloseTo(0.62, 6); // the menu clock kept the title's time
  });

  it("starts the menu shot again from t = 0 under the wipe (the default)", () => {
    const asked: number[] = [];
    const { flow, rt, ui, frame } = setup({ menuShot: (t: number) => (asked.push(t), orbit(t)) });
    rt.phase = "title";
    for (let i = 0; i < 30; i++) frame(0.02);
    asked.length = 0;
    flow.enterMenu();
    expect(asked).toEqual([0]);
    expect(ui.showMenu).toHaveBeenLastCalledWith(true);
    frame(0.02);
    expect(asked[1]).toBeCloseTo(0.02, 6);
  });

  it("returnToMenu leaves play for the menu at once, round reset, and refuses where there is nothing to leave", () => {
    const { flow, rt, ui } = setup({ skipCountdown: () => true });
    for (const phase of ["boot", "title", "menu"] as Phase[]) {
      rt.phase = phase;
      expect((rt as unknown as { returnToMenu: () => boolean }).returnToMenu()).toBe(false);
    }
    flow.autostart();
    expect(rt.phase).toBe("playing");
    const rounds = rt.rounds;
    vi.mocked(platform.gameplayStop).mockClear();
    // (The fake shell has no transition(): a wipe here would throw.)
    expect((rt as unknown as { returnToMenu: () => boolean }).returnToMenu()).toBe(true);
    expect(rt.phase).toBe("menu");
    expect(rt.rounds).toBe(rounds + 1);
    expect(rt.input.gameplay).toBe(false);
    expect(platform.gameplayStop).toHaveBeenCalledTimes(1);
    expect(ui.showMenu).toHaveBeenLastCalledWith(true);
  });
});

describe("focus policy hand-over", () => {
  it("starts in the runtime's mode and hands the policy to the runtime, which changes it from then on", () => {
    const { flow, rt } = setup({}, "none");
    expect(flow.focus.mode).toBe("none");
    expect(rt.attached).toBe(flow.focus);
  });

  it("pauses a round on blur only while the mode says so", () => {
    let blur = () => {};
    vi.stubGlobal("window", { addEventListener: (type: string, fn: () => void) => type === "blur" && (blur = fn), setTimeout, clearTimeout });
    const { flow, rt } = setup({ skipCountdown: () => true }, "none");
    flow.autostart();
    blur();
    expect(rt.phase).toBe("playing");
    flow.focus.setMode("pause");
    blur();
    expect(rt.phase).toBe("paused");
  });
});
