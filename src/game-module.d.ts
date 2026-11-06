// `@game` is the active game's entry module, <gameDir>/src/index.ts (the Vite alias from
// scripts/lib/active-game.mjs). The type checker sees only the contract, so the engine
// type-checks the same way whichever game is active; each game's index.ts is checked against
// GameModule on its own (tsconfig.json includes game/src and addons/*/src).
declare module "@game" {
  import type { GameModule } from "@engine/game";
  const game: GameModule;
  export default game;
}
