// Capture-mode render resolution (`?capture`). The renderer caps the canvas at
// `Renderer.maxPixels` device pixels and `maxDpr` (sized for phones), which silently shrinks a
// high-resolution capture: 2560×1440 at DPR 2 came out at about 2149×1209. Capture mode may lift
// the caps, from the URL (`?capture&maxpx=5120x2880&maxdpr=2`) or from a test
// (`__game.pixelBudget({ maxPixels, maxDpr })`); ordinary play keeps the defaults.

export interface PixelBudget {
  /** Canvas pixel budget (device pixels). */
  maxPixels: number;
  /** Largest devicePixelRatio used. */
  maxDpr: number;
}

/** Bounds a capture may ask for: up to 8192² pixels (WebGPU's default texture limit per side) and DPR 0.5–4. */
export const PIXEL_BUDGET_LIMITS = { maxPixels: [1, 8192 * 8192], maxDpr: [0.5, 4] } as const;

const clampTo = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/** `maxpx` as a pixel count (`8294400`) or a size (`3840x2160`); null when absent or not a positive number. */
export function parseMaxPixels(v: string | null): number | null {
  if (v === null) return null;
  const size = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(v);
  const n = size ? Number(size[1]) * Number(size[2]) : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** The overrides a capture URL asks for (`maxpx`, `maxdpr`), clamped; nothing outside `?capture`. */
export function captureBudget(query: URLSearchParams): Partial<PixelBudget> {
  if (!query.has("capture")) return {};
  const out: Partial<PixelBudget> = {};
  const px = parseMaxPixels(query.get("maxpx"));
  if (px !== null) out.maxPixels = clampTo(px, PIXEL_BUDGET_LIMITS.maxPixels);
  const dpr = Number(query.get("maxdpr") ?? NaN);
  if (Number.isFinite(dpr) && dpr > 0) out.maxDpr = clampTo(dpr, PIXEL_BUDGET_LIMITS.maxDpr);
  return out;
}

/** Apply a budget change to the renderer's caps (clamped); returns the caps now in force. */
export function applyBudget(target: PixelBudget, change: Partial<PixelBudget> = {}): PixelBudget {
  if (typeof change.maxPixels === "number" && change.maxPixels > 0) target.maxPixels = Math.round(clampTo(change.maxPixels, PIXEL_BUDGET_LIMITS.maxPixels));
  if (typeof change.maxDpr === "number" && change.maxDpr > 0) target.maxDpr = clampTo(change.maxDpr, PIXEL_BUDGET_LIMITS.maxDpr);
  return { maxPixels: target.maxPixels, maxDpr: target.maxDpr };
}
