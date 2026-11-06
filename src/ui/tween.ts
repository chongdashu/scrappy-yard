// Tweens for game UI: Web Animations for DOM (interruptible — a new
// transition starts from the element's current state), a tiny JS tween for
// numbers/cameras, and a reduced-motion switch that jumps to end states.
//
// Interrupting commits the old tween's current look to inline style, so the next tween starts from it, and takes that
// inline style off again when the next tween ends: afterwards the element's own CSS (a class a game sets) rules again,
// as it would have without the interruption. A tween that no longer shows (a finished pop-in with fill "none") is not
// committed at all. Inline styles a game sets itself are left alone.

export const EASE = {
  outBack: "cubic-bezier(0.2, 1.45, 0.4, 1)",
  outQuint: "cubic-bezier(0.22, 1, 0.36, 1)",
  inQuad: "cubic-bezier(0.5, 0, 0.75, 0)",
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
} as const;

// (No matchMedia outside a browser: Node tests import modules that import this one.)
let reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
export const motion = {
  get reduced() {
    return reduced;
  },
  set reduced(v: boolean) {
    reduced = v;
    document.body.classList.toggle("reduced-motion", v);
  },
};

const running = new WeakMap<Element, Animation[]>();
/** What each tween animates (camelCase property names, as in its keyframes) and its fill. */
const tracked = new WeakMap<Animation, { props: string[]; fill: FillMode }>();
/** Inline style interrupt() wrote on an element and not yet taken off: property → [the inline value before, the value written]. */
const committed = new WeakMap<Element, Map<string, [string, string]>>();
const NOT_A_PROPERTY = new Set(["offset", "easing", "composite"]);

type Inline = Record<string, string | undefined>;
const inlineStyle = (el: Element) => (el as Element & Partial<ElementCSSInlineStyle>).style as unknown as Inline | undefined;

/** Still shapes the element's look: playing, waiting out its delay, or finished but holding its end (fill forwards/both). */
const showing = (a: Animation, fill: FillMode) =>
  a.playState === "running" || a.playState === "paused" || (a.playState === "finished" && (fill === "forwards" || fill === "both"));

/** Cancel an element's UI tweens; one that still shows is committed to inline style first, so the next tween starts from its look. */
function interrupt(el: Element) {
  const style = inlineStyle(el);
  for (const a of running.get(el) ?? []) {
    const t = tracked.get(a);
    if (style && t && showing(a, t.fill)) {
      const before = t.props.map((p) => style[p] ?? "");
      try {
        a.commitStyles();
      } catch { /* element may be display:none */ }
      const log = committed.get(el) ?? new Map<string, [string, string]>();
      t.props.forEach((p, i) => {
        const now = style[p] ?? "";
        const entry = log.get(p);
        if (entry) entry[1] = now;
        else if (now !== before[i]) log.set(p, [before[i], now]);
      });
      if (log.size) committed.set(el, log);
    }
    a.cancel();
  }
  running.set(el, []);
}

/** Take off the inline style interrupt() wrote, where nothing else has changed it since. */
function uncommit(el: Element) {
  const log = committed.get(el), style = inlineStyle(el);
  committed.delete(el);
  if (log && style) for (const [p, [before, written]] of log) if ((style[p] ?? "") === written) style[p] = before;
}

export function tween(el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions): Animation {
  interrupt(el);
  const a = el.animate(frames, { fill: "both", ...opts, duration: reduced ? 1 : opts.duration });
  tracked.set(a, { props: [...new Set(frames.flatMap((f) => Object.keys(f).filter((k) => !NOT_A_PROPERTY.has(k))))], fill: opts.fill ?? "both" });
  running.get(el)!.push(a);
  // Done: the committed starting look has served (a fill holds the end state; anything else falls back to the element's CSS).
  a.finished.then(() => running.get(el)?.includes(a) && uncommit(el), () => undefined);
  return a;
}

let gen = 0;
const shownGen = new WeakMap<Element, number>();

/**
 * Show a screen/popup: unhide, then pop in from `from` (null: shown at once). Children with [data-stagger] cascade either way,
 * unless `cascade` is false (a hard cut: everything is there on the first frame).
 */
export function showEl(el: HTMLElement, from: Keyframe | null = { opacity: 0, transform: "translateY(24px) scale(0.94)" }, cascade = true) {
  const g = ++gen;
  shownGen.set(el, g);
  el.hidden = false;
  el.inert = false;
  const shown = { opacity: 1, transform: "none" };
  // (Shown at once is still a tween: it replaces any hide in progress, as the pop-in does.)
  tween(el, [from ?? shown, shown], { duration: from ? 460 : 1, easing: EASE.outBack });
  if (!cascade) {
    // (A cut: a cascade still running from an earlier show must not leave entries half faded in.)
    el.querySelectorAll<HTMLElement>("[data-stagger]").forEach((c) => tween(c, [{ opacity: 1, transform: "none" }, { opacity: 1, transform: "none" }], { duration: 1 }));
    return;
  }
  el.querySelectorAll<HTMLElement>("[data-stagger]").forEach((c, i) => {
    tween(c, [{ opacity: 0, transform: "translateY(18px) scale(0.9)" }, { opacity: 1, transform: "none" }], {
      duration: 420,
      delay: 80 + i * 55,
      easing: EASE.outBack,
    });
  });
}

/** Mark an element as re-shown by custom code, so a pending hideEl() leaves it visible. */
export function claimShown(el: HTMLElement) {
  shownGen.set(el, ++gen);
}

/** Hide: become non-interactive at once, then tween out and set hidden (unless re-shown meanwhile). */
export function hideEl(el: HTMLElement, to: Keyframe = { opacity: 0, transform: "translateY(12px) scale(0.96)" }): Promise<void> {
  if (el.hidden) return Promise.resolve();
  const g = ++gen;
  shownGen.set(el, g);
  el.inert = true;
  const a = tween(el, [{}, to], { duration: 220, easing: EASE.inQuad });
  return a.finished
    .catch(() => undefined)
    .then(() => {
      if (shownGen.get(el) === g) el.hidden = true;
    });
}

/** Squishy press feedback for a button. */
export function squish(el: Element) {
  tween(el, [
    { transform: "scale(1)" },
    { transform: "scale(1.08, 0.88)", offset: 0.25 },
    { transform: "scale(0.96, 1.05)", offset: 0.55 },
    { transform: "scale(1)" },
  ], { duration: 380, easing: "ease-out", fill: "none" });
}

/** Animate a number from a to b (count-up), calling `set` each frame. */
export function countUp(from: number, to: number, ms: number, set: (v: number) => void): Promise<void> {
  if (reduced || ms <= 0) {
    set(to);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      set(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
