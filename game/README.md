# Your game

This folder is the game the project builds. It starts as a blank game: a calm
scene (a pad, a turning marker cube, four corner posts) whose round starts on
GO and keeps time in the Rust simulation, with no player and no win condition.
It goes through the whole front end (loading, press start, menu, countdown,
pause, settings, back to the menu), so you can replace it piece by piece and
keep something that runs.

```sh
npm run dev      # http://localhost:5173 (T tuning, B debug on the dev server)
npm test         # cargo tests: the engine, this game's crate, every add-on present
npm run test:game
npm run smoke    # the packaged build in muted headless Chrome, with tests/smoke.mjs below
```

The engine (`src/`, `crates/engine/`) knows no game: it reaches this folder
only through the `@game` alias (this `src/index.ts`) and this `game.json`.
[docs/starter.md](../docs/starter.md) explains the engine, the contract and
every command.

## What's here

| Path | What it is | What to do with it |
| --- | --- | --- |
| `game.json` | Identity (`id`, `title`, `storagePrefix`, `version`), the release asset allowlist, the preview model list, optional commands, the smoke driver | Set your own id, title and storage prefix first |
| `crate/` | The Rust simulation (`my-game-sim` on `vgd-engine`): `world.rs` (a round that keeps time), `params.rs` (empty tunables table), `lib.rs` (exports) | Write your rules here, with cargo tests; rename the package |
| `src/index.ts` | The `GameModule` the engine imports: ABI mirror, `create()`, tagline, tips, HUD markup, help, tunables, camera rig | Keep the shape; fill in your content |
| `src/game.ts` | The `Game`: load, input, events, camera shots, drawing, results, stats | Your presentation; each method says what a real game does there |
| `src/sim-abi.ts` | The mirror of `crate/` (version, strides, indices, events, params) | Change it with every Rust ABI change |
| `src/hud.ts`, `src/style.css` | HUD markup (the round clock, the "Your game goes here" note), help, look | Replace with your HUD |
| `public/` | The web root: `favicon.svg`, your `assets/`; `wasm/` is generated | Put runtime files here and list them in `release.assets` |
| `tests/sim.test.ts` | The ABI mirror against the built `sim.wasm` | Grow with your rules |
| `tests/smoke.mjs` | This game's part of `npm run smoke` (checks the HUD and clock) | Rewrite to play your round with real input |

## Make it yours

1. **Name it.** In `game.json` set `id`, `title` and `storagePrefix`; in
   `crate/Cargo.toml` rename the package to match (package names are unique
   across the workspace). Swap `public/favicon.svg`.
2. **Rules.** In `crate/src/world.rs`: state, a fixed `step()`, events, output
   buffers, and a `vgd_engine::interp::DrawnPose` for everything that moves.
   Export level building and input from `crate/src/lib.rs`; add tunables to
   `params.rs`. Mirror all of it in `src/sim-abi.ts` and bump `ABI_VERSION` in
   both.
3. **Presentation.** In `src/game.ts`: load your level and GLBs, map
   `snap.moveX/moveY` through `this.rt.camera.groundBasis()` into your input
   export, turn events into particles, pops and sound (`this.rt.audio`), follow
   your player from `frame()`, frame `menuShot`/`heroShot`, and fill
   `summary()` when your round can be won or lost.
4. **HUD and words.** Replace `src/hud.ts`, `src/style.css`, the tips, tagline
   and help in `src/index.ts`.
5. **Assets.** Runtime files in `public/`, listed in `release.assets`; GLBs in
   `preview.models`; your asset pipeline under `commands` (`assets`,
   `verifyAssets`) so `npm run assets` and `npm run verify:assets` run it.
6. **Tests.** Cargo tests for rules, `tests/*.test.ts` for the TS side, and a
   `tests/smoke.mjs` that plays your round.

## Or start from the demo

The Starter Arena add-on (`addons/starter-arena/`) is a complete game in this
same shape: a skinned GLB runner, pickups, collisions, a timer, results, saves,
a Blender pipeline and a smoke drive that wins. To play it:
`GAME_DIR=addons/starter-arena npm run dev`. To build on it instead of this
blank game, see [addons/README.md](../addons/README.md#start-your-game-from-an-add-on).
