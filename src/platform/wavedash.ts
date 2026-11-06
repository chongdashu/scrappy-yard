// Wavedash injects `window.Wavedash` before game code runs on wavedash.com and in
// `wavedash dev`. The npm package `@wvdsh/sdk-js` throws at import time without that
// global, so it is not imported. Wavedash earns through paid content and its creator
// fund, not ads, so this adapter has no ad support; everything else is the web adapter
// plus the host's loading bar and cloud saves, (wavedash-services.ts) its stats and achievements, leaderboards and Paid Content, and
// (wavedash-lobbies.ts) its Lobbies with optional P2P.
// Contract: https://docs.wavedash.com/sdk/setup, /cloud-saves, /achievements, /leaderboards, /paid-content, /multiplayer/lobbies, /multiplayer/networking
//
// Saves: Wavedash serves every build from its own origin, so localStorage starts empty
// after each update. Every game key (storage-key.ts) is mirrored to the player's Wavedash
// cloud storage (cloud-save.ts): restored in init(), before anything reads it, and
// uploaded as it changes.
import { createCloudSave, type CloudFiles } from "./cloud-save";
import { STORAGE_PREFIX, isGameKey } from "./storage-key";
import type { Platform, SaveStore } from "./types";
import type { WavedashSdk } from "./wavedash-sdk";
import { createWavedashServices } from "./wavedash-services";
import { createWavedashLobbies, p2pConfig, type WavedashP2POptions } from "./wavedash-lobbies";
import { createWebPlatform, localStore } from "./web";

/** The save's file in the player's Wavedash cloud storage. */
const SAVE_FILE = "saves/progress.json";
/** How long boot waits for the cloud save before playing from this browser's copy. */
const RESTORE_TIMEOUT_MS = 4000;
/** Host services a game turns on explicitly: its game.json `platform.wavedash`, validated by scripts/lib/active-game.mjs and passed by index.ts. */
export interface WavedashOptions {
  /** Paid content requires the game's own offer/catalog. */
  paidContent?: boolean;
  /**
   * P2P between lobby members: `true` for the SDK's defaults, or the game's message size and queue limits. Off by default: `lobbies.p2p` is then
   * undefined and the SDK's `init()` gets no `p2p` block.
   */
  p2p?: boolean | WavedashP2POptions;
}


/**
 * The save file through Wavedash's Remote Storage. "No save yet" needs two signals (the
 * download fails and the existence check says no); anything else unclear reads as failed,
 * so an existing save is never taken for missing and overwritten.
 */
function wavedashFiles(sdk: () => WavedashSdk | null): CloudFiles {
  return {
    async read() {
      const s = sdk();
      if (!s?.downloadRemoteFile || !s.readLocalFile || !s.remoteFileExists) return undefined;
      try {
        const dl = await s.downloadRemoteFile(SAVE_FILE);
        if (dl?.success) {
          const bytes = (await s.readLocalFile(SAVE_FILE)) ?? (await s.readLocalFile(`/${SAVE_FILE}`));
          return bytes ? new TextDecoder().decode(bytes) : undefined;
        }
        const exists = await s.remoteFileExists(SAVE_FILE);
        return exists?.success && exists.data === false ? null : undefined;
      } catch (e) {
        console.warn("[wavedash] reading the cloud save failed", e);
        return undefined;
      }
    },
    async write(text) {
      const s = sdk();
      if (!s?.writeLocalFile || !s.uploadRemoteFile) return false;
      try {
        if (!(await s.writeLocalFile(SAVE_FILE, new TextEncoder().encode(text)))) return false;
        return !!(await s.uploadRemoteFile(SAVE_FILE))?.success;
      } catch (e) {
        console.warn("[wavedash] uploading the cloud save failed", e);
        return false;
      }
    },
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number(v) || 0));

export function createWavedashPlatform(host: { Wavedash?: unknown } = globalThis as never, opts: WavedashOptions = {}): Platform {
  let sdk: WavedashSdk | null = null;
  let settled = false;
  let progress = 0;
  const call = <K extends keyof WavedashSdk>(name: K, ...args: unknown[]): unknown => {
    const fn = sdk?.[name];
    if (typeof fn !== "function") return undefined;
    try {
      return (fn as (...a: unknown[]) => unknown).apply(sdk, args);
    } catch (e) {
      console.warn(`[wavedash] ${String(name)} failed`, e);
      return undefined;
    }
  };
  const services = createWavedashServices(() => sdk);
  const p2p = opts.p2p ? p2pConfig(opts.p2p) : null;
  const lobbies = createWavedashLobbies(() => sdk, p2p);
  const loading = (value: number) => {
    // The host's loading bar only moves forward.
    progress = Math.max(progress, clamp01(value));
    call("updateLoadProgressZeroToOne", progress);
  };
  const local = localStore();
  const cloud = createCloudSave(wavedashFiles(() => sdk), local, { synced: isGameKey, stampKey: `${STORAGE_PREFIX}.cloud-saved-at` });
  // Saves through platform.storage upload promptly; keys other modules write straight to
  // localStorage are picked up by the cloud save's poll, as long as they carry the prefix.
  const storage: SaveStore | null = local && {
    getItem: (key) => local.getItem(key),
    setItem(key, value) {
      local.setItem(key, value);
      cloud.changed();
    },
  };
  return {
    ...createWebPlatform("wavedash"),
    storage,
    flush: () => cloud.flush(),
    /** The gameplay JWT for the game's own server (Wavedash.getUserJwt), or null: before init(), without the SDK, or when it fails. */
    async userToken() {
      try {
        const r = (await call("getUserJwt")) as Awaited<ReturnType<NonNullable<WavedashSdk["getUserJwt"]>>>;
        return r?.success && typeof r.data === "string" && r.data ? r.data : null;
      } catch (e) {
        console.warn("[wavedash] getUserJwt failed", e);
        return null;
      }
    },
    stats: services.stats,
    boards: services.boards,
    lobbies,
    ...(opts.paidContent ? { paid: services.paid } : {}),
    /** Resolves the injected SDK (a promise-like global is tolerated), then restores the cloud save. */
    async init() {
      try {
        sdk = ((await host.Wavedash) as WavedashSdk | undefined) || null;
      } catch {
        sdk = null;
      }
      services.attach();
      if (!sdk?.downloadRemoteFile) return;
      const result = await cloud.restore(RESTORE_TIMEOUT_MS);
      console.info(`[wavedash] save: ${result}`);
      if (typeof document !== "undefined") {
        const flush = () => void cloud.flush();
        addEventListener("pagehide", flush);
        document.addEventListener("visibilitychange", () => document.hidden && flush());
      }
    },
    loading,
    /** init() reveals the game and ends the host loader; call once the player can interact. */
    ready() {
      if (settled) return;
      settled = true;
      loading(1);
      call("init", p2p ? { debug: false, p2p } : { debug: false });
    },
    /** A boot failure must show the game's own error card, not an endless host loader. */
    failed() {
      if (settled) return;
      settled = true;
      call("loadComplete");
    },
  };
}
