// Picks the host adapter. Release packages fix it at build time: `VITE_PLATFORM` and
// `VITE_PLATFORM_ADS` come from deploy/release.json via scripts/lib/package-game.mjs, the
// comparisons below fold to one branch, and dead-code elimination drops the other adapters
// (the packager's per-target forbidden strings check that it did).
// In dev: `?platform=web|wavedash|crazygames`, else Wavedash when its SDK is injected, else
// web. `?platform=crazygames` on localhost runs the CrazyGames SDK in its "local" mode
// (placeholder ads with `&ads`).
import { GAME } from "../config";
import type { Platform, PlatformId } from "./types";
import { createWebPlatform } from "./web";
import { createWavedashPlatform, type WavedashOptions } from "./wavedash";
import { createCrazyGamesPlatform } from "./crazygames";

export type {
  AdHooks, AdKind, AdResult, BoardDef, BoardDisplay, BoardEntry, BoardSort, LeaderboardService, PaidContentService, Platform, PlatformId, SaveStore, StatsService,
  SubmitResult, LobbyChatMessage, LobbyCreateOptions, LobbyFindOptions, LobbyInvite, LobbyMember, LobbyService, LobbyState, LobbySummary, LobbyValue,
  LobbyVisibility, P2PMessage, P2PPeerEvent, P2PSendOptions, P2PService,
} from "./types";
export type { WavedashOptions } from "./wavedash";
export { LOBBY_MESSAGE_MAX } from "./wavedash-lobbies";
export { STORAGE_PREFIX, isGameKey, storageKey } from "./storage-key";

const FIXED = import.meta.env.VITE_PLATFORM as PlatformId | undefined;

/**
 * Host services the active game opts into on Wavedash, from its game.json `platform.wavedash` (validated at build time); both off unless set.
 * Lobbies themselves need no opt-in: nothing happens on the host until the game calls `platform.lobbies`.
 */
const WAVEDASH: WavedashOptions = GAME.platform?.wavedash ?? {};

function devTarget(): PlatformId {
  const asked = new URLSearchParams(globalThis.location?.search ?? "").get("platform");
  if (asked === "web" || asked === "wavedash" || asked === "crazygames") return asked;
  return (globalThis as { Wavedash?: unknown }).Wavedash ? "wavedash" : "web";
}

function create(id: PlatformId, ads: boolean): Platform {
  if (id === "crazygames") return createCrazyGamesPlatform({ ads });
  if (id === "wavedash") return createWavedashPlatform(undefined, WAVEDASH);
  return createWebPlatform();
}

/** The one host adapter for this page. Await `platform.init()` before reading any save. */
export const platform: Platform =
  FIXED === "crazygames" ? createCrazyGamesPlatform({ ads: import.meta.env.VITE_PLATFORM_ADS === "1" })
  : FIXED === "wavedash" ? createWavedashPlatform(undefined, WAVEDASH)
  : FIXED === "web" ? createWebPlatform()
  : create(devTarget(), new URLSearchParams(globalThis.location?.search ?? "").has("ads"));
