// Every persisted key starts with the active game's `storagePrefix` (its game.json), so games
// sharing an origin (localhost, a portal) never read each other's saves, and hosts that must
// copy saves between origins (Wavedash, src/platform/cloud-save.ts) can find all of them by prefix.
import { GAME } from "../config";

export const STORAGE_PREFIX: string = GAME.storagePrefix;

/**
 * `<prefix>:<name>:v<version>`. Bump the version when the stored shape changes incompatibly
 * instead of loading a stale snapshot; src/save.ts can migrate from older versions.
 */
export function storageKey(name: string, version = 1): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`Invalid storage key name: ${name}`);
  if (!Number.isInteger(version) || version < 1) throw new Error(`Invalid storage key version: ${version}`);
  return `${STORAGE_PREFIX}:${name}:v${version}`;
}

/** True for keys that belong to this game (what the Wavedash cloud save mirrors). */
export const isGameKey = (key: string): boolean => key.startsWith(`${STORAGE_PREFIX}:`);
