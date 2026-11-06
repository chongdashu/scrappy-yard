// DEV-only debug panel (B or the Debug button on the dev server): buttons the
// game registers (src/game.ts DebugAction), e.g. finish the round, add time,
// lose now. Debug outcomes must route through the game's normal paths (the
// sim's own rules), never set a result flag directly.
//
// main.ts imports this module only behind `import.meta.env.DEV`, so release
// builds contain none of it and no key or button can reach it. DEV_MARKER
// must stay a live string: the release packager fails a bundle containing it.
import type { DebugAction } from "../game";

export const DEV_MARKER = "vgd:dev-only";

const CSS = `
#dbg-toggle { position: fixed; right: calc(10px + env(safe-area-inset-right, 0px)); bottom: calc(10px + env(safe-area-inset-bottom, 0px)); z-index: 90;
  font: 12px ui-monospace, Menlo, monospace; border: 0; border-radius: 6px; padding: 5px 8px; background: #ffd24d; color: #111; cursor: pointer; opacity: 0.85; }
#dbg-toggle.left, #dbg.left { right: auto; left: calc(10px + env(safe-area-inset-left, 0px)); }
#dbg-toggle.left { bottom: calc(46px + env(safe-area-inset-bottom, 0px)); }
#dbg { position: fixed; right: calc(10px + env(safe-area-inset-right, 0px)); bottom: 44px; z-index: 90; width: min(300px, calc(100vw - 20px)); max-height: calc(100vh - 70px); overflow-y: auto;
  background: rgb(18 20 30 / 0.94); color: #e8ecf4; border: 1px solid #ffd24d; border-radius: 12px; padding: 8px 10px 10px;
  font: 12px/1.3 ui-monospace, Menlo, monospace; -webkit-user-select: none; user-select: none; }
#dbg .bar { display: flex; align-items: center; gap: 6px; margin: 0 0 4px; }
#dbg h4 { flex: 1; margin: 0; font-size: 11px; color: #ffd24d; letter-spacing: 0.08em; text-transform: uppercase; }
#dbg { opacity: 0.55; transition: opacity 0.15s; }
#dbg:hover, #dbg:focus-within { opacity: 1; }
#dbg h5 { margin: 9px 0 4px; font-size: 10px; color: #9aa4bd; letter-spacing: 0.1em; text-transform: uppercase; cursor: pointer; }
#dbg h5::before { content: "▾ "; }
#dbg h5.folded::before { content: "▸ "; }
#dbg .row { display: flex; flex-wrap: wrap; gap: 5px; }
#dbg button { font: 12px ui-monospace, Menlo, monospace; color: #111; background: #e8ecf4; border: 0; border-radius: 6px; padding: 5px 8px; cursor: pointer; }
#dbg button:hover:not(:disabled) { background: #fff; }
#dbg button.small { background: transparent; color: #ffd24d; padding: 2px 6px; border: 1px solid #ffd24d55; }
#dbg button:disabled { opacity: 0.35; cursor: default; }
#dbg .info { margin-top: 8px; opacity: 0.75; white-space: pre-line; }
`;

const pref = (k: string) => {
  try {
    return localStorage.getItem(`dbg:${k}`);
  } catch {
    return null;
  }
};
const setPref = (k: string, v: string) => {
  try {
    localStorage.setItem(`dbg:${k}`, v);
  } catch {
    /* private mode: the panel just forgets */
  }
};

export function installDebugPanel(actions: () => DebugAction[], info: () => string) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const toggle = Object.assign(document.createElement("button"), { id: "dbg-toggle", textContent: "Debug (B)", title: "Debug panel (dev only)" });
  const panel = document.createElement("aside");
  panel.id = "dbg";
  toggle.dataset.devOnly = panel.dataset.devOnly = DEV_MARKER;
  document.body.append(toggle, panel);
  // Open by default on a screen with room for it (a phone starts folded); it remembers being folded or moved to the left.
  const side = () => {
    const left = pref("side") === "left";
    toggle.classList.toggle("left", left);
    panel.classList.toggle("left", left);
  };
  side();
  panel.hidden = (pref("open") ?? (innerWidth >= 760 ? "1" : "0")) !== "1";

  let buttons: { a: DebugAction; b: HTMLButtonElement }[] = [];
  const infoEl = Object.assign(document.createElement("div"), { className: "info" });
  /** Build the buttons (on open), under their group headings. */
  const build = () => {
    const bar = document.createElement("div");
    bar.className = "bar";
    const move = Object.assign(document.createElement("button"), { textContent: "⇄", className: "small", title: "Move the panel to the other side" });
    move.addEventListener("click", () => {
      setPref("side", pref("side") === "left" ? "right" : "left");
      side();
      move.blur();
    });
    const fold = Object.assign(document.createElement("button"), { textContent: "–", className: "small", title: "Fold the panel (B)" });
    fold.addEventListener("click", () => {
      flip();
      fold.blur();
    });
    bar.append(Object.assign(document.createElement("h4"), { textContent: "Debug · dev server only" }), move, fold);
    const groups = new Map<string, HTMLElement>();
    const rows: HTMLElement[] = [];
    buttons = actions().map((a) => {
      const g = a.group ?? "";
      let row = groups.get(g);
      if (!row) {
        row = document.createElement("div");
        row.className = "row";
        groups.set(g, row);
        if (g) {
          // A heading folds its buttons; remember each game's chosen groups.
          const h = Object.assign(document.createElement("h5"), { textContent: g });
          const foldedNow = pref(`fold:${g}`) === "1";
          h.classList.toggle("folded", foldedNow);
          row.hidden = foldedNow;
          h.addEventListener("click", () => {
            row!.hidden = !row!.hidden;
            h.classList.toggle("folded", row!.hidden);
            setPref(`fold:${g}`, row!.hidden ? "1" : "0");
          });
          rows.push(h);
        }
        rows.push(row);
      }
      const b = Object.assign(document.createElement("button"), { textContent: a.label, title: a.title ?? "" });
      b.addEventListener("click", () => {
        if (b.disabled) return;
        a.run();
        b.blur(); // keep game keys (Space, arrows) away from the panel
        paint();
      });
      row.appendChild(b);
      return { a, b };
    });
    panel.replaceChildren(bar, ...rows, infoEl);
    paint();
  };
  /** Refresh enabled states and the info line without replacing buttons under the pointer. */
  const paint = () => {
    for (const { a, b } of buttons) b.disabled = a.enabled ? !a.enabled() : false;
    infoEl.textContent = info();
  };
  const flip = () => {
    panel.hidden = !panel.hidden;
    setPref("open", panel.hidden ? "0" : "1");
    if (!panel.hidden) build();
  };
  if (!panel.hidden) build();
  toggle.addEventListener("click", () => {
    flip();
    toggle.blur();
  });
  addEventListener("keydown", (e) => {
    if (e.code === "KeyB" && !e.repeat && !e.defaultPrevented && !(e.target instanceof HTMLInputElement)) flip();
  });
  setInterval(() => !panel.hidden && paint(), 500);
}
