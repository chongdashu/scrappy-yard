// CrazyGames (HTML5 SDK v3, https://docs.crazygames.com/sdk/intro/). The SDK script is
// loaded here rather than from index.html, so only CrazyGames builds fetch it.
// `SDK.environment` is "crazygames" on their site, "local" on localhost (placeholder ads,
// sample data) and "disabled" anywhere else, where every SDK call throws; the adapter then
// stays inert.
//
// Rules this adapter carries: first-party analytics and the game's own fullscreen button are
// off (CrazyGames prohibits custom fullscreen buttons, and the release check forbids the
// Fullscreen API in this build); saves go to the Data module (select it in the submission
// form) with a localStorage fallback; the host's mute setting wins; ads only through the
// SDK, only in builds made with ads on (Basic Launch disables them), and any "no ads for
// this visit" error hides offers for the rest of the visit, so there is never a dead button.
import type { AdHooks, AdKind, AdResult, Platform, SaveStore } from "./types";
import { localStore } from "./web";

export const SDK_URL = "https://sdk.crazygames.com/crazygames-sdk-v3.js";

interface AdCallbacks {
  adStarted?: () => void;
  adFinished?: () => void;
  adError?: (error: { code?: string; message?: string }) => void;
}
interface CrazyGamesSdk {
  init(): Promise<void>;
  environment: "local" | "crazygames" | "disabled";
  game: {
    gameplayStart(): void;
    gameplayStop(): void;
    loadingStart(): void;
    loadingStop(): void;
    happytime(): void;
    reportGameCompletedPercentage?(percent: number): void;
    settings?: { muteAudio?: boolean };
    addSettingsChangeListener?(listener: (settings: { muteAudio?: boolean }) => void): void;
  };
  ad: { requestAd(kind: AdKind, callbacks: AdCallbacks): void; hasAdblock?(): Promise<boolean> };
  data?: SaveStore;
}
type Host = { CrazyGames?: { SDK?: CrazyGamesSdk }; document?: Document };

export interface CrazyGamesOptions {
  /** Offer ads (builds for Full Launch only). */
  ads: boolean;
  host?: Host;
  /** Load the SDK script when it isn't on the page yet (tests pass false). */
  loadScript?: boolean;
}

/** Ad errors that mean "no ad for now, carry on" rather than a fault. */
const QUIET = new Set(["unfilled", "adCooldown", "adblock", "adsDisabledBasicLaunch"]);
/** Ad errors that switch offers off for the rest of the visit. */
const STOP = new Set(["adblock", "adsDisabledBasicLaunch"]);
const AD_TIMEOUT_MS = 90_000;
const SCRIPT_TIMEOUT_MS = 10_000;

function loadSdkScript(doc: Document): Promise<void> {
  return new Promise((resolve) => {
    const s = doc.createElement("script");
    s.src = SDK_URL;
    s.async = true;
    const done = () => resolve();
    s.onload = done;
    s.onerror = done; // blocked or offline: the adapter stays inert
    setTimeout(done, SCRIPT_TIMEOUT_MS);
    doc.head.appendChild(s);
  });
}

/** The Data module, falling back to this browser's localStorage when it's disabled or failing. */
function dataStore(data: SaveStore, local: SaveStore | null): SaveStore {
  return {
    getItem(key) {
      try {
        return data.getItem(key) ?? local?.getItem(key) ?? null;
      } catch {
        return local?.getItem(key) ?? null;
      }
    },
    setItem(key, value) {
      try {
        data.setItem(key, value);
      } catch (e) {
        console.warn("[crazygames] data save failed; using localStorage", e);
        local?.setItem(key, value);
      }
    },
  };
}

export function createCrazyGamesPlatform(opts: CrazyGamesOptions): Platform {
  const host: Host = opts.host ?? (globalThis as never);
  let sdk: CrazyGamesSdk | null = null;
  let playing = false;
  let adsOff = !opts.ads;
  let muted = false;
  let progress = -1;
  let store: SaveStore | null = localStore();
  const muteListeners: ((m: boolean) => void)[] = [];
  const call = (what: string, fn: (s: CrazyGamesSdk) => void) => {
    if (!sdk) return;
    try {
      fn(sdk);
    } catch (e) {
      console.warn(`[crazygames] ${what} failed`, e);
    }
  };

  return {
    id: "crazygames",
    ownAnalytics: false,
    ownFullscreen: false,
    toggleFullscreen: async () => false,
    async init() {
      try {
        if (!host.CrazyGames?.SDK && opts.loadScript !== false && host.document) await loadSdkScript(host.document);
        const candidate = host.CrazyGames?.SDK;
        if (!candidate) return;
        await candidate.init();
        if (candidate.environment === "disabled") return;
        sdk = candidate;
        call("loadingStart", (s) => s.game.loadingStart());
        muted = !!sdk.game.settings?.muteAudio;
        call("settings listener", (s) =>
          s.game.addSettingsChangeListener?.((settings) => {
            muted = !!settings.muteAudio;
            for (const l of muteListeners) l(muted);
          }),
        );
        if (sdk.data) store = dataStore(sdk.data, localStore());
        if (!adsOff && sdk.ad.hasAdblock && (await sdk.ad.hasAdblock().catch(() => false))) adsOff = true;
      } catch (e) {
        console.warn("[crazygames] SDK unavailable", e);
        sdk = null;
      }
    },
    loading: () => {},
    ready: () => call("loadingStop", (s) => s.game.loadingStop()),
    failed: () => call("loadingStop", (s) => s.game.loadingStop()),
    gameplayStart() {
      if (playing) return;
      playing = true;
      call("gameplayStart", (s) => s.game.gameplayStart());
    },
    gameplayStop() {
      if (!playing) return;
      playing = false;
      call("gameplayStop", (s) => s.game.gameplayStop());
    },
    celebrate: () => call("happytime", (s) => s.game.happytime()),
    /** Whole percent, sent only when it changes (CrazyGames: intermediate progress where possible, 100 only at real completion). */
    reportProgress(percent: number) {
      const pct = Math.round(Math.min(100, Math.max(0, Number(percent) || 0)));
      if (!sdk || pct === progress) return;
      progress = pct;
      call("reportGameCompletedPercentage", (s) => s.game.reportGameCompletedPercentage?.(pct));
    },
    get storage() {
      return store;
    },
    get hostMuted() {
      return muted;
    },
    onHostMute: (listener) => void muteListeners.push(listener),
    canShowAd: () => !!sdk && !adsOff,
    showAd(kind: AdKind, hooks: AdHooks): Promise<AdResult> {
      const s = sdk;
      if (!s || adsOff) return Promise.resolve("unavailable");
      return new Promise((resolve) => {
        let started = false;
        let settled = false;
        const finish = (result: AdResult) => {
          if (settled) return;
          settled = true;
          if (started) hooks.ended();
          resolve(result);
        };
        const timer = setTimeout(() => finish("error"), AD_TIMEOUT_MS);
        try {
          s.ad.requestAd(kind, {
            adStarted: () => {
              started = true;
              hooks.started();
            },
            adFinished: () => {
              clearTimeout(timer);
              finish("done");
            },
            adError: (error) => {
              clearTimeout(timer);
              const code = error?.code ?? "other";
              if (STOP.has(code)) adsOff = true;
              finish(QUIET.has(code) ? "unavailable" : "error");
            },
          });
        } catch (e) {
          clearTimeout(timer);
          console.warn("[crazygames] requestAd failed", e);
          finish("error");
        }
      });
    },
  };
}
