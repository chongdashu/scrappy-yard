// Your own site and local dev: no host SDK, no ads, saves in localStorage, the game's
// own fullscreen button allowed. The Wavedash adapter starts from this one.
import type { Platform, PlatformId, SaveStore } from "./types";

export function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // private mode or blocked storage
  }
}

async function toggleFullscreen(): Promise<boolean> {
  const doc = globalThis.document;
  if (!doc) return false;
  try {
    if (doc.fullscreenElement) await doc.exitFullscreen();
    else await doc.documentElement.requestFullscreen?.({ navigationUI: "hide" });
    return true;
  } catch {
    return false; // refused (no gesture, iframe without allowfullscreen) or unsupported
  }
}

export function createWebPlatform(id: PlatformId = "web"): Platform {
  const storage: SaveStore | null = localStore();
  return {
    id,
    ownAnalytics: true,
    init: async () => {},
    loading: () => {},
    ready: () => {},
    failed: () => {},
    gameplayStart: () => {},
    gameplayStop: () => {},
    celebrate: () => {},
    storage,
    hostMuted: false,
    onHostMute: () => {},
    ownFullscreen: typeof document !== "undefined" && !!document.fullscreenEnabled,
    toggleFullscreen,
    canShowAd: () => false,
    showAd: async () => "unavailable",
  };
}
