// What losing window focus does to a round (GameModule.pauseOnBlur), kept apart from the
// flow so it can be tested without a page.
//
//   "pause" (default)  blur, a hidden tab or a lost mouse capture pauses the round (the pause card)
//   "input"            the round keeps running; the player's input is withheld (neutral snapshots)
//                      until the window has focus again. For games whose world goes on without the
//                      player: an online round the server keeps simulating, a peer host in a background tab.
//   "none"             the flow ignores focus; only held keys are dropped (Input does that on blur
//                      in every mode, since their key-ups go to another window)
//
// Esc in a pointer-locked round reaches the page only as the lock's release, so in every mode a
// release while the window keeps focus still pauses; under "input" and "none" the flow waits a moment
// (UNLOCK_SETTLE_MS) to tell that apart from alt-tab, which releases the lock and then blurs.
//
// The mode can change mid-game (GameRuntime.setPauseOnBlur → setMode): one scene keeps running, another pauses.

export type PauseOnBlur = "pause" | "input" | "none";

export const UNLOCK_SETTLE_MS = 120;

export interface FocusHooks {
  /** Pause the round (the flow ignores it outside play). */
  pause(): void;
  /** Withhold (true) or restore (false) the player's input while the round keeps running. */
  suspendInput(on: boolean): void;
}

/** The page surface the policy listens to (the real window and document by default). */
export interface FocusEnv {
  win: Pick<EventTarget, "addEventListener">;
  doc: Pick<EventTarget, "addEventListener"> & { readonly hidden: boolean; hasFocus(): boolean };
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const browserEnv = (): FocusEnv => ({
  win: window,
  doc: document,
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id as number),
});

export function checkPauseOnBlur(v: unknown, what = "GameModule.pauseOnBlur"): PauseOnBlur {
  if (v === undefined) return "pause";
  if (v === "pause" || v === "input" || v === "none") return v;
  throw new Error(`${what} must be "pause", "input" or "none" (got ${JSON.stringify(v)})`);
}

export class FocusPolicy {
  private current: PauseOnBlur;
  private suspended = false;
  private settle: unknown = null;

  constructor(mode: PauseOnBlur | undefined, private hooks: FocusHooks, private env: FocusEnv = browserEnv()) {
    this.current = checkPauseOnBlur(mode);
    env.win.addEventListener("blur", () => this.away());
    env.doc.addEventListener("visibilitychange", () => (env.doc.hidden ? this.away() : this.back()));
    env.win.addEventListener("focus", () => this.back());
  }

  get mode(): PauseOnBlur {
    return this.current;
  }

  /**
   * Switch the policy from the next focus change on (a round already paused stays paused; one running while the window is away
   * keeps running until the window comes back and leaves again). Leaving "input" while input is withheld hands it back at once.
   * Throws on an unknown mode.
   */
  setMode(mode: PauseOnBlur) {
    this.current = checkPauseOnBlur(mode, "pauseOnBlur mode");
    if (this.suspended && this.current !== "input") {
      this.suspended = false;
      this.hooks.suspendInput(false);
    }
  }

  /** The window is unfocused or its tab hidden. */
  get isAway(): boolean {
    return this.env.doc.hidden || !this.env.doc.hasFocus();
  }

  /** Input is being withheld ("input" mode, window unfocused). */
  get inputSuspended(): boolean {
    return this.suspended;
  }

  /** The mouse capture was lost in play (Esc, alt-tab). */
  unlocked() {
    if (this.current === "pause") return this.hooks.pause();
    if (this.isAway) return this.away();
    // Still focused: probably Esc (pause), unless a blur follows at once (alt-tab).
    if (this.settle !== null) this.env.clearTimeout(this.settle);
    this.settle = this.env.setTimeout(() => {
      this.settle = null;
      if (this.isAway) this.away();
      else this.hooks.pause();
    }, UNLOCK_SETTLE_MS);
  }

  private away() {
    if (this.current === "pause") this.hooks.pause();
    else if (this.current === "input" && !this.suspended) {
      this.suspended = true;
      this.hooks.suspendInput(true);
    }
  }

  private back() {
    if (!this.suspended || this.isAway) return;
    this.suspended = false;
    this.hooks.suspendInput(false);
  }
}
