// The UI tween helper (src/ui/tween.ts) without a browser: it imports in Node (no matchMedia at import), and an
// interrupted tween's committed look is only the next tween's starting point. Web Animations are faked: each fake
// animation's `look` is what commitStyles() would write.
import { describe, expect, it } from "vitest";
import { motion, showEl, squish, tween } from "../src/ui/tween";

class FakeAnimation {
  playState: AnimationPlayState = "running";
  /** What the effect shows right now: commitStyles() writes it inline. */
  look: Record<string, string> = {};
  commits = 0;
  readonly finished: Promise<FakeAnimation>;
  private settle!: [(a: FakeAnimation) => void, (e: Error) => void];
  constructor(private el: FakeElement, readonly frames: Keyframe[], readonly opts: KeyframeAnimationOptions) {
    this.finished = new Promise((res, rej) => (this.settle = [res, rej]));
    this.finished.catch(() => undefined);
  }
  commitStyles() {
    this.commits++;
    Object.assign(this.el.style, this.look);
  }
  cancel() {
    this.playState = "idle";
    this.settle[1](new Error("AbortError"));
  }
  finish() {
    this.playState = "finished";
    this.settle[0](this);
  }
}

class FakeElement {
  style: Record<string, string> = {};
  animations: FakeAnimation[] = [];
  hidden = true;
  inert = true;
  children: FakeElement[] = [];
  querySelectorAll() {
    return this.children;
  }
  animate(frames: Keyframe[], opts: KeyframeAnimationOptions) {
    const a = new FakeAnimation(this, frames, opts);
    this.animations.push(a);
    return a;
  }
}

const settled = () => new Promise((r) => setTimeout(r));
const el = () => new FakeElement();
const asEl = (e: FakeElement) => e as unknown as Element;
const run = (e: FakeElement, frames: Keyframe[], opts: KeyframeAnimationOptions = { duration: 100 }) => tween(asEl(e), frames, opts) as unknown as FakeAnimation;

describe("tween", () => {
  it("imports without a browser (no matchMedia in Node): motion is not reduced", () => {
    expect(typeof (globalThis as { matchMedia?: unknown }).matchMedia).toBe("undefined");
    expect(motion.reduced).toBe(false);
  });

  it("does not commit a finished fill:none tween, so a game's class rules the element afterwards (the press pill)", async () => {
    const pill = el();
    const popIn = run(pill, [{ transform: "scale(0.6)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 420, fill: "none" });
    popIn.look = { transform: "scale(1)", opacity: "1" }; // what commitStyles would copy: the element's own CSS
    popIn.finish();
    await settled();
    squish(asEl(pill));
    expect(popIn.commits).toBe(0);
    expect(pill.style).toEqual({});
  });

  it("commits a tween that still shows, as the next one's start, and takes it off when that one ends", async () => {
    const card = el();
    const fadeIn = run(card, [{ opacity: 0 }, { opacity: 1 }]);
    fadeIn.look = { opacity: "0.46" };
    const fadeOut = run(card, [{}, { opacity: 0 }]); // starts from the committed 0.46
    expect(fadeIn.commits).toBe(1);
    expect(card.style.opacity).toBe("0.46");
    fadeOut.finish();
    await settled();
    expect(card.style.opacity).toBe(""); // the fill holds the end; the element's CSS underneath again
  });

  it("restores what was inline before the first commit, through a chain of interruptions (two quick squishes)", async () => {
    const button = el();
    button.style.transform = "rotate(1deg)"; // set by the game
    const first = run(button, [{ transform: "scale(1)" }, { transform: "scale(1.08, 0.88)" }, { transform: "scale(1)" }], { duration: 380, fill: "none" });
    first.look = { transform: "scale(1.04, 0.93)" };
    const second = run(button, [{ transform: "scale(1)" }, { transform: "scale(1.08, 0.88)" }, { transform: "scale(1)" }], { duration: 380, fill: "none" });
    second.look = { transform: "scale(1.06, 0.9)" };
    const third = run(button, [{ transform: "scale(1)" }, { transform: "scale(1)" }], { duration: 380, fill: "none" });
    expect(button.style.transform).toBe("scale(1.06, 0.9)");
    third.finish();
    await settled();
    expect(button.style.transform).toBe("rotate(1deg)"); // not stuck squished
  });

  it("leaves alone inline style the game changed after the commit", async () => {
    const box = el();
    const a = run(box, [{ opacity: 0, transform: "none" }, { opacity: 1, transform: "none" }]);
    a.look = { opacity: "0.5", transform: "translateY(4px)" };
    const b = run(box, [{}, { opacity: 0 }]);
    box.style.transform = "scale(2)"; // the game's own, after the commit
    b.finish();
    await settled();
    expect(box.style).toEqual({ opacity: "", transform: "scale(2)" });
  });

  it("keeps the committed start while an interrupted chain is still running", async () => {
    const box = el();
    const a = run(box, [{ opacity: 0 }, { opacity: 1 }]);
    a.look = { opacity: "0.3" };
    const b = run(box, [{}, { opacity: 0 }]);
    a.finish(); // an animation that was cancelled never uncommits (its finished promise rejected)
    await settled();
    expect(box.style.opacity).toBe("0.3");
    b.cancel();
    await settled();
    expect(box.style.opacity).toBe("0.3"); // nor does a cancelled one; the next tween's interrupt takes over
  });

  it("showEl with no start keyframe shows the screen at once and still cascades its [data-stagger] children", () => {
    const menu = el(), entries = [el(), el()];
    menu.children = entries;
    showEl(menu as unknown as HTMLElement, null);
    expect([menu.hidden, menu.inert]).toEqual([false, false]);
    expect(menu.animations[0].frames).toEqual([{ opacity: 1, transform: "none" }, { opacity: 1, transform: "none" }]);
    expect(menu.animations[0].opts.duration).toBe(1);
    expect(entries.map((e) => e.animations[0].frames[0].opacity)).toEqual([0, 0]);
    showEl(menu as unknown as HTMLElement); // the default pops in
    expect(menu.animations[1].frames[0]).toEqual({ opacity: 0, transform: "translateY(24px) scale(0.94)" });
  });

  it("showEl with cascade false is a hard cut: its [data-stagger] children are there at once too", () => {
    const menu = el(), entries = [el(), el()];
    menu.children = entries;
    showEl(menu as unknown as HTMLElement, null, false);
    expect(menu.animations[0].opts.duration).toBe(1);
    for (const e of entries) {
      expect(e.animations[0].frames).toEqual([{ opacity: 1, transform: "none" }, { opacity: 1, transform: "none" }]);
      expect(e.animations[0].opts.duration).toBe(1);
    }
  });
});
