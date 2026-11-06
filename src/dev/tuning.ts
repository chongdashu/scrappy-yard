// DEV-only live tuning panel (T or ` on the dev server): sliders built from
// the game's params table (GameModule.params, mirroring its Rust `params!`,
// applied live through sim_param_set), the renderer's STYLE_RANGES and colour
// pickers for STYLE_COLORS. Values that differ from the game's defaults persist
// per browser under a versioned key, stamped with a hash of those defaults: when
// the game's declared defaults change (a new lighting pass, a retuned rule),
// stale overrides are dropped instead of silently re-applied. A badge says how
// many overrides are active and resets them. "Copy JSON" exports every value
// for pasting into defaults.
//
// main.ts imports this module only behind `import.meta.env.DEV`, so release
// builds contain none of it. DEV_MARKER must stay a live string: the release
// packager fails any bundle that contains it.
import type { ParamDef } from "../game";
import { DEFAULT_STYLE, STYLE_COLORS, STYLE_RANGES, type Style, type StyleColor } from "../gpu/renderer";
import { VersionedSave } from "../save";
import type { Sim } from "../wasm";

export const DEV_MARKER = "vgd:dev-only";

interface Saved {
  /** tuningBasis() of the defaults these overrides were made against. */
  basis: string;
  sim: Record<string, number>;
  style: Partial<Style>;
}

/** Saved values are rounded like this, and count as overrides only when they differ from the default after rounding. */
const round = (v: number) => +v.toFixed(4);

/** A short, stable hash (FNV-1a) of the declared defaults: the game's style and its sim params' defaults. */
export function tuningBasis(style: Readonly<Record<string, number | readonly number[]>>, simDefaults: Readonly<Record<string, number>>): string {
  const value = (v: number | readonly number[]) => (typeof v === "number" ? round(v) : v.map(round)); // colours hash per channel
  const text = JSON.stringify([Object.entries(style).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, value(v)]), Object.entries(simDefaults).sort(([a], [b]) => +a - +b).map(([k, v]) => [k, round(v)])]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** Values in `now` that differ from `defaults` (rounded): what is worth saving. */
export function overrides(now: Readonly<Record<string, number>>, defaults: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(now).filter(([k, v]) => typeof defaults[k] === "number" && round(v) !== round(defaults[k])).map(([k, v]) => [k, round(v)]));
}

const CSS = `
#tuning { position: fixed; left: calc(10px + env(safe-area-inset-left, 0px)); top: 64px; bottom: 10px; z-index: 80; width: min(300px, calc(100vw - 20px));
  overflow: auto; background: rgb(18 20 30 / 0.92); color: #e8ecf4; border: 1px solid rgb(255 255 255 / 0.18); border-radius: 12px;
  padding: 8px 10px 10px; font: 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; touch-action: pan-y; }
#tuning h4 { margin: 10px 0 4px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #9fb4ff; }
#tuning .tune-row { display: grid; grid-template-columns: 1fr 100px 44px; gap: 6px; align-items: center; margin: 3px 0; }
#tuning input[type=range] { width: 100%; }
#tuning input[type=color] { width: 100%; height: 20px; padding: 0; border: 0; background: none; }
#tuning output { text-align: right; font-variant-numeric: tabular-nums; }
#tuning .tune-actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
#tuning button, #tune-toggle { font: 12px ui-monospace, Menlo, monospace; border: 0; border-radius: 6px; padding: 5px 8px; cursor: pointer; background: #e8ecf4; color: #111; }
#tune-toggle { position: fixed; left: calc(10px + env(safe-area-inset-left, 0px)); bottom: calc(10px + env(safe-area-inset-bottom, 0px)); z-index: 81; opacity: 0.8; }
#tune-badge { position: fixed; left: calc(94px + env(safe-area-inset-left, 0px)); bottom: calc(10px + env(safe-area-inset-bottom, 0px)); z-index: 81;
  font: 12px ui-monospace, Menlo, monospace; border: 0; border-radius: 6px; padding: 5px 8px; cursor: pointer; background: #ffcf5a; color: #111; }
`;

export function installTuning(sim: Sim, params: ParamDef[], style: Style, changed: () => void, defaults: Style = DEFAULT_STYLE) {
  const styleDefaults = (): Record<string, number> => Object.fromEntries(STYLE_RANGES.map(([k]) => [k, defaults[k]]));
  // Colours enter the basis too, so a changed default colour drops stale overrides as well.
  const colorDefaults = (): Record<string, readonly number[]> => Object.fromEntries(STYLE_COLORS.map(([k]) => [k, defaults[k]]));
  const simDefaults = (): Record<string, number> => Object.fromEntries(params.map(([id]) => [String(id), sim.x.sim_param_default(id)]));
  const basis = tuningBasis({ ...styleDefaults(), ...colorDefaults() }, simDefaults());
  // v2: only overrides are saved, with the basis they were made against (v1 saved every value, so any touched
  // slider pinned all of them, and is not carried over).
  const save = new VersionedSave<Saved>({
    name: "dev-tuning",
    version: 2,
    fresh: () => ({ basis, sim: {}, style: {} }),
    sanitize: (raw, fresh) => {
      const r = (raw ?? {}) as Partial<Saved>;
      const entries = (o: unknown) => Object.entries((o && typeof o === "object" ? o : {}) as Record<string, unknown>);
      const nums = (o: unknown) => Object.fromEntries(entries(o).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Record<string, number>;
      // Style also keeps colours: three finite numbers 0..1.
      const color = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === "number" && c >= 0 && c <= 1);
      const style = Object.fromEntries(entries(r.style).filter(([, v]) => (typeof v === "number" && Number.isFinite(v)) || color(v)));
      return { basis: typeof r.basis === "string" ? r.basis : fresh.basis, sim: nums(r.sim), style: style as Partial<Style> };
    },
  });
  const count = () => Object.keys(save.data.sim).length + Object.keys(save.data.style).length;
  if (save.data.basis !== basis) {
    // The game's defaults changed since these were saved: re-applying them would quietly undo that change.
    const n = count();
    if (n) console.info(`[tuning] dropped ${n} saved override${n === 1 ? "" : "s"}: the game's style or param defaults changed since they were saved`);
    save.reset();
  }
  // Apply what an earlier visit saved.
  for (const [id] of params) {
    const v = save.data.sim[id];
    if (typeof v === "number") sim.x.sim_param_set(id, v);
  }
  for (const [k] of STYLE_RANGES) {
    const v = save.data.style[k];
    if (typeof v === "number") style[k] = v;
  }
  for (const [k] of STYLE_COLORS) {
    const v = save.data.style[k];
    if (Array.isArray(v)) style[k] = [v[0], v[1], v[2]];
  }
  changed();

  const el = document.createElement("style");
  el.textContent = CSS;
  document.head.appendChild(el);
  const panel = document.createElement("aside");
  panel.id = "tuning";
  panel.hidden = true;
  panel.dataset.devOnly = DEV_MARKER;
  panel.setAttribute("aria-label", "Tuning (dev only)");
  const toggle = Object.assign(document.createElement("button"), { id: "tune-toggle", textContent: "Tune (T)", title: "Tuning panel (dev only)" });
  toggle.dataset.devOnly = DEV_MARKER;
  // Saved overrides are easy to forget: say how many are on top of the game's defaults, and reset them in one click.
  const badge = Object.assign(document.createElement("button"), { id: "tune-badge", title: "Saved tuning overrides on top of the game's defaults (dev only). Click to reset them." });
  badge.dataset.devOnly = DEV_MARKER;
  document.body.append(panel, toggle, badge);
  const paintBadge = () => {
    const n = count();
    badge.hidden = n === 0;
    badge.textContent = `${n} tuning override${n === 1 ? "" : "s"} active · reset`;
  };
  paintBadge();

  const snapshot = (): Omit<Saved, "basis"> => {
    const s: Record<string, number> = {};
    for (const [id] of params) s[id] = +sim.x.sim_param_get(id).toFixed(4);
    const st: Partial<Style> = {};
    for (const [k] of STYLE_RANGES) st[k] = +style[k].toFixed(4);
    for (const [k] of STYLE_COLORS) st[k] = style[k].map((c) => +c.toFixed(4)) as StyleColor;
    return { sim: s, style: st };
  };
  const persist = () => {
    const now = snapshot();
    save.data.basis = basis;
    save.data.sim = overrides(now.sim, simDefaults());
    const styleNow = overrides(now.style as Record<string, number>, styleDefaults()) as Partial<Style>;
    for (const [k] of STYLE_COLORS) {
      const c = now.style[k] as StyleColor;
      if (c.some((v, i) => round(v) !== round(defaults[k][i]))) styleNow[k] = c;
    }
    save.data.style = styleNow;
    save.save();
    paintBadge();
  };
  const resetAll = () => {
    for (const [id] of params) sim.x.sim_param_set(id, sim.x.sim_param_default(id));
    Object.assign(style, defaults);
    // A fresh array: the defaults' colours are shared, never edited in place.
    for (const [k] of STYLE_COLORS) style[k] = [...defaults[k]];
    changed();
    save.reset();
    paintBadge();
    render();
  };

  const render = () => {
    panel.replaceChildren();
    const row = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void) => {
      const r = document.createElement("label");
      r.className = "tune-row";
      const out = document.createElement("output");
      const inp = Object.assign(document.createElement("input"), { type: "range", min: `${min}`, max: `${max}`, step: `${step}`, value: `${get()}` });
      out.textContent = `${+get().toFixed(3)}`;
      inp.addEventListener("input", () => {
        set(+inp.value);
        out.textContent = `${+(+inp.value).toFixed(3)}`;
        persist();
      });
      r.append(Object.assign(document.createElement("span"), { textContent: label }), inp, out);
      panel.appendChild(r);
    };
    const heading = (t: string) => panel.appendChild(Object.assign(document.createElement("h4"), { textContent: t }));
    if (params.length) {
      heading("Rules (Rust sim)");
      for (const [id, label, min, max, step] of params) row(label, min, max, step, () => sim.x.sim_param_get(id), (v) => sim.x.sim_param_set(id, v));
    }
    heading("Look (shaders + post)");
    for (const [k, label, min, max, step] of STYLE_RANGES) {
      row(label, min, max, step, () => style[k], (v) => {
        style[k] = v;
        changed();
      });
    }
    heading("Look colours (sRGB)");
    const hex = (c: StyleColor) => "#" + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
    for (const [k, label] of STYLE_COLORS) {
      const r = document.createElement("label");
      r.className = "tune-row";
      const out = document.createElement("output");
      const inp = Object.assign(document.createElement("input"), { type: "color", value: hex(style[k]) });
      out.textContent = hex(style[k]);
      inp.addEventListener("input", () => {
        // A fresh array: the defaults' colours are shared, never edited in place.
        style[k] = [1, 3, 5].map((i) => parseInt(inp.value.slice(i, i + 2), 16) / 255) as StyleColor;
        out.textContent = inp.value;
        changed();
        persist();
      });
      r.append(Object.assign(document.createElement("span"), { textContent: label }), inp, out);
      panel.appendChild(r);
    }
    const actions = document.createElement("div");
    actions.className = "tune-actions";
    const btn = (t: string, fn: () => void) => {
      const b = Object.assign(document.createElement("button"), { textContent: t });
      b.addEventListener("click", () => {
        fn();
        b.blur(); // keep game keys away from the panel
      });
      actions.appendChild(b);
      return b;
    };
    btn("Defaults", resetAll);
    const copy = btn("Copy JSON", async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(snapshot(), null, 2));
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Clipboard blocked";
      }
      setTimeout(() => (copy.textContent = "Copy JSON"), 1200);
    });
    btn("Close", () => (panel.hidden = true));
    panel.appendChild(actions);
  };
  render();

  const flip = () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) render(); // show live values (a URL option may have set one)
  };
  toggle.addEventListener("click", () => {
    flip();
    toggle.blur();
  });
  badge.addEventListener("click", () => {
    resetAll();
    badge.blur();
  });
  addEventListener("keydown", (e) => {
    if (e.repeat || e.defaultPrevented || e.target instanceof HTMLInputElement) return;
    if (e.code === "KeyT" || e.code === "Backquote") flip();
  });
}
