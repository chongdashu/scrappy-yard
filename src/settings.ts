// Player settings, persisted in a versioned slot (src/save.ts): bump the
// version when the shape changes instead of loading a stale snapshot.
// Reduced motion follows the system preference until the player sets it.
import { VersionedSave } from "./save";

export interface Settings {
  /** Master volume 0..1. */
  volume: number;
  muted: boolean;
  /** Sun cast shadows (off is the low-graphics option). */
  shadows: boolean;
  /** Ink outlines on characters and props. */
  outlines: boolean;
  /** null = follow the system preference. */
  reducedMotion: boolean | null;
}

export const freshSettings = (): Settings => ({ volume: 0.55, muted: false, shadows: true, outlines: true, reducedMotion: null });

/** Parsed JSON → valid Settings (unknown or malformed fields fall back to `fresh`). */
export function sanitizeSettings(raw: unknown, fresh: Settings): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const vol = typeof r.volume === "number" && Number.isFinite(r.volume) ? Math.min(1, Math.max(0, r.volume)) : fresh.volume;
  return {
    volume: vol,
    muted: bool(r.muted, fresh.muted),
    shadows: bool(r.shadows, fresh.shadows),
    outlines: bool(r.outlines, fresh.outlines),
    reducedMotion: typeof r.reducedMotion === "boolean" ? r.reducedMotion : null,
  };
}

export function createSettingsSave() {
  return new VersionedSave<Settings>({ name: "settings", version: 1, fresh: freshSettings, sanitize: sanitizeSettings });
}

/** The effective reduced-motion choice. */
export function reducedMotion(s: Settings): boolean {
  return s.reducedMotion ?? matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Wire the settings popup's controls: `[data-setting=volume]` (range) and
 * `[data-setting=muted|shadows|outlines|reducedMotion]` (aria-pressed toggles).
 * `changed` runs after every edit (apply + save there).
 */
export function bindSettingsUI(root: HTMLElement, get: () => Settings, changed: (s: Settings, key: keyof Settings) => void, click: () => void) {
  const paint = () => {
    const s = get();
    for (const el of root.querySelectorAll<HTMLElement>("[data-setting]")) {
      const key = el.dataset.setting as keyof Settings;
      if (el instanceof HTMLInputElement) {
        el.value = String(s[key]);
        el.style.setProperty("--v", `${Math.round(Number(s[key]) * 100)}%`);
      } else {
        const on = key === "reducedMotion" ? reducedMotion(s) : key === "muted" ? !s.muted : !!s[key];
        el.setAttribute("aria-pressed", String(on));
      }
    }
  };
  for (const el of root.querySelectorAll<HTMLElement>("[data-setting]")) {
    const key = el.dataset.setting as keyof Settings;
    if (el instanceof HTMLInputElement) {
      el.addEventListener("input", () => {
        (get() as unknown as Record<string, unknown>)[key] = Number(el.value);
        paint();
        changed(get(), key);
      });
    } else {
      el.addEventListener("click", () => {
        const s = get();
        if (key === "reducedMotion") s.reducedMotion = !reducedMotion(s);
        else (s as unknown as Record<string, boolean>)[key] = !s[key];
        paint();
        click();
        changed(s, key);
      });
    }
  }
  paint();
  return { paint };
}
