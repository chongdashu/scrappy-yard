// The active game's identity (title, storage prefix, version, preview models) from its
// game.json. scripts/lib/active-game.mjs injects it at build time as the `__GAME__` constant
// (a Vite `define`, also used by the release packager and Vitest), so engine modules that
// need a name or a prefix never import game code.
import type { GameConfig } from "./game";

declare const __GAME__: GameConfig;

export const GAME: GameConfig = __GAME__;
