// Wavedash's stats and achievements, leaderboards and Paid Content, behind the Platform interface (types.ts). Built on the shapes in
// wavedash-sdk.ts and tested against tests/lib/fake-wavedash.mjs, which reproduces the behaviour that matters:
//  - setStat / setAchievement answer false and DROP the write until requestStats has loaded (and for ids the project does not define), so writes
//    are queued and retried here (every 2 s, 15 times), and the caller can call them freely;
//  - optional keepHighest merges lifetime totals/records without lowering them; ordinary stats accept absolute updates;
//  - every leaderboard call but get/getOrCreate takes the ID, so names are resolved once and cached (a failed lookup is forgotten);
//  - metadata over the limits rejects the WHOLE score, so it is clamped before sending;
//  - a locked file answers 403 until the content is owned, and EntitlementsGranted fires for every grant, whoever started it.
// Contract: https://docs.wavedash.com/sdk/achievements, /leaderboards, /paid-content
import type { BoardDef, BoardEntry, LeaderboardService, PaidContentService, StatsService, SubmitResult } from "./types";
import type { Upserted, WavedashEntry, WavedashSdk } from "./wavedash-sdk";

/** How often a write the host has not taken yet is tried again, and how many times before giving up until the next write. */
export const RETRY_MS = 2000;
export const RETRIES = 15;

const SORT = { asc: 0, desc: 1 } as const;
const DISPLAY = { numeric: 0, seconds: 1, milliseconds: 2 } as const;

/** Wavedash's metadata limits (16 keys, 64-character keys, 256-character strings, 2048 bytes of JSON); strings are kept shorter than the limit. */
const META_KEYS = 16;
const META_KEY_CHARS = 64;
const META_STRING_CHARS = 128;
const META_BYTES = 2048;

/** Flat key/value context that is safe to send: only strings, finite numbers and booleans, clipped to the limits (the score is worth more than any of it). */
export function clampMeta(meta: Record<string, unknown> | undefined): Record<string, string | number | boolean> | undefined {
  if (!meta) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (Object.keys(out).length >= META_KEYS) break;
    if (!key || key.length > META_KEY_CHARS) continue;
    if (typeof value === "string") out[key] = value.slice(0, META_STRING_CHARS);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  let keys = Object.keys(out);
  while (keys.length && new TextEncoder().encode(JSON.stringify(out)).length > META_BYTES) delete out[keys.pop()!];
  keys = Object.keys(out);
  return keys.length ? out : undefined;
}

export interface WavedashServices {
  stats: StatsService;
  boards: LeaderboardService;
  paid: PaidContentService;
  /** Connect the pieces that need the SDK's events; call once the SDK has been resolved. Safe to call again. */
  attach(): void;
}

/** `getSdk` is read at use time (the SDK arrives during `init()`); `timers` lets a test drive the retries. */
export function createWavedashServices(
  getSdk: () => WavedashSdk | null,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void } = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as never) },
): WavedashServices {
  // ------------------------------------------------------------ stats and achievements
  let loaded = false;
  let loading: Promise<boolean> | null = null;
  const pendingStats = new Map<string, { value: number; keepHighest: boolean }>();
  const pendingUnlocks = new Set<string>();
  const accepted = new Set<string>();
  const warned = new Set<string>();
  let attempts = 0;
  let timer: unknown = null;

  const schedule = () => {
    if (timer !== null || (!pendingStats.size && !pendingUnlocks.size)) return;
    if (attempts >= RETRIES) {
      for (const id of [...pendingStats.keys(), ...pendingUnlocks]) {
        if (warned.has(id)) continue;
        warned.add(id);
        console.warn(`[wavedash] "${id}" was not taken by the host (is it defined in this game's Wavedash project?)`);
      }
      return;
    }
    attempts++;
    timer = timers.set(() => {
      timer = null;
      flush();
    }, RETRY_MS);
  };

  const flush = () => {
    const sdk = getSdk();
    if (!sdk) return;
    if (!loaded) {
      void load();
      schedule();
      return;
    }
    for (const [id, pending] of [...pendingStats]) {
      const { value, keepHighest } = pending;
      let known = -Infinity;
      try { const n = sdk.getStat?.(id); if (Number.isFinite(n)) known = Number(n); } catch { /* no known value to merge */ }
      try {
        if (sdk.setStat?.(id, keepHighest ? Math.max(value, known) : value, false) === true) pendingStats.delete(id);
      } catch (e) {
        console.warn("[wavedash] setStat failed", e);
      }
    }
    for (const id of [...pendingUnlocks]) {
      try {
        if (sdk.setAchievement?.(id, false) === true) {
          pendingUnlocks.delete(id);
          accepted.add(id);
        }
      } catch (e) {
        console.warn("[wavedash] setAchievement failed", e);
      }
    }
    schedule();
  };

  const load = (): Promise<boolean> => {
    if (loaded) return Promise.resolve(true);
    if (loading) return loading;
    const sdk = getSdk();
    if (!sdk?.requestStats) return Promise.resolve(false);
    const attempt = (async () => {
      try {
        const r = await sdk.requestStats!();
        loaded = !!r && r.success !== false;
      } catch (e) {
        console.warn("[wavedash] requestStats failed", e);
        loaded = false;
      }
      loading = null; // a failed load may be tried again by the next write or retry
      if (loaded) flush();
      return loaded;
    })();
    loading = attempt;
    return attempt;
  };

  const stats: StatsService = {
    load,
    getStat(id) {
      try { return Number(getSdk()?.getStat?.(id)) || 0; } catch { return 0; }
    },
    setStat(id, value, options) {
      if (!getSdk() || !Number.isFinite(value)) return false;
      const previous = pendingStats.get(id);
      const keepHighest = options?.keepHighest ?? false;
      pendingStats.set(id, { value: keepHighest && previous?.keepHighest ? Math.max(value, previous.value) : value, keepHighest });
      attempts = 0;
      warned.delete(id);
      flush();
      return true;
    },
    isUnlocked(id) {
      if (accepted.has(id)) return true;
      try { return getSdk()?.getAchievement?.(id) === true; } catch { return false; }
    },
    unlock(id) {
      if (!getSdk()) return false;
      if (accepted.has(id)) return true;
      pendingUnlocks.add(id);
      attempts = 0;
      warned.delete(id);
      flush();
      return true;
    },
    store() {
      try { getSdk()?.storeStats?.(); } catch (e) { console.warn("[wavedash] storeStats failed", e); }
    },
  };

  // ------------------------------------------------------------ leaderboards
  const ids = new Map<string, Promise<string | null>>();
  /**
   * A board's id, looked up once. A score always uses getOrCreate. A read tries get first; if that fails for ANY reason (the host says "not found", says
   * something else, or throws: the real wording is not known) it falls back to getOrCreate, so a board nobody has scored on yet is an empty list, not an
   * error, and the first player to look creates it (a team member's boards are Visible on the store page, a player's start Hidden). Only when getOrCreate
   * fails too is the host really unavailable. Every failure is logged with the host's own message. A failed lookup is forgotten so the next call tries again.
   */
  const boardId = (board: BoardDef, create: boolean): Promise<string | null> => {
    let p = ids.get(board.name);
    if (!p) {
      p = (async () => {
        const sdk = getSdk();
        if (!sdk) return null;
        const getOrCreate = async () => {
          try {
            const r = await sdk.getOrCreateLeaderboard?.(board.name, SORT[board.sort], DISPLAY[board.display]);
            if (r?.success && r.data?.id) return String(r.data.id);
            console.warn(`[wavedash] getOrCreateLeaderboard("${board.name}") failed:`, r?.message ?? r);
          } catch (e) {
            console.warn(`[wavedash] getOrCreateLeaderboard("${board.name}") threw`, e);
          }
          return null;
        };
        if (create) return getOrCreate();
        try {
          const r = await sdk.getLeaderboard?.(board.name);
          if (r?.success && r.data?.id) return String(r.data.id);
          console.info(`[wavedash] getLeaderboard("${board.name}") said:`, r?.message ?? r, "(creating it)");
        } catch (e) {
          console.info(`[wavedash] getLeaderboard("${board.name}") threw (creating it):`, e);
        }
        return getOrCreate();
      })();
      ids.set(board.name, p);
      void p.then((v) => {
        if (!v) ids.delete(board.name);
      });
    }
    return p;
  };
  const myId = () => {
    try { return getSdk()?.getUserId?.() ?? null; } catch { return null; }
  };
  const toEntry = (e: WavedashEntry, me: string | null): BoardEntry => ({
    rank: Number(e.globalRank) || 0,
    name: e.username || "Player",
    score: Number(e.score) || 0,
    me: !!me && e.userId === me,
    ...(e.metadata ? { meta: e.metadata } : {}),
  });

  const boards: LeaderboardService = {
    async submit(board, score, meta) {
      if (!Number.isFinite(score)) return null;
      const id = await boardId(board, true);
      const sdk = getSdk();
      if (!id || !sdk?.uploadLeaderboardScore) return null;
      try {
        const r = await sdk.uploadLeaderboardScore(id, Math.round(score), true, undefined, clampMeta(meta));
        const d = r?.success ? (r.data as Upserted | undefined) : undefined;
        if (!d) {
          console.warn(`[wavedash] uploadLeaderboardScore("${board.name}") failed:`, r?.message ?? r);
          return null;
        }
        const result: SubmitResult = { rank: Number(d.globalRank) || 0, best: d.scoreChanged !== false, runRank: Number(d.submittedRank) || Number(d.globalRank) || 0 };
        return result;
      } catch (e) {
        console.warn("[wavedash] uploadLeaderboardScore failed", e);
        return null;
      }
    },
    async top(board, count) {
      const id = await boardId(board, false);
      const sdk = getSdk();
      if (!id || !sdk?.listLeaderboardEntries) return null;
      try {
        const r = await sdk.listLeaderboardEntries(id, 0, Math.max(1, Math.floor(count)), false);
        if (!r?.success || !Array.isArray(r.data)) {
          console.warn(`[wavedash] listLeaderboardEntries("${board.name}") failed:`, r?.message ?? r);
          return null;
        }
        const me = myId();
        return r.data.map((e) => toEntry(e, me));
      } catch (e) {
        console.warn("[wavedash] listLeaderboardEntries failed", e);
        return null;
      }
    },
    async around(board, ahead, behind) {
      const id = await boardId(board, false);
      const sdk = getSdk();
      if (!id || !sdk?.listLeaderboardEntriesAroundUser) return null;
      try {
        const r = await sdk.listLeaderboardEntriesAroundUser(id, Math.max(0, Math.floor(ahead)), Math.max(0, Math.floor(behind)), false);
        if (!r?.success) console.warn(`[wavedash] listLeaderboardEntriesAroundUser("${board.name}") failed:`, r?.message ?? r);
        if (!r?.success || !Array.isArray(r.data) || !r.data.length) return null;
        const me = myId();
        return r.data.map((e) => toEntry(e, me));
      } catch (e) {
        console.warn("[wavedash] listLeaderboardEntriesAroundUser failed", e);
        return null;
      }
    },
  };

  // ------------------------------------------------------------ paid content
  let owned = new Set<string>();
  const listeners = new Set<(ids: readonly string[]) => void>();
  let attached: WavedashSdk | null = null;

  const paid: PaidContentService = {
    async refresh() {
      const sdk = getSdk();
      if (!sdk?.getEntitlements) return null;
      try {
        const r = await sdk.getEntitlements();
        if (!r?.success || !Array.isArray(r.data)) return null;
        owned = new Set(r.data.map(String));
        return owned;
      } catch (e) {
        console.warn("[wavedash] getEntitlements failed", e);
        return null;
      }
    },
    owns: (id) => owned.has(id),
    async purchase(id) {
      const sdk = getSdk();
      if (!sdk?.triggerPaywall) return false;
      if (owned.has(id)) return true;
      try {
        const r = await sdk.triggerPaywall(id);
        // The result is for flow control only; ownership is what the host says after it (the grant event has usually updated it already).
        if (r?.success && r.data) owned.add(id);
      } catch (e) {
        console.warn("[wavedash] triggerPaywall failed", e);
      }
      await paid.refresh();
      return owned.has(id);
    },
    onGranted(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };

  const attach = () => {
    const sdk = getSdk();
    if (!sdk || attached === sdk || !sdk.on) return;
    attached = sdk;
    try {
      sdk.on<{ contentIdentifiers?: string[] } | undefined>(sdk.Events?.ENTITLEMENTS_GRANTED ?? "EntitlementsGranted", (payload) => {
        const granted = (payload?.contentIdentifiers ?? []).map(String);
        if (!granted.length) return;
        granted.forEach((id) => owned.add(id));
        listeners.forEach((fn) => {
          try { fn(granted); } catch (e) { console.warn("[wavedash] a grant listener failed", e); }
        });
      });
    } catch (e) {
      console.warn("[wavedash] could not listen for entitlement grants", e);
    }
  };

  return { stats, boards, paid, attach };
}
