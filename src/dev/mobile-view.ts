// DEV-only Mobile view (the "Mobile view" button beside Debug (B) on the dev server): opens
// this page in a phone-sized window beside this one. There the mouse stands in for one finger
// (`Input.emulateTouch`, on from before the game's load(): main.ts passes BootOptions.mobileView),
// the touch buttons and the `body.touch-controls` layout show, and no dev panels do. The window's
// name marks it, so it stays a Mobile view through reloads and the game's own links; `?mobileView`
// makes any window one (an agent's phone-sized browser, a test). A round in play opens the view in
// play too (`?autostart`). Rotate turns it between landscape and portrait.
//
// It is not a phone: no device pixel ratio, safe areas, browser bars, phone GPU or two-finger
// gestures; check those on a device. The view is a second copy of the game with the same saves
// (same origin); an online game gives it a guest identity of its own (`rt.mobileView`).
//
// main.ts imports this module only behind `import.meta.env.DEV`, so release builds contain none of
// it. DEV_MARKER must stay a live string: the release packager fails a bundle containing it.
import type { GameRuntime } from "../runtime";

export const DEV_MARKER = "vgd:dev-only";
/** The view window's name; main.ts checks it at boot (keep the two in step). */
export const MOBILE_VIEW_NAME = "vgd-mobile-view";
/** A phone's CSS viewport (an iPhone 14 or 15), landscape; Rotate swaps the sides. */
export const PHONE = { long: 844, short: 390 };

/** The page the view opens: this one, in play while a round is (`?autostart`), never in capture mode. */
export function viewUrl(href: string, inRound: boolean): string {
  const url = new URL(href);
  url.searchParams.delete("capture");
  url.searchParams.delete("mobileView"); // (the window name marks the view)
  if (inRound) url.searchParams.set("autostart", "");
  else url.searchParams.delete("autostart");
  return url.href;
}

/** The view's viewport size, [width, height]. */
export function viewSize(portrait: boolean): [number, number] {
  return portrait ? [PHONE.short, PHONE.long] : [PHONE.long, PHONE.short];
}

/** `window.open` features: a phone's viewport, at the main window's right edge so the game's left side stays in sight. */
export function viewFeatures(portrait: boolean, main: { screenX: number; screenY: number; outerWidth: number }): string {
  const [w, h] = viewSize(portrait);
  const left = Math.max(0, Math.round(main.screenX + main.outerWidth - w - 24));
  const top = Math.max(0, Math.round(main.screenY + 80));
  return `popup=yes,width=${w},height=${h},left=${left},top=${top},resizable=yes`;
}

const CSS = `
#mobile-view-bar { position: fixed; right: calc(104px + env(safe-area-inset-right, 0px)); bottom: calc(10px + env(safe-area-inset-bottom, 0px)); z-index: 90;
  display: flex; flex-direction: row-reverse; gap: 4px; } /* (in the dev row at the bottom, left of Debug (B); a game's HUD keeps the top) */
#mobile-view-bar button { font: 12px ui-monospace, Menlo, monospace; border: 0; border-radius: 6px; padding: 5px 8px; background: #9fd8ff; color: #111; cursor: pointer; opacity: 0.85; }
#mobile-view-bar button:hover, #mobile-view-bar button:focus-visible { opacity: 1; }
#mobile-view-bar button[aria-pressed="true"] { background: #57b4ff; }
`;

const PORTRAIT = "mobile-view:portrait";
const portrait = () => {
  try {
    return localStorage.getItem(PORTRAIT) === "1";
  } catch {
    return false;
  }
};
const setPortrait = (on: boolean) => {
  try {
    localStorage.setItem(PORTRAIT, on ? "1" : "0");
  } catch {
    /* private mode: the view just opens landscape */
  }
};

export function installMobileView(rt: GameRuntime) {
  // Not in capture mode (its screenshots show the game alone), and not on a touch screen: the dev server opened on a phone is
  // already the real thing.
  if (rt.capture || (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches)) return;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const bar = Object.assign(document.createElement("div"), { id: "mobile-view-bar" });
  const toggle = Object.assign(document.createElement("button"), {
    id: "mobile-view-toggle",
    type: "button",
    title: "Play in a phone-sized window, with the mouse as a finger (dev only)",
  });
  const rotate = Object.assign(document.createElement("button"), {
    id: "mobile-view-rotate",
    type: "button",
    textContent: "Rotate",
    title: "Turn the Mobile view between landscape and portrait",
  });
  bar.dataset.devOnly = toggle.dataset.devOnly = rotate.dataset.devOnly = DEV_MARKER;
  bar.append(toggle, rotate);
  document.body.append(bar);

  let view: Window | null = null;
  let watch = 0;
  /** Show whether the view is open; it can also close itself (its window's close button). */
  const paint = () => {
    if (view?.closed) view = null;
    toggle.setAttribute("aria-pressed", String(!!view));
    toggle.textContent = view ? "Close mobile view" : "Mobile view";
    rotate.hidden = !view;
    if (!view && watch) {
      clearInterval(watch);
      watch = 0;
    }
  };
  paint();
  toggle.addEventListener("click", () => {
    toggle.blur(); // keep game keys (Space) away from the button
    if (view && !view.closed) {
      view.close();
      view = null;
      return paint();
    }
    const inRound = rt.phase === "countdown" || rt.phase === "playing" || rt.phase === "paused";
    // (A view left open by this page before a reload has the same name, so it is reused rather than doubled.)
    view = window.open(viewUrl(location.href, inRound), MOBILE_VIEW_NAME, viewFeatures(portrait(), window));
    if (!view) {
      toggle.textContent = "Allow pop-ups for this page";
      setTimeout(paint, 4000);
      return;
    }
    if (!watch) watch = window.setInterval(paint, 500);
    paint();
  });
  rotate.addEventListener("click", () => {
    rotate.blur();
    if (!view || view.closed) return paint();
    const turn = !portrait();
    setPortrait(turn);
    const [w, h] = viewSize(turn);
    // resizeTo sizes the outside of the window: add its frame to reach the phone's viewport.
    view.resizeTo(w + view.outerWidth - view.innerWidth, h + view.outerHeight - view.innerHeight);
  });
}
