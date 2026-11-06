import { describe, expect, it } from "vitest";
import { FocusPolicy, UNLOCK_SETTLE_MS, checkPauseOnBlur, type FocusEnv, type PauseOnBlur } from "../src/focus";

/** A page without a browser: fire blur/focus/visibility and run timers by hand. */
function page() {
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { hidden: false, focused: true, hasFocus: () => doc.focused });
  const timers = new Map<number, () => void>();
  let next = 1;
  const env: FocusEnv = {
    win,
    doc,
    setTimeout: (fn) => (timers.set(next, fn), next++),
    clearTimeout: (id) => timers.delete(id as number),
  };
  const log: string[] = [];
  const make = (mode?: PauseOnBlur) => new FocusPolicy(mode, { pause: () => log.push("pause"), suspendInput: (on) => log.push(on ? "suspend" : "restore") }, env);
  return {
    env, log, make,
    blur: () => ((doc.focused = false), win.dispatchEvent(new Event("blur"))),
    focus: () => ((doc.focused = true), win.dispatchEvent(new Event("focus"))),
    hide: () => ((doc.hidden = true), (doc.focused = false), doc.dispatchEvent(new Event("visibilitychange"))),
    show: () => ((doc.hidden = false), doc.dispatchEvent(new Event("visibilitychange"))),
    runTimers: () => {
      const due = [...timers.values()];
      timers.clear();
      due.forEach((fn) => fn());
    },
    pending: () => timers.size,
  };
}

describe("FocusPolicy (GameModule.pauseOnBlur)", () => {
  it('defaults to "pause": blur, a hidden tab and a lost capture pause at once, as before', () => {
    const t = page();
    const f = t.make();
    expect(f.mode).toBe("pause");
    t.blur();
    t.hide();
    f.unlocked();
    expect(t.log).toEqual(["pause", "pause", "pause"]);
    expect(t.pending()).toBe(0);
    t.show();
    t.focus();
    expect(t.log).toHaveLength(3); // coming back never resumes by itself
  });

  it('"input" withholds input while away and restores it when focus returns, never pausing', () => {
    const t = page();
    const f = t.make("input");
    t.blur();
    expect(f.inputSuspended).toBe(true);
    t.blur(); // a second blur is not a second suspend
    t.focus();
    expect(f.inputSuspended).toBe(false);
    t.hide();
    t.show(); // visible again but not focused yet: still withheld
    expect(f.inputSuspended).toBe(true);
    t.focus();
    expect(t.log).toEqual(["suspend", "restore", "suspend", "restore"]);
  });

  it('"none" ignores focus entirely', () => {
    const t = page();
    t.make("none");
    t.blur();
    t.hide();
    t.show();
    t.focus();
    expect(t.log).toEqual([]);
  });

  it.each(["input", "none"] as const)('"%s": a capture lost while still focused (Esc) pauses after the settle delay', (mode) => {
    const t = page();
    const f = t.make(mode);
    f.unlocked();
    expect(t.log).toEqual([]);
    expect(t.pending()).toBe(1);
    t.runTimers();
    expect(t.log).toEqual(["pause"]);
    expect(UNLOCK_SETTLE_MS).toBeGreaterThan(0);
  });

  it('"input": a capture lost to alt-tab (blur follows the release) withholds input instead of pausing', () => {
    const t = page();
    const f = t.make("input");
    f.unlocked();
    t.blur();
    t.runTimers();
    expect(t.log).toEqual(["suspend"]);
    expect(f.inputSuspended).toBe(true);
  });

  it('"input": a release that arrives after the blur applies the policy at once', () => {
    const t = page();
    const f = t.make("input");
    t.blur();
    f.unlocked();
    expect(t.pending()).toBe(0);
    expect(t.log).toEqual(["suspend"]);
  });

  it("changes mode mid-game (setMode): the next focus change follows the new mode", () => {
    const t = page();
    const f = t.make("none");
    t.blur();
    expect(t.log).toEqual([]);
    t.focus();
    f.setMode("pause");
    expect(f.mode).toBe("pause");
    t.blur();
    expect(t.log).toEqual(["pause"]);
    t.focus();
    f.setMode("input");
    t.blur();
    expect(t.log).toEqual(["pause", "suspend"]);
  });

  it('leaving "input" while input is withheld hands it back at once, and nothing else happens until the next change', () => {
    const t = page();
    const f = t.make("input");
    t.blur();
    expect(f.inputSuspended).toBe(true);
    f.setMode("pause"); // still away: no retroactive pause
    expect(f.inputSuspended).toBe(false);
    expect(t.log).toEqual(["suspend", "restore"]);
    t.focus();
    expect(t.log).toEqual(["suspend", "restore"]); // nothing withheld, nothing to restore
    f.unlocked(); // Esc out of the capture under "pause": at once
    expect(t.log).toEqual(["suspend", "restore", "pause"]);
  });

  it("refuses an unknown mode change and keeps the current one", () => {
    const t = page();
    const f = t.make("input");
    expect(() => f.setMode("full" as PauseOnBlur)).toThrow(/pauseOnBlur mode must be "pause", "input" or "none"/);
    expect(f.mode).toBe("input");
  });

  it("rejects an unknown mode, naming the field", () => {
    expect(checkPauseOnBlur(undefined)).toBe("pause");
    expect(() => checkPauseOnBlur("full")).toThrow(/GameModule\.pauseOnBlur/);
  });
});
