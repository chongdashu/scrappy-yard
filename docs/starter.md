# Starter runtime

A runnable, game-neutral starting point: a Rust simulation compiled to
WebAssembly, WebGPU and WebGL 2 renderers in TypeScript, Blender
GLB assets and a Vite build. It comes in three parts:

- **The engine** (`src/`, `crates/engine/`, `index.html`, `preview.html`,
  `scripts/`, `tests/`): the fixed-step sim core and its C ABI, rendering,
  input, the front end (loading, press start, menu, countdown, pause, settings,
  results card), audio, saves, host platforms, DEV panels, release packaging
  and the browser smoke check. It knows no game.
- **Your game** (`game/`): the one game the project builds. The template ships
  a blank one: a calm scene whose round starts and keeps time, with a HUD note
  pointing here. Replace it with your rules and look.
- **Add-ons** (`addons/<name>/`): optional, complete games in the same shape,
  which you can play, copy from or delete. The template ships one,
  **Starter Arena** (`addons/starter-arena/`): steer a runner around a walled
  arena and collect every gem before the timer runs out. It exercises every
  boundary a real game needs: WASM-owned state with a fixed step, events and
  live-tunable params; a skinned GLB character, GLB props (copies of one
  upload) and a GLB level with shadows, bloom and ink; keyboard, mouse, touch and gamepad; the
  whole round flow; saves; and a smoke drive that wins with real input.

Nothing in the engine depends on `addons/`: delete it and everything below
still builds, tests and ships the blank game (verified from a clean export).

```text
src/                    engine TypeScript (reaches the game only through @game)
crates/engine/          vgd-engine: clock, events, math, params!, DrawnPose, the ABI macros
index.html, preview.html  engine pages; title, HUD and help come from the active game
scripts/, tests/        build, package, deploy; engine tests and the smoke harness
game.config.json        { "gameDir": "game" }: which game is active
game/                   your game
  game.json             identity, release allowlist, preview models, commands, smoke driver
  crate/                its Rust simulation (cdylib on vgd-engine)
  src/                  index.ts (a GameModule), its Game, ABI mirror, HUD, CSS
  public/               its web root (favicon, assets/; wasm/ is generated and ignored)
  tests/                its Vitest suites and its smoke driver
  README.md             where to start
addons/
  README.md             what an add-on is; activate, copy, remove, make one
  starter-arena/        the demo: the same shape, plus blender/, art/ and docs/
```

## Quick start

```sh
npm ci                                     # install the pinned toolchain from package-lock.json
npm run dev                                # build the active game's wasm, start Vite on http://localhost:5173
npm run dev:https                          # same over self-signed HTTPS on :5174 (phones on your LAN)
GAME_DIR=addons/starter-arena npm run dev  # play the demo add-on instead
```

WebGPU only exists on secure origins: `localhost` works over HTTP, a LAN or
Tailscale address needs `dev:https` (accept the certificate warning once). The
page detects an insecure origin and says so instead of failing silently.

On the dev server: **T** opens the tuning panel, **B** the debug panel, the
menu has a *Model preview (dev)* entry (`preview.html`), and **Mobile view**
(bottom right) opens the game in a phone-sized window beside the main one,
where the mouse is a finger ([below](#input-flow-and-ui-rules)).

A game that adds local services (a game server, a backend, a watcher) gets one
launcher command, such as `npm run play`, and one plain URL: it builds, starts
or reuses each service and prints `http://localhost:5173/`, with no query
parameters or internal ports for the player to type. Before reusing a running
service, the launcher checks its health and protocol version and restarts it
if they differ; a backend run under a file watcher reloads with shared protocol
changes. In one game the user needed three messages to reach a working local
build, and a backend still running an older protocol hid a feature.

## Commands

Every command works on the active game (below); prefix any of them with
`GAME_DIR=<folder>` to run it on another one.

| Command | What it does |
| --- | --- |
| `npm run wasm` | builds `<gameDir>/crate` with `cargo build --release --target wasm32-unknown-unknown` → `<gameDir>/public/wasm/sim.wasm`; fails if the module gains imports |
| `npm run dev` / `dev:https` | wasm, then Vite (HTTP :5173 / HTTPS :5174, `host: true`); a busy port fails rather than moving to the next one |
| `npm run build` | wasm, `tsc --noEmit` (engine, `game/` and every add-on), `vite build` → `dist/` (game + model preview) |
| `npm run preview` | serve `dist/` with Vite |
| `npm test` | `cargo test --workspace`: the engine, `game/crate` and every add-on crate present |
| `npm run test:game` | wasm, then Vitest: the engine's `tests/*.test.ts` and the active game's `<gameDir>/tests/*.test.ts` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke` | package the web release, serve it under `/builds/<game id>/`, drive both renderers in muted headless Chrome (below) |
| `npm run test:graphics` | package and exercise graphics selection, injected startup failures, RGBA8 fallback, resizing and context loss |
| `npm run assets`, `verify:assets`, `game -- <name>` | the active game's own commands from its `game.json` (e.g. the demo's Blender pipeline); a game without one says so and exits 0 |
| `npm run package:*`, `serve:release`, `deploy:web`, `wavedash:*`, `test:release` | release packaging and hosting: see [release.md](release.md) |

`<gameDir>/public/wasm/` is generated and ignored (`**/public/wasm/`): every
dev, build, package and `test:game` path runs `npm run wasm` first (verified
from a clean export).

## Verified toolchain

These are the versions the starter was built and checked with (2026-09-29):

| Tool | Version | Where it's pinned |
| --- | --- | --- |
| Rust | 1.93.1 + `wasm32-unknown-unknown` | `rust-toolchain.toml` (rustup installs it on first use) |
| Node / npm | 22.20.0 / 10.9.3 | `engines` ≥ 22.4 (Node's built-in WebSocket drives the smoke test) |
| TypeScript | 7.0.2 | `package.json` (exact) |
| Vite | 8.3.0 | 〃 |
| Vitest | 5.0.1 | 〃 |
| @webgpu/types | 0.1.74 | 〃 |
| @vitejs/plugin-basic-ssl | 2.3.0 | 〃 |
| @types/node | 26.6.2 | 〃 |
| Chrome (smoke test) | 154.0.8037.58 | `CHROME_BIN` overrides the path |
| Blender (demo assets) | 5.2.0 | [the demo's asset contract](../addons/starter-arena/docs/demo-assets.md) |

Install with `npm ci`. A fresh `npm install` of these exact versions crashed
npm 10.9.3's resolver here (`Cannot read properties of null (reading
'edgesOut')`, triggered by vitest 5.0.1's peer set); the committed lockfile
installs cleanly.

## The active game

One setting picks the game every tool works on: `gameDir` in
`game.config.json` (`"game"` by default), or the `GAME_DIR` environment variable
for a single command (CI, tests, trying an add-on). `scripts/lib/active-game.mjs`
resolves it and everything derives from it:

| What | From the active game |
| --- | --- |
| Engine → game code | the Vite alias `@game` → `<gameDir>/src/index.ts` (the only way engine code reaches game code) |
| Game → engine code | the alias `@engine/…` → `src/…`, the same from `game/` and `addons/<name>/` |
| Identity in the page | `__GAME__` (a Vite define; `src/config.ts`): title, `storagePrefix`, version, preview models; `%GAME_TITLE%` in `index.html` |
| Loading screen | optional `bootStyle` in `game.json`: a CSS file inlined into `index.html`'s critical styles, so the first paint is already the game's splash (its other CSS arrives later, with its code) |
| Web root | `<gameDir>/public/` (served in dev, the packager's asset source) |
| Rust | `npm run wasm` builds `<gameDir>/crate` → `<gameDir>/public/wasm/sim.wasm` |
| Release | the build id, the release server's `/builds/<id>/` prefix and the asset allowlist from `game.json` |
| Tools | the preview's model list, the smoke driver, `npm run assets` / `verify:assets` |
| Vite plugins | the game's own, from the module `game.json` `vite` names (below) |

The release packager builds with `configFile: false`, so it takes the same
alias, define, title and web root from the same helper as `vite.config.ts`.

### `game.json`

| Field | Meaning |
| --- | --- |
| `id` | names builds (`<id>-<commit>`) and the release server's prefix; `[a-z][a-z0-9-]*` |
| `title` | the page title, the logo and receipts |
| `storagePrefix` | every saved key is `<storagePrefix>:<name>:v<N>`; distinct per game so games on one origin never share saves |
| `version` | the game's version string |
| `release.assets` | globs over the game's `public/` (`*` within a segment, `**` across); only matches ship, and a glob matching nothing fails the package |
| `preview.models` | `[{ "label", "url" }]` for `preview.html` (URLs relative to `public/`) |
| `commands` | `name → [command, ...args]`, run from the game's folder by `npm run game -- <name>`; `assets` and `verifyAssets` also have npm scripts |
| `smoke` | the game's smoke driver module, relative to its folder (its fields: [The smoke driver](#the-smoke-driver)) |
| `platform.wavedash` | host services the game opts into on Wavedash, all off when absent: `"paidContent": true` (needs the game's own approved catalog) and `"p2p": true` or `{ "messageSize": 45..65536, "maxIncomingMessages": 1.., "reliable", "unreliable" }` for P2P between lobby members. Unknown keys and out-of-range values fail the build. Example: `"platform": { "wavedash": { "p2p": { "messageSize": 4096 } } }` |
| `vite` | optional: a module in the game's folder whose default export is a list of Vite plugins, or a function `(env) => plugins` (sync or async; `env` is Vite's `{ command, mode, isPreview? }` plus `{ game }`) |
| `bootStyle` | optional: a `.css` file in the game's folder (for example `"src/boot.css"`) added at the end of `index.html`'s one critical `<style>` block in dev, `build`, the release packager and the browser fixtures, so the loading screen is the game's from the first paint. A game's stylesheet otherwise arrives with its code: one game's splash stayed the engine's plain boot screen for most of a slow load. Selectors start with `html` to outrank the engine's `#boot` rules; `url()` paths are relative to the page (the game's `public/`), so list those files in `release.assets`. It may not contain `</style`. Dev reads it on every request |

**Game Vite plugins.** A game that needs Vite plugins of its own (its dev
server, a middleware, a virtual module) lists them in the module `vite` names,
for example `"vite": "vite.mjs"` next to `game.json`. They are added after the
engine's in `vite.config.ts` (dev, `build`, `preview` and Vitest), the release
packager and the browser fixtures (`tests/frontend.mjs`), so the root
`vite.config.ts` never imports game code (the neutrality test checks that).
Limit a plugin with Vite's `apply: "serve"` or `"build"`: the packager builds
with `command: "build"`, so a dev-only server stays out of release packages.
`scripts/lib/active-game.mjs` `gameVitePlugins()` loads it.

## The contract between engine and game

A game is a folder with a Rust crate and a TypeScript entry. The engine drives
both; the game never reaches into engine internals it doesn't import.

**TypeScript.** `<gameDir>/src/index.ts` default-exports a `GameModule`
(`src/game.ts`): `abi` (its ABI mirror, checked against `sim.wasm` at boot) and
`create()` (its `Game`) are required; `tagline`, `tips`, `hud: { top, overlay }`
(markup for the engine's HUD slots), `help` (the "How to play" body, or `false` for none), `menu.extra` (popups of its own; [below](#input-flow-and-ui-rules)), `startTransition` (a wipe or a cut from the ready screen into the menu, below), `params`
(DEV tuning sliders), `actions` (extra input bindings), `rig` (camera
framing), `style` (the look it starts with), `audio` (its music and mix, below), `pauseOnBlur` (what losing focus does; [below](#input-flow-and-ui-rules)) and, for first-person games, `camera`,
`look` and `buttons` (see [First-person mode](#first-person-mode)) are optional. Its stylesheet is a side-effect import in the same
module and loads after the engine's `src/style.css`. The `Game` interface is the
per-frame contract: `load` (build the level into the sim, load GLBs), `reset`,
`startRound`, `round`, `input` (every frame; a neutral snapshot outside play),
`event` (each sim event), `frame` (presentation; returns the camera's ground
focus), `draw`, `menuShot`, `heroShot`, `summary` (the results card), `countdown`
(beats; sounds go through the engine's `AudioBus`, `rt.audio`), `showHud`, `stats`
(named numbers for `__game.stats()`), and optional `debugActions`/`debugInfo`. A game may also give
`beginIntro`/`introActive`: an intro of its own (a cinematic level intro) in place of the countdown's swoop and 3-2-1. The flow calls
`beginIntro()` when the countdown phase starts (the sim is READY and stays so); if it returns true the flow holds the phase, with the
game driving the camera through `eye()`, until `introActive()` turns false, and then runs the GO beat at once.
`skipCountdown` skips the countdown for one start: the flow asks it each time play starts (Play, Play again, Restart round,
`?autostart`), after `reset()` and before `beginIntro`, so a game with several scenes answers per scene. True goes straight to
"playing" with no 3-2-1, "GO!", swoop or intro. The flow makes no `countdown()` call, so the countdown sounds stay silent, and
the round starts at once (`startRound()`, input on). A game that leaves `skipCountdown` out keeps the countdown (the blank game
and Starter Arena do).
`summary` returns a `RoundSummary` (ribbon, title, rows, note). A game that wants its own results
markup (a receipt, a scoreboard) also sets `custom` to an element it builds fresh for the round: the
card shows it in place of the ribbon, title, rows and note, which stay in the DOM, visually hidden (tests
can read them and so does a screen reader; the dialog is still named by the title), and keeps its Play
again and Menu buttons. The element's animation is the game's own.
For custom results, leave decorative markup `aria-hidden` when the plain fields already
express the same information, to avoid duplicate announcements. `extra` appends content
to the standard card; `buttons` can rename either action or hide `again` with `false`.

**Sound.** A game with recorded sound sets `GameModule.audio`: `tracks` (named music, each a `TrackDef`
with `url`, `loopStart`, `loopEnd` and `gain`; `native: true` for a file that is a seamless loop, which
then plays on the browser's own sample-accurate loop instead of the timer crossfade) and `volumes` (where
the buses start; the Settings panel only ever sets `master`). The engine builds the `AudioBus` with them
and decodes the tracks in the background at boot, so Play never waits (a missing file only logs a
warning); `audio.playMusic(name)` switches with a fade, and the last call wins: a track that finishes decoding after a
newer `playMusic` or `playMusic(null)` stays silent. `audio.music.setDuck(amount, depth)` and
`setMuffle(amount)` duck and low-pass the music (a slow-motion moment), and a game's own music layer
connects to `audio.music.bus`. For decoded one-shots a game connects its nodes to `audio.sfxIn` (the SFX
bus, so the SFX volume, every mute and the limiter still apply) and may replace the four UI sounds through
`audio.ui` (`hover`, `press`, `back`, `whoosh`; return true when handled, false runs the built-in one).
The blank game and Starter Arena declare no `audio` and use synthesised sounds.
Tracks are decoded at boot and retained for the session; budget decoded memory on mobile. A track with
`preload: false` is fetched and decoded on its first `playMusic` instead (it starts that much later), for music a
player may never reach.

**Rust.** The game crate depends on `vgd-engine` (`{ workspace = true }`),
implements `vgd_engine::Sim` for its world (`new`, `reset`, `advance`,
`set_paused`, `round_start`, `params`, `events`, plus `ABI_VERSION` and
`PARAM_DEFAULTS`), and at its crate root calls `vgd_engine::export_engine_abi!(World)`
(the engine's exports and `pub fn world()`) and `vgd_engine::buffer!(…)` per
output buffer. Its own exports (level building, input, dev tools) sit beside
them. `vgd_engine::params!` declares the tunables table (ids must be dense;
anything else fails to compile).

| Engine (keep; extend) | Game (yours) |
| --- | --- |
| `crates/engine`: `clock` (`FixedStep`, `alpha()`), `events`, `math` (`Rng`, `wrap_angle`, …), `interp` (`Pose`, `DrawnPose`), `params!`, `Sim`, `export_engine_abi!`, `buffer!` | `<gameDir>/crate`: the world, its rules and tests, its exports and buffers |
| `src/runtime.ts`, `src/flow.ts`, `src/game.ts` (the contract), `src/main.ts` | `<gameDir>/src/index.ts` (GameModule), its `Game` |
| `src/wasm.ts` (loader, engine ABI, `SimLayout`) | `<gameDir>/src/sim-abi.ts` (a mirror of *your* Rust) |
| `src/gpu/*`, shaders, `src/gltf/*`, `src/camera.ts`, `src/math.ts`, `src/fx.ts` | models, animation blend, placeholders (the demo's `art.ts`) |
| `src/input.ts`, `src/ui/{frontend,tween,pops,format,stick}.ts` | HUD markup and updates, level loading, SFX |
| `src/audio.ts`, `src/music.ts`, `src/settings.ts`, `src/save.ts`, `src/platform/*`, `src/config.ts` | `game.json` identity; the game's saves (`VersionedSave`) |
| `src/dev/*` (tuning, debug panel, Mobile view), `preview.html` + `src/preview/*` | the tuning table, debug actions, preview models |
| `index.html` screens and `src/style.css` | the game's CSS, tips, tagline, help |
| `tests/*.test.ts`, `tests/smoke.mjs` (the harness), `tests/release/*` | `<gameDir>/tests/*.test.ts`, its smoke driver |

## Architecture

```text
Blender (an add-on's blender/) ──► <gameDir>/public/assets/*.glb + gameplay sidecars
                                   │                        │
                                   ▼                        ▼
             src/gltf (GLB → CPU)  →  src/gpu (WebGPU/WebGL 2)   the game's level loader ──its exports──►┐
                                   ▲                                                            │
   input.ts ─► game.input() ──the game's input export──► <gameDir>/crate on vgd-engine (sim.wasm) ◄┘
                                   │  fixed 120 Hz steps, events, output buffers
                                   ▼
            runtime.ts frame loop ─► game.event() / game.frame() / game.draw() ─► renderer
            flow.ts (screens, pause, countdown)   ui/frontend.ts (popups, focus)
```

### Who owns what

| State or clock | Owner | Notes |
| --- | --- | --- |
| Gameplay values: positions, collisions, timers, score, win/lose | the game's Rust world | JS only reads them |
| Gameplay clock | Rust `FixedStep`: fixed 1/120 s steps, real frame time clamped to 0.1 s, ≤ 12 steps per call | `sim_set_paused` freezes it; no fractional step carries over a pause |
| Round state READY → PLAYING → WON/LOST | Rust | the countdown's GO calls `sim_round_start`; the flow ends a round when `Game.round()` says won or lost |
| Random choices | Rust `Rng`, seeded by `?seed` (and, by convention, the round number) | same seed + inputs ⇒ same run |
| Tunable rules | the game's `params!` table, live via `sim_param_set` | ids mirrored in its `sim-abi.ts` |
| Screen/phase (title, menu, countdown, playing, paused, ending, results) | `src/flow.ts` | also decides when input reaches the game |
| Popups, focus, the menu cursor | `src/ui/frontend.ts` | one cursor for keys, pointer, touch and gamepad |
| Presentation clock (animation, particles, pops) | `src/runtime.ts` | stops while paused; `Particles` (a 2048-slot ring that replaces its oldest when full) drops new spawns while paused |
| Animation blend, particles, pops, camera, look | the game's presentation + engine helpers | never write sim state |
| Settings; game records | `src/settings.ts`; the game, via `src/save.ts` | versioned keys under the game's `storagePrefix` |
| Host integration (loading bar, gameplay start/stop, mute, saves, optional host services such as lobbies) | `src/platform/` | game code only talks to `platform` |

**Draw the interpolated pose, not the stepped one.** The sim steps at a fixed
120 Hz, but the display rarely lines up with it. A 120 Hz ProMotion screen with
Chrome's jittery frame times alternates 0 and 2 steps per frame, so anything
drawn at the latest step visibly hitches, and the follow camera hitches the whole
screen. In a measured run of the demo at running speed, 33 of 690 frames drew no
movement. So each moving entity keeps the pose it had before the latest step
(`vgd_engine::interp::DrawnPose`), and its output record carries a drawn pose:
that previous pose blended toward the current one by the clock's leftover
fraction (`FixedStep::alpha`); the demo's player record has `rx`, `rz`, `ryaw`.
Draw, follow with the camera and drive animation from it. Gameplay, steering and
tests read the current pose. The cost is up to one step (8.3 ms) of display
latency. `snap` at the start of every step and wherever you place an entity
without moving it (spawn, reset, teleport); `hold` before pausing. When you add
moving entities, give them the same treatment. `cargo test` covers it twice: the
engine's `drawn_pose_is_smooth_when_steps_alias` (the helper on a constant-speed
body) and the demo's `drawn_pose_moves_smoothly_when_steps_alias` (the real
player, jittery 120 Hz).

### Host lobbies and P2P (optional)

`platform.lobbies` is the host's matchmaking layer (Wavedash Lobbies), or
undefined where the host has none (web, CrazyGames): check it the way you check
`stats`, `boards` and `paid`, and keep single-player working without it. It
lists, creates, joins and `findOrCreate`s lobbies, keeps the current lobby's
members and host-written metadata (`setData`/`getData`, `onUpdate`), and carries
chat (`sendMessage`, `onMessage`), invites (`invite`, `inviteLink`,
`onInvite`, `launchLobbyId()` for a game opened from an invite link) and
presence (`setPresence`). It is not a game server: what a lobby means (a mode, a
version, a match that has ended) is the game's, given to `findOrCreate` as a
`filter` and kept in its metadata.

- Create a lobby on an explicit player action (Quickplay), not at boot: a
  public lobby made at boot stays listed while the player idles in the menus.
- `create` already joins; the adapter never joins it again (that would fire
  `LOBBY_JOINED` twice and rebuild every P2P connection). `maxPlayers` is the
  game's to give; left out, the host's own default applies.
- Chat lines are capped at 500 characters (`LOBBY_MESSAGE_MAX`) and are for
  people. Send game state over `lobbies.p2p`: binary messages on channels
  0..7, reliable or not, to every peer or one, read by draining each channel
  every frame. P2P is opt-in, in the game's `game.json` (below): `"p2p": true`
  takes the SDK's defaults (2048-byte message slots, 1024 queued messages per
  channel), or give `{ "messageSize", "maxIncomingMessages" }`. Without it
  `lobbies.p2p` is undefined and the SDK's `init()` is called as before.
- The host keys members and peers on the account: two tabs in one browser share
  one user id, so they are one member and never peers. Test multiplayer with
  two accounts (two browsers or profiles).
- `tests/lib/fake-wavedash.mjs` reproduces these rules for unit tests: give
  several fakes one `createFakeWavedashHub()`, one per player.

### Player identity for a game's own server (optional)

`platform.userToken?.()` resolves a signed token naming the player, for a
server the game runs itself (a multiplayer room, a reward ledger), or null
when the host gave none. On Wavedash it is the SDK's gameplay JWT
(`getUserJwt`: RS256, one hour); the web and CrazyGames adapters leave it
undefined. Ask for one per connection rather than storing it. The token
proves nothing until the server verifies it:

- the signature, against the host's published keys (Wavedash:
  `https://auth.wavedash.com/.well-known/jwks.json`), with the algorithm pinned;
- the issuer (`https://auth.wavedash.com`) and audience (`gameplay.wavedash.com`);
- the expiry, required rather than checked only when present;
- the game and environment: Wavedash's `gcid` claim must be this server's game
  cloud id (portal playtests and production have different ids), and `scope`
  must be `"gameplay"`.

Then key the player on `sub`. A verified identity authorizes nothing else by
itself: the server still decides what a player may earn. The fake SDK answers
a placeholder token (`fake-jwt.<userId>`, option `userJwt`) that no server can
verify; a real token against a live server is not tested here.

### Online games

The engine ships no game server, but a game can run its own. One game ran a
shared world on a Colyseus server, with the client on Wavedash. What held up:

- **The server is the authority.** A TypeScript server owns the world
  (movement, combat, enemies, the round) and clients send input and draw what
  it sends. The Rust sim keeps only the round shell the engine's flow needs
  (round state and clock), so the rules live in one place. The
  [colyseus-multiplayer skill](../.agents/skills/colyseus-multiplayer/SKILL.md)
  covers rooms, state sync, prediction and reconnects; identity is
  `platform.userToken()` (above).
- **The endpoint is set at build time.** The client reads a `VITE_*` value,
  and the target's `env` in `deploy/release.json` takes it from the shell
  (`{ "fromEnv": "<NAME>" }`), since one commit is packaged for a playtest
  server and for production. An upload refuses a package built with a
  different value than the shell gives now
  ([release.md](release.md#commands)).
- **Check the version before joining.** The server reports its protocol
  version and build on `/health`; the client compares the protocol with its
  own before joining and asks for a refresh on a mismatch, instead of failing
  mid-round. A local launcher checks the same before reusing a running server
  (Quick start, above).
- **Pause stops the player, not the world.** `pauseOnBlur` decides what losing
  focus does to the local client: `"input"` keeps it drawing and in sync with
  input withheld, `"pause"` opens the pause card. The server goes on either
  way, so say so on the card, and set `pause: { restart: false }` when one
  player cannot restart the round.
- **Smoke against a local fixture.** The smoke driver starts the server on a
  free loopback port when it is imported, points the build at it
  (`process.env.<NAME>`), lists it in `allowedOrigins`, sets
  `sharedWorld: true` (stats come from the server and change while paused) and
  stops it in `cleanup()` ([The smoke driver](#the-smoke-driver)). A hosted
  server never takes part in smoke.
- **Host the server separately**, with one environment per stage:
  [Your own game server](release.md#your-own-game-server).

### Frame order (`GameRuntime.frameInner`)

1. `input.poll()` → the flow's per-frame hook (mute key, countdown, pause key, round end)
2. `game.input(snapshot)`: the real snapshot (or the test autopilot) while playing, a neutral one otherwise
3. `sim_advance(dt)` unless paused (the steps taken are counted in `__game.simSteps()`)
4. events (a copy of the flat records) → `game.event()` and `onEvent`
5. `game.frame(dt)` → camera focus; HUD cover measured a few times a second; camera update
6. `game.draw(dt)` fills instance batches, blob shadows and GLB draws; particles step
7. `renderer.render()`, world-anchored pops, `sim_clear_frame()`

A throw inside the frame (for example a wasm trap) stops the loop and shows the
error card instead of throwing every frame.

## The WASM ABI

The sim is a plain C ABI: `#[no_mangle] extern "C"` functions over scalars, no
wasm-bindgen, no imports (the loader instantiates with `{}`; `npm run wasm`
fails if that changes). One world instance lives in the module
(`vgd_engine::Slot`).

- **Version checks.** `sim_engine_version()` must equal `ENGINE_ABI_VERSION` in
  `src/wasm.ts`, `sim_abi_version()` the game's `SIM_ABI_VERSION`, and every
  `buf_<name>_stride()` the game's `STRIDES` (plus the engine's `events`). The
  page refuses to start otherwise ("Simulation and page are out of sync …
  rebuild with npm run wasm"). A stale `sim.wasm` fails loudly instead of
  rendering garbage.
- **Output buffers.** `buf_<name>()` → pointer, `buf_<name>_count()` →
  records, `buf_<name>_stride()` → floats per record, exported by
  `vgd_engine::buffer!`. Outputs are written once per `sim_advance`.
- **Memory growth detaches views.** `Sim.f32(name)` builds a new
  `Float32Array` from `memory.buffer` on every call; never cache one across a
  call into the sim. The runtime copies the event buffer before dispatching,
  because a handler may call into the sim.
- **Events** are flat 6-float records `[kind, a, b, c, d, e]`, accumulated
  over the fixed steps of one frame and cleared by `sim_clear_frame()`. Kinds
  belong to the game.
- **Params** (`params!`) are id-stable f32s with defaults:
  `sim_param_count/get/set/default`. Non-finite values are rejected.

| Export | From | Purpose |
| --- | --- | --- |
| `sim_engine_version`, `sim_abi_version`, `sim_init(seed)`, `sim_reset`, `sim_advance(dt) → steps`, `sim_set_paused(on)`, `sim_clear_frame`, `sim_round_start`, `sim_param_*`, `buf_events*` | `export_engine_abi!` | lifecycle, clock, round start, params, events |
| `buf_stats*` | the blank game | its stats record (time, round time, state, paused, round, steps) |
| `level_begin`, `level_set_spawn`, `level_add_collider`, `level_add_pickup`, `level_end`, `sim_set_input(moveX, moveZ)`, `sim_debug_collect_all`, `sim_debug_add_time(s)`, `buf_player*`, `buf_pickups*`, `buf_stats*` | the starter-arena add-on | imperative level building from the sidecar, world-space movement, dev tools through the normal paths, its records |

A game's `sim_debug_*` exports are compiled into every build (one wasm serves
dev and release); only the DEV debug panel calls them, and that panel is not in
release bundles.

### Extending the ABI (checklist)

1. Rust: add the field or rule to the game's world; export a function at its
   crate root, or a buffer with
   `vgd_engine::buffer!(buf_x, buf_x_count, buf_x_stride, X_FLOATS, |w| w.out_x[..])`;
   new tunables go at the end of `params!` (never renumber).
2. Bump the game's `ABI_VERSION` when an export, stride, index or event meaning changes.
3. Mirror it in the game's `src/sim-abi.ts` (version, `STRIDES`, index maps,
   `EV`, `PARAMS`) and type new functions in its exports interface (it extends
   `SimExports`; the game casts `rt.sim` to `Sim<ItsExports>`).
4. Add a cargo test for the rule and a Vitest case in `<gameDir>/tests/` if
   the TS side reads it.

Engine exports change only with the engine: bump `ENGINE_ABI_VERSION` in both
`crates/engine/src/lib.rs` and `src/wasm.ts`.

## The Rust workspace

`Cargo.toml`'s members are `crates/*` (the engine) and `[ag]*/**/crate`: every
game crate, `game/crate` and `addons/<name>/crate`. One glob covers both on
purpose: Cargo treats a glob that matches nothing as a literal path and fails,
so `addons/*/crate` on its own breaks every cargo command once `addons/` is
deleted; this pattern always matches `game/crate` (verified with `addons/`
removed). Game crates depend on the engine as `vgd-engine = { workspace = true }`,
so the same `Cargo.toml` works at any depth. Package names must be unique across
the workspace (`my-game-sim`, `starter-arena-sim`), and `npm run wasm` finds the
active game's crate with `cargo metadata`.

## Make your game

1. **Identity.** Set `id`, `title`, `storagePrefix` in `game/game.json`, and
   rename the package in `game/crate/Cargo.toml` to match.
2. **Rules.** Write them in `game/crate/src/world.rs` with cargo tests: fixed
   steps, events, output buffers, a `DrawnPose` for anything that moves; add
   exports in `lib.rs` (level building, input) and mirror them in
   `game/src/sim-abi.ts`.
3. **Presentation.** Implement `Game` in `game/src/game.ts`: load the level
   (your exports) and GLBs, map input (`camera.groundBasis()` turns the
   screen-space stick into world directions), turn events into feedback, frame
   shots, fill the results card. Put the HUD markup, help, tips and tunables in
   `game/src/index.ts` and the look in `game/src/style.css`.
4. **Assets.** Put runtime files under `game/public/` and list them in
   `release.assets`; add GLBs to `preview.models`; declare your asset pipeline
   under `commands` (`assets`, `verifyAssets`). Start the contract from
   [templates/asset-contract.md](templates/asset-contract.md).
5. **Tests.** Cargo tests for rules; `game/tests/*.test.ts` for the TS side;
   rewrite `game/tests/smoke.mjs` to play your round with real input.

The Starter Arena add-on is a complete example of every step; reading or copying
it is often the quickest start.

**Gym pattern.** Before content, prove the mechanic in a small blockout. The
demo itself is that blockout (procedural placeholders, `?placeholders`). For a
bigger game, add a separate `gym.html` entry that builds a test level with the
same runtime and a reset key, keep it out of the release package (the
packager builds `index.html` only), and keep it working for regressions.

## First-person mode

Add these optional fields to the game's existing `GameModule`:

```ts
const firstPerson = {
  camera: "first-person",                 // Game.eye() drives the view; turns look input on
  look: { mouse: 0.0022, touch: 0.006 },  // optional sensitivities (defaults in src/look.ts)
  actions: { verb: ["Mouse:0", "Space", "Pad:0"] },
  buttons: [{ action: "verb", label: "USE", size: "large" }],  // touch buttons
  style: { exposure: 1.1 },               // the look this game starts with (DEV panel edits on top)
} satisfies Pick<GameModule, "camera" | "look" | "actions" | "buttons" | "style">;
// Spread ...firstPerson into the module alongside its abi and create.
```

- **The eye.** `Game.eye()` returns an `EyePose` (`x y z`, `yaw`, `pitch`, optional `roll`,
  `fovY`, `shadowFocus`) every frame after `frame()`; give it the *drawn* (interpolated) pose.
  Yaw and pitch belong to the sim, like every other gameplay value: `input()` pushes the look
  deltas in and the sim integrates them. `Camera.mode` is `"first-person"`; the near plane is
  0.05 m, shake becomes a small aim wobble (the eye never moves), and `menuShot`, `heroShot`
  and the countdown/ending swoops still work: the eye is expressed as an orbit `Shot`
  (`eyeAsShot`, `Camera.gameplayShot()`), so the blends in and out of it are the same code path.
  `Camera.groundBasis()` is the eye's forward and right on the ground. The sun shadow map centres on
  `shadowFocus` (default 4 m ahead); `Renderer.background` is the clear colour when the sky is off.
- **Any camera pose.** An `EyePose` also supports temporary third-person views. Blend
  positions and orientations in `eye()`; keep the camera inside your level. Ground
  movement follows the pose's yaw through `Camera.groundBasis()`.
- **Game settings.** Add game-specific rows to `#settings-pop` from `load()` and
  save them with the game's `VersionedSave`.
- **Look input** (`src/look.ts` has the pure parts, `src/input.ts` the listeners). The snapshot's
  `lookX`/`lookY` are radians since the last poll, x positive turning the view right, y positive
  turning it down. Sources: the **mouse** through pointer lock (the click that starts a round
  captures it: Play, Restart and the results' "again" ask inside the click, and a game's own click that ends in `flow.play()` counts, since the browser grants
  a lock only to a fresh click and the intro and countdown are longer than a click stays fresh; the flow keeps it through the menu's exit, the
  level intro and the 3-2-1 with `Input.clear(true)`, which `GameRuntime.resetRound()` uses, so the first mouse move at GO already looks around; if that
  did not hold, the first click on the canvas in play captures it and is not a press; Resume tries too), **touch** drag on the right of the screen (a touch starting left of `look.split` of the
  width drives the floating move stick instead), the gamepad **right stick** (squared response) and the
  **arrow keys** (which stop moving: WASD keeps moving; headless tests use them). `snapshot.locked`
  says the mouse is captured. Losing the capture in play (Esc, alt-tab) **pauses**, because the
  browser swallows the Esc keypress and reports only the release; the pause card, menus, the results
  and every `Input.clear()` release the mouse (a new round's `clear(true)` is the one exception). A captured mouse sends its clicks to the canvas, not to
  the overlay layers on top of it (a screen that must hear "click anywhere" while the mouse is captured, like the level intro, listens on the window too).
  If the browser refuses pointer lock to two clicks in a row, clicks
  stay ordinary presses for the session (`?nolock` forces that for tests); a refusal to the flow's own
  request (Play, GO or Resume) is not held against it: it only means "click to capture". Popups and screens own their keys, held input
  clears on blur, pause and screen changes, and `neutralInput` zeroes the look outside play.
- **Touch buttons** (`src/ui/touch-buttons.ts`). `GameModule.buttons` are drawn in their own layer
  (a column at the bottom right; restyle by `[data-action]`), only with touch controls (`rt.input.touchControls`:
  a coarse pointer, after the first touch, or the Mobile view) and only while the round is being played. Each button holds its named
  action while a finger is on it and gives one `pressed` edge when it goes down, so a key, a pad
  button and a screen button are interchangeable in `held`/`pressed`. A finger on a button never
  starts the stick or the look drag, and the buttons can be held together with both. `rt.touchButtons`
  relabels them (`setLabel`, `setReady`) and shows or hides one (`setShown(action, on)`, a Brake button
  only while driving; hiding one under a finger lets its action go).

## Add-ons

An add-on is a complete game in `addons/<name>/` with the same shape as `game/`.
See [addons/README.md](../addons/README.md). In short:

- **Play one:** `GAME_DIR=addons/starter-arena npm run dev` (or any command), or
  set `"gameDir": "addons/starter-arena"` in `game.config.json`.
- **Start from one:** replace `game/` with a copy (`rm -rf game && cp -R
  addons/starter-arena game`), then give it its own identity: `id`, `title`,
  `storagePrefix` in `game/game.json` and the package name in
  `game/crate/Cargo.toml` (two crates with one name break the workspace). Delete
  the add-on too if you no longer want it.
- **Remove one:** delete its folder. Nothing outside it refers to it, except
  prose in docs and comments.
- **Make one:** copy `game/` (or an add-on) to `addons/<name>/`, give it a
  unique id, storage prefix and crate name, and keep it self-contained: import
  the engine only as `@engine/…`, keep paths relative to its folder.

## Input, flow and UI rules

- `src/input.ts` maps devices to a screen-space stick plus named actions
  (`DEFAULT_ACTIONS`: pause = Esc/P/gamepad Start, mute = M; a game adds its
  own with `GameModule.actions`). Keys aimed at `.screen`/`.popup` elements and
  form fields are left to the UI, and so is any key the UI already handled
  (`defaultPrevented`: the Escape that closes the pause card must not pause
  again, wherever focus was); arrows and Space only have their default
  prevented while `input.gameplay` is on. Held input clears on blur, hidden
  tabs and every screen change.
- Mouse: `snap.pointer` (the demo holds the left button to run toward the
  cursor, picked through the camera's *stable*, unshaken view-projection).
  Touch: a floating stick anywhere on the play area (`src/ui/stick.ts` draws
  it; with look input, the left side). Gamepad: left stick / d-pad moves and
  right stick looks; A presses the focused button, B backs out, Start pauses.
- A game's own gesture on the canvas (a camera pan, a pinch) skips the
  pointers the engine uses: listen on `rt.canvas`, where the engine's listener
  runs first, and return when `rt.input.ownsPointer(e.pointerId)` (the move
  stick or the look drag). On a phone in one game, the move stick also panned
  the camera. Read an action as `snap.pressed.has(a) || snap.held.has(a)`: a
  tap shorter than a frame shows only in `pressed`, and reading `held` alone
  lost quick attack taps.
- **Phone layout.** `rt.input.touchControls` is true while the player uses
  touch controls: a touch screen (a coarse pointer), after the first touch, or
  the Mobile view below. `<body>` then has the class `touch-controls`, so write
  the game's phone layout as `body.touch-controls …`, not
  `@media (pointer: coarse)`, which the Mobile view never matches. One game
  copied about 15 layout rules to show its phone layout in its own preview.
- **The Mobile view** (`src/dev/mobile-view.ts`, dev server only). The *Mobile
  view* button, beside *Debug (B)*, opens the page in a phone-sized window
  (844×390; *Rotate* turns it to portrait), in play if a round is. There
  `rt.input.emulateTouch` is on from before `load()`: a left-button drag on the
  play area drives the move stick or the look drag, the touch buttons show, and
  the mouse is never captured. The view shows no dev panels. Its window name
  keeps it a view through reloads and the game's own links, and `?mobileView`
  makes any window one (an agent's phone-sized browser, say). It shares the
  main window's saves; an online game checks `rt.mobileView` to give it a
  guest identity of its own, so it joins as a second player instead of taking
  over the main window's. It is not a phone: one mouse is one finger, and
  screen density, safe areas, browser bars and phone performance still need a
  device.
- Pause freezes the sim clock (`sim_set_paused`) and presentation; Settings or
  Help opened from Pause return to Pause and never resume the round, and
  Restart or Quit from Pause don't resume it on the way out. Losing window
  focus pauses. Esc/P/B resume from the pause card.
- **Focus policy** (`GameModule.pauseOnBlur`, `src/focus.ts`). `"pause"` (the
  default) pauses on window blur, a hidden tab or a lost mouse capture.
  `"input"` keeps the round running and gives the game neutral snapshots
  (`rt.inputSuspended`) until the window has focus again: for a world that goes
  on without the player, such as an online round the server keeps simulating.
  `"none"` ignores focus. Held keys are dropped on blur in every mode. Esc out of
  a captured mouse reaches the page only as the release, so a release while the
  window keeps focus still pauses; under `"input"`/`"none"` the flow waits
  120 ms to tell it from alt-tab. A hidden tab gets no animation frames, so the
  loop stops there whatever the policy: a peer host that must keep running in
  a background tab needs its own timer. The module's value is where a game
  starts; `rt.setPauseOnBlur(mode)` changes it from game code (`load()`
  included) for one scene or mode, such as `"none"` in an asset viewer and
  `"pause"` again for a timed round. The change applies from the next focus
  change (a paused round stays paused), and leaving `"input"` hands withheld
  input back at once. `rt.pauseOnBlur` and `__game.pauseOnBlur()` read the
  current mode.
- "Press to start" is the audio unlock gesture and fires on `click`: on touch
  screens only the end of a tap is a user activation. Any key starts too, except
  Tab (it moves focus) and modifier shortcuts; the prompt says "Click or press
  any key to start", or "Tap to start" with touch controls (a touch screen, or
  the Mobile view).
- **Into the menu** (`GameModule.startTransition`). `"wipe"` (the default)
  covers the swap from the ready screen to the menu with the engine's circular
  wipe and starts the menu shot again from t = 0. `"cut"` hides the loading
  screen at once, shows the menu without a fade (its entries still cascade in)
  and keeps the camera and the menu clock running, so a world that shows
  through the ready screen carries straight on. `#boot` gets the class
  `is-ready` when the start prompt appears: a game's `bootStyle` uses it to
  turn the ready screen translucent over the live scene, which already shows
  the menu's framing then. The column stays centred whatever the title's
  length (it used to grow with a long title and push the prompt off centre).
- `rt.returnToMenu()` leaves for the menu at once, with no wipe, as Quit to menu
  does (the round resets): for the Back button of a screen the game shows in
  play before the round proper, such as a class picker or a lobby. It returns
  false on loading, the title and the menu.
- Popups: focus lands on `[data-autofocus]`, Tab/arrows stay inside, Escape
  closes, focus returns to the opener; popup → popup swaps keep the backdrop.
- **A game's own popups** (`GameModule.menu.extra`, `src/ui/menu-extra.ts`):
  `[{ id, label, body, title?, close?, pause? }]` adds a menu button
  (`data-act="extra:<id>"`) and a standard popup (`#extra-<id>-pop`, the body is
  the game's markup) for an About or Credits card, with the same focus and back
  behaviour as Settings. `pause: true` also lists it on the pause card; closing
  it there returns to the card, still paused. `rt.openPopup(id, opener?)` opens
  one from game code: in play it pauses first, over the results card it returns
  to the card (a results button), on the menu it opens like the menu button; it
  returns false for an unknown id or while another popup or the countdown is
  up. Ids are `[a-z][a-z0-9-]*`. An entry with `href` in place of `body` is a
  link on the menu instead (`<a class="mbtn">`, laid out like the buttons, so
  the pointer, Enter and gamepad A follow it): a test scene (`?scene=props`) or
  another page, with no popup and never on the pause card. `help: false`
  removes "How to play" from the menu and the pause card. The blank game and
  Starter Arena declare neither.
- `GameModule.pause: { restart: false }` takes "Restart round" off the pause
  card, as `buttons.again: false` does on the results card: for a round one
  player cannot restart, such as a shared online world. Hide it this way, not
  with CSS: the smoke check presses Restart unless the game declared it off.
- **A game's own modal** (a panel the engine does not know: a share card, a
  chat box) owns Escape by handling `keydown` on `document`, or on the modal
  itself, and calling `preventDefault()`. The engine's key handlers listen on
  `window`, later in the event's path, and skip a handled key, so that Escape
  neither closes the popup under the modal nor pauses. Capture-phase
  `stopImmediatePropagation` is not needed. Gamepad B and a lost mouse capture
  still reach the engine: releasing the capture in play pauses in every focus
  mode, so a modal opened in a first-person round sits over the pause card.
- `rt.onPhase((phase, previous) => …)` hears every phase change (title, menu,
  countdown, playing, paused, ending, results) after the flow has set
  `body[data-phase]` (which stays `boot` on the title screen); it returns a
  function that stops listening. Use it for analytics or music instead of a
  `MutationObserver` on `data-phase`.
- `[hidden] { display: none !important }` is global: component `display`
  rules otherwise override `hidden`.
- UI tweens (`src/ui/tween.ts`, Web Animations) are interruptible: a new tween
  starts from the old one's current look, which is committed to inline style
  for it and taken off again when it ends, so a class the game sets afterwards
  applies (a finished `fill: "none"` tween is not committed at all). A tween
  with `fill: "both"` (the default; `showEl`, `hideEl`, popups) holds its end
  values over the element's CSS while it lasts, as any animation does: to
  change a property a tween holds, tween it again rather than adding a class.
- The HUD is a top bar (`#hud-top`, `data-cover="top"`) whose first slot holds
  the game's markup, with the engine's mute and pause buttons at the right, plus
  an overlay slot. The camera clamps the visible ground footprint (near and far
  edges of the tilted view) to the level bounds + `edgeMargin`, frames portrait
  by width and landscape by height, and keeps the focus out of HUD-covered
  bands (any element marked `data-cover="top"` or `"bottom"`). The demo's hero
  shots search for a camera yaw with a clear view.
- `GameModule.rig` (`CameraRig`, `src/camera.ts`) sets that framing: pitch,
  field of view, ground spans, follow speed, edge margin and an optional `yaw`
  (default 0: the camera on the +Z side looking toward −Z). `yaw: Math.PI`
  follows from behind a player who faces +Z. The clamp, the HUD shift, the
  shake and `camera.groundBasis()` turn with it, so stick input stays screen
  relative.

## Rendering

Upgrading a custom renderer from v1? Follow the
[v2.0.0 migration guide](migrations/v2.0.0.md) for hook signatures, canvas
ownership, completion and backend-specific effects.

`src/gpu/renderer.ts` selects WebGPU first, then falls back to direct WebGL 2
if the API, adapter, device or initialization fails. No Three.js or shader
translation dependency is used. Backend modules load on demand. Adapter,
device and asynchronous initialization waits have a 10-second limit each.
A failed WebGPU context requires a fresh canvas; boot binds input and camera
controls to `renderer.canvas` after selection. If neither backend starts,
the error card reports the causes and asks the player to reload.

`webgpu-renderer.ts` and `webgl/renderer.ts` run: sun shadow map (2048²,
1024² on coarse pointers) → HDR scene (ground plane with optional metre grid, instanced procedural meshes
with inverted-hull ink, GLB models via scene hooks, blob contact shadows, sky,
translucent hooks (BLEND materials, back to front), particles) → bloom →
composite with optional depth of field, a hue-preserving highlight roll-off,
contrast, split tone, saturation and vignette. WebGL uses GLSL ES 3.00,
instanced VAOs, a shared frame UBO and joint matrix textures. Both backends
share the GLB loader, animation, model poses/material edits and frame packing.

WebGL probes `EXT_color_buffer_float` and a real framebuffer before enabling
RGBA16F and bloom. Without it, the scene uses RGBA8 with scaled lighting and
no bloom; shadows, skinning, ink, particles and grading remain available.
Expect some extra color banding in this reduced-precision path.

Games use `renderer.sceneHooks.push(() => models.draw())`; shadow hooks are
registered by `ModelRenderer`. Hooks no longer receive a WebGPU pass encoder.
Custom GPU effects need a driver for each backend. Inspect `renderer.backend`
and `renderer.capabilities` when a feature needs a backend-specific path.
`renderer.finished()` waits for rendering on either backend (WebGPU queue or
WebGL fence); `dispose()` releases its resources. Context/device loss stops
the simulation and asks for a page reload; there is no mid-round hot swap.

- `Renderer.lights`, `ambient`, `roomAO` and `background` support local lights,
  indoor fill/occlusion and a custom clear color on both backends.
  `CameraLike.shadowFocus` can pin the sun map independently of the eye.
- `Style` holds every look value (a game starts from `GameModule.style`); the
  DEV tuning panel builds sliders from `STYLE_RANGES` and colour pickers from
  `STYLE_COLORS`. It saves only values that differ from the game's defaults,
  stamped with a hash of those defaults (`style`, colours included, and the
  params' Rust defaults): change a default and stale overrides are dropped on
  the next load (logged), not silently re-applied. A game's own look or
  settings panel (a test scene's lighting controls) saves the same way: only
  overrides, stamped with `tuningBasis()` (`src/dev/tuning.ts`) of the
  defaults they were made against. Two scenes in one game saved every value
  instead, and a retuned default never reached the user's preview. A badge beside *Tune (T)*
  counts the active overrides; click it to reset them. Settings turn shadows (`shadow: 0` skips the pass) and
  outlines (`inkPx: 0`) off. `toon` blends a smooth wrapped Lambert (0) with a
  banded ramp (1); the default 0.55 keeps it subtle. See
  [Look settings](#look-settings) for the colours, haze, bounce, depth of
  field and material motion added in v2.2.
- Ink width is in screen pixels (at 720p) and the shell is pushed back along
  the view ray, so it neither thickens up close nor pokes through concave
  detail. The rim light is a thin sunlit band, masked on up-facing surfaces.
- `ModelRenderer.upload(doc)` uploads a GLB once; `instance(model)` makes a
  copy that shares geometry and textures but has its own pose, materials and
  flash; `recolor()` reskins by semantic material name (the demo's gold gem).
  Nodes named `col_*` and `mk_*` are never drawn. `recolor(model, colors, glow)`
  optionally recolors emissive channels while preserving authored strength.
  `release(models)` frees models and removes pending draws; release a source only
  with all its instances, since they share geometry/textures. Instances can be
  released alone. `resources()` reports live model-driver allocations for leak
  checks (buffer bytes, texture count; not total renderer/device memory).
  Image textures are shared beyond instances too: every material and every
  `upload` that uses the same `ImageBitmap` (one glTF image used by several
  materials, the same doc uploaded twice, or docs built from one) shares one
  GPU texture on WebGPU, one per image and sampler on WebGL 2. Each source
  holds a reference, so releasing a source frees a texture only when no other
  source still uses it.
- A copy shares memory, not draws: every copy is its own draw call per
  primitive in each pass (fill, ink, sun shadow), not hardware instancing.
  For 100 or more static copies of a prop (trees, fence posts, rocks), merge
  their placements into one mesh when you build the level (one GLB node), or
  draw simple shapes through the procedural instance batches (`rt.batches`:
  box, sphere, dome, cylinder, cone), which are instanced: one draw per shape.
- The hit flash (`flash` in `prepareStatic`/`prepareSkinned` and the batches'
  flash parameter) mixes the lit colour toward an overbright white (2.2), so
  small values read: peak around 0.1 or lower, fade within about 0.1 s, and
  restart the pulse on a new hit rather than extending it. In one game a 0.45
  peak, then 0.22, left a boss a white silhouette under several attackers;
  0.07 kept it readable.
- `parseGlb(data, url, { textures: false })` (and `loadGlb(url, { textures:
  false })`) skips image decoding: materials get no texture or sampler. Node
  tools and game servers, which have no `createImageBitmap`, can read meshes,
  colliders and markers this way; `isColliderNode` lives in `src/gltf/glb.ts`
  (still re-exported from `src/gpu/model.ts`).
- The engine draws every queued model; it does not cull. `src/gpu/frustum.ts`
  has the helpers for a game that streams chunks or many models:
  `frustumPlanes(camera.viewProj)` gives six normalised planes (the engine's
  [0, 1] clip depth, used on both backends) and `boxInFrustum(planes, min,
  max)` tests a world AABB against them (conservative near corners).
- `Camera` clips at 0.3 m (0.05 m in first person) and at 200 m, or 4 × the
  shot distance when a shot pulls back further than 50 m, so a whole-scene or
  portrait framing stays inside clip depth. Depth of field and the sky read
  depth through `invViewProj`, so they follow.
- `OrbitCamera` (`src/preview/orbit.ts`, the model preview's camera) also suits
  a game's inspection scenes: `minDistance`/`maxDistance` (0.3/80 m) bound the
  zoom, `attach(el, onMove, accept)` takes an optional gate (return false to
  leave a pointer or wheel event to something else; a drag it refuses part-way
  ends) and returns a function that removes its listeners. Held pointers are
  dropped when the window loses focus. It skips `setPointerCapture` while the
  pointer is locked (a look-enabled game locks its canvas), where Chrome throws
  `InvalidStateError`.
- WGSL compile errors are logged with line numbers; uncaptured GPU errors and
  device loss are reported (device loss shows the error card).
- `rt.captureFrame()` resolves with a copy of the next frame drawn: a 2D canvas
  the size of the drawing buffer, without the HTML HUD or screens (a share
  image, a thumbnail; draw any overlay on the copy). It is taken straight after
  rendering, since both backends drop the drawing buffer once the page has been
  shown, and rejects once the loop has stopped.

### Materials and the translucent pass

Each glTF material has an alpha mode and a kind, packed into its material slot
(`src/gpu/model.ts`, 12 floats: base RGBA | emissive RGB × strength, has
texture | gloss, kind, alpha mode, alpha cutoff; `model.wgsl` `Material`).

| `alphaMode` | Drawn | Ink | Casts sun shadow |
| --- | --- | --- | --- |
| `OPAQUE` (default) | opaque pass; alpha ignored | yes | yes |
| `MASK` | opaque pass; discards where base alpha × texture alpha < `alphaCutoff` (default 0.5) | yes, cut out | yes, cut out |
| `BLEND` | translucent pass: after the opaque scene, blob shadows and sky, before particles; premultiplied alpha, depth test on, depth write off, both faces | no | no |

Before v2.2 every material drew opaque, so an older GLB that exports BLEND or
MASK changes look when it moves to this engine; make the material opaque in
Blender if it should not.

The translucent pass sorts BLEND primitives back to front by the distance from
the eye to each primitive's bounds centre, across every `ModelRenderer`'s draws
that frame (a skinned primitive is placed by its first joint). BLEND surfaces
are lit, shadowed and hazed like opaque ones; skinned primitives take the same
path (the automated scenario draws static ones).
Limits: triangles inside one primitive are not sorted, so intersecting or
self-overlapping translucent surfaces can show the wrong one in front (split
them into separate objects); particles draw after them and are not sorted with
them; translucent surfaces write no depth, so depth of field focuses on what is
behind them. `ModelRenderer` registers on `Renderer.translucentHooks`
(`(eye) => void`); a custom model driver draws BLEND primitives only if it
implements `drawTranslucent`.

The kind (`extras.vgd_kind` or `extras.vgd.kind`; see [Assets](#assets)) is
one of four: `default`; `foliage`, which sways in the wind
(`Style.foliageSway`/`foliageFreq`; the sway grows with height above the node's
origin, full at 1.5 m; skins sway from the ground plane); `liquid`, whose
up-facing surfaces carry two crossing waves (`liquidWave`/`liquidSpeed`;
normals follow the slope) and which, when BLEND, turns more opaque at grazing
angles; and `bump`, whose base colour's brightness shades as relief. Motion
applies in the fill, ink and shadow passes and is off by default.

`bump` is an approximate height effect, not normal-map support: the fill pass
reads the lit base colour's luminance as a height field, `Style.bumpHeight`
metres (default 0.12) from black to white, and bends the shading normal by its
slope on screen. Silhouettes, ink, shadows and depth stay flat, a plain colour
gives no relief, and painted detail that is not height (a dark stain) reads as
a dent. Only bump materials pay for the screen-space derivatives.

### Texture sampling

Each material samples its base colour texture with that texture's glTF
sampler (`GltfMaterial.sampler`; the backend mapping is `src/gpu/sampler.ts`),
on both backends. A texture without a sampler is sampled as every texture was
before v2.3: linear with trilinear mipmaps and 4× anisotropy, repeating
(`DEFAULT_GLTF_SAMPLER`). A missing sampler index, or a field value glTF does
not define, falls back to that default with one console warning per sampler
naming the file. Images from `retexture()` use the material's sampler.

| Exported as | magFilter / minFilter | Close up | Far away |
| --- | --- | --- | --- |
| no sampler; Blender *Linear*, *Cubic* or *Smart* | LINEAR / LINEAR_MIPMAP_LINEAR | smooth | averaged mips, anisotropic |
| Blender *Closest* | NEAREST / NEAREST_MIPMAP_NEAREST | hard texels | averaged mips: small texels blend together |
| Retro Diffusion 3D GLBs (`PixMesh`) | NEAREST / NEAREST | hard texels | the full-size image: texels stay crisp but shimmer |

Only the minification filter decides whether mipmaps are read. NEAREST
magnification does not turn them off: with a `*_MIPMAP_*` minification filter,
a pixel-art texture still averages its texels into grey at a distance.
NEAREST or LINEAR minification reads the full-size image however small it is
drawn (WebGPU binds a one-level view of the texture for it), which keeps each
texel's colour and aliases instead. Anisotropic filtering applies only to the
all-linear default. The Blender rows were measured with Blender 5.2.0 LTS
(glTF I/O 5.2.39): the Image Texture node's interpolation sets the filters, and
its extension sets the wrap (*Repeat* writes none, so REPEAT; *Extend* writes
CLAMP_TO_EDGE; *Mirror* writes MIRRORED_REPEAT). Blender has no setting that
exports a minification filter without mipmaps. The Retro Diffusion row is from
37 exports in one source game (`magFilter` and `minFilter` 9728, clamped).

The `test:graphics` textures scenario checks this on WebGPU and WebGL 2: one
image sampled NEAREST and LINEAR side by side (hard edges against a gradient),
a far checker minified with and without mipmaps, and the shared-texture
reference counts through upload, instance, retexture and release.

### Look settings

These `Style` fields replace constants that used to be hard-coded in
`common.wgsl`/`common.glsl`. Their defaults are the old constants, so a game
that sets none of them renders exactly as before (the `test:graphics`
captures are pixel-identical). Colours are sRGB 0..1, as a colour picker shows
them; replace a colour with a new array rather than editing one in place (the
defaults' arrays are shared).

| Field | Default | Effect |
| --- | --- | --- |
| `shadowTint` | `[0.36, 0.44, 0.7]` | cool fill where sun shadows fall |
| `skyZenith`, `skyHorizon` | `[0.34, 0.6, 0.92]`, `[0.8, 0.88, 0.96]` | the procedural sky; the horizon is also the haze colour, and the band below it follows the horizon |
| `cloudTint`, `cloudOpacity` | `[1, 1, 1]`, 1 | the sky's clouds: a colour that multiplies them (a dark blue for night) and how much they cover the sky (0 skips them) |
| `hazeStart`, `hazeEnd` | 40, 150 m | where distance haze (`haze`) starts and is full |
| `groundBounce` | `[0.58, 0.54, 0.46]` | the daylight ambient from below (`Renderer.ambient` still overrides it indoors) |
| `groundBounceStrength`, `groundBounceReach` | 0, 2.5 m | extra bounce of that colour on down- and side-facing surfaces near the ground, fading out over the reach |
| `dof` | 0 (off) | depth of field strength; 1 blurs up to about 8 px at 720p |
| `dofNear`, `dofFar` | 1.5, 30 m | the focus range: sharp between them, full blur at 0.4 × near and 2 × far (the sky counts as far) |
| `foliageSway`, `foliageFreq` | 0 m (off), 0.35 Hz | `foliage` materials' wind sway |
| `liquidWave`, `liquidSpeed` | 0 m (off), 1 | `liquid` materials' wave height and speed (1 ≈ crests at 0.5 m/s) |
| `bumpHeight` | 0.12 m | `bump` materials' relief from black to white in the base colour; 0 shades them flat |

`bumpHeight`, `cloudTint` and `cloudOpacity` ride in spare slots of the shared
`Frame` (`common.wgsl`: `tint.w`, `misc.w` as a packed colour, `ink.z`), so its
size and layout are unchanged and a game shader that declares it needs no edit.

Depth of field reads the scene's depth buffer in the composite (WebGPU binds it
as a depth texture; WebGL 2 now renders scene depth into a `DEPTH_COMPONENT24`
texture instead of a renderbuffer) and gathers 16 taps on a disc whose radius
follows each pixel's blur. Nearer taps count only as far as they are blurred
themselves, so a sharp subject does not smear onto the background; a blurred
foreground does not spread over a sharp subject behind it. Off, the
composite skips it; on, it adds 17 depth reads and 16 colour reads per pixel, so measure
it on a phone before shipping it there.

### Posing a skin from world-space bones

The `Animator` composes clips. For a body that something else moves (a physics-driven body, a verlet chain,
IK) `src/gltf/skinpose.ts` poses a skin from where the bones should be *in the world*:

```ts
const pose = new SkinPose(doc);                    // same outputs as the Animator: world, jointMatrices
// per bone, per frame: the world-space matrix that takes the bone from its rest pose to where it is now
boneDelta(delta, 0, restHead, posedHead, linear);  // T(posedHead) · linear · T(−restHead); linear is a 3×3
pose.set("upperarm_L", delta);                     // nodes without a delta follow their nearest posed ancestor
pose.update(root);                                 // fills pose.world and pose.jointMatrices
models.prepareSkinned(gpuModel, pose);             // prepareSkinned takes an Animator or a SkinPose
```

The caller never reads the file's node rotations (Blender bone roll makes them meaningless to a game):
it needs the rest head of each bone (`pose.restPosition(name)`, or the asset's own data) and a rotation.
The maths helpers build that rotation from directions: `frame3(out, axis, ref)` (an orthonormal frame from
a long axis and a side reference; the rest-to-now rotation is `mul3T(R, nowFrame, restFrame)`),
`swing3(out, from, to, hint)` (the minimal rotation between two directions, stable through a half turn),
`followSwing(out, parentRotation, restDir, posedDir)` (a bone that keeps its twist from its parent),
`stretchAlong(out, dir, s)` (scale a bone along its length toward a simulated segment length). All are
allocation-free, take 3×3 matrices as 9 numbers column-major, and are tested in `tests/skinpose.test.ts`.
`ModelRenderer.instance()` gives each body its own joint buffer, so many bodies can share one upload.

## Assets

A game's runtime files live under its `public/` and ship only when
`release.assets` lists them. Conventions (keep them in your contract): metres,
+Y up, asset front +Z, yaw 0 faces +Z, positive yaw CCW from above, character
origin at the feet. Start a contract from
[templates/asset-contract.md](templates/asset-contract.md).

**Material alpha and kind.** Blender's glTF exporter takes the alpha mode
from the material's node tree: a Principled BSDF Alpha below 1 (or linked)
exports `BLEND`; alpha passed through a Math *Round* node exports `MASK`
(cutoff 0.5), and through *Greater Than* with threshold *t*, `MASK` with
`alphaCutoff` *t* (*Less Than* alone exports `BLEND`).
Blender 4.1 and older used the material's Blend Mode setting instead. For the
kind, add a material custom property (Material Properties → Custom Properties
→ New) named `vgd_kind` with the string `foliage`, `liquid` or `bump`, and export with
*Include → Custom Properties* on (bpy: `mat["vgd_kind"] = "foliage"` and
`export_extras=True`); a `vgd` group holding `kind` works too. Measured with
Blender 5.2.0 LTS: those settings export `"alphaMode": "BLEND"`, `"MASK"` (Greater Than 0.3 → `"alphaCutoff": 0.3`) and
`"extras": {"vgd_kind": "liquid"}` / `{"vgd": {"kind": "foliage"}}`. Unknown
values draw as `OPAQUE`/`default` with a console warning naming the material.
Record each material's mode and kind in the asset contract's material table.

**Texture filtering.** Decide per material whether its texture is sampled
nearest (pixel art: hard texels) or linear, and whether it is mipmapped, then
check the exported sampler: Blender writes it from the Image Texture node's
interpolation (*Closest* → NEAREST, still mipmapped) and extension; see
[Texture sampling](#texture-sampling) for what each choice looks like close up
and at a distance. Record it in the asset contract's material table.

The demo's GLBs and gameplay sidecar come from `addons/starter-arena/blender/`;
their contract (units, axes, pivots, clips, strides, material names, colliders,
markers, the locomotion blend rule) is
[addons/starter-arena/docs/demo-assets.md](../addons/starter-arena/docs/demo-assets.md).
The layout's authority is its `public/assets/demo/arena.gameplay.json`, written
by the Blender verifier from the exported GLB; its `level.ts` validates it
(errors name the field) and falls back to a built-in copy when it is missing,
so a checkout without Blender output still plays on placeholders
(`?placeholders` forces that path). Walk and run share one phase advanced by
distance ÷ blended stride (strides read from the GLB's `walk_stride_m` /
`run_stride_m` extras, which the model preview also reads).

## Test hooks

| URL option | Effect |
| --- | --- |
| `?seed=<n>` | sim RNG seed (default 1) |
| `?autostart` | skip the title and menu straight into a countdown, or into play when the game skips the countdown (no awaited UI animation) |
| `?capture` | no requestAnimationFrame: `__game.step(n)` advances exactly n frames of 1/60 s and resolves after rendering finishes |
| `?capture&maxpx=<n or WxH>&maxdpr=<d>` | lift the canvas caps for a high-resolution capture (`Renderer.maxPixels` 2.6 M device pixels and `maxDpr` 2 otherwise: 2560×1440 at DPR 2 renders at 2149×1209); up to 8192² pixels and DPR 4; ignored without `?capture` |
| `?renderer=auto` / `webgpu` / `webgl2` | automatic selection (default), strict WebGPU, or direct WebGL 2; also supported in `preview.html` |
| `?nolock` | disable pointer lock for first-person tests; keys/touch/pad still look |
| `?limit=<s>`, `?placeholders` | the demo add-on's: round time limit; ignore the GLBs and sidecar |
| `?scene=<name>` | convention, game-owned: open a focused test scene instead of a round (below) |

`window.__game` (installed after boot): `stats()` (the game's named stats),
`project(x, y, z)` → CSS px through the rendered camera, `reset()`, `step(n)`
(capture only), `pixelBudget({ maxPixels?, maxDpr? })` (capture only: change
the caps, returns them with the current `size`; the next step renders at it), `phase()`, `fps()`, `simSteps()` (fixed steps since boot), `rounds()` (rounds laid out since boot: a restart adds one, a resume none), `pauseOnBlur()` (the focus mode now),
`clock()` (presentation clock), `graphics()` (backend, fallback reason, HDR
and bloom capabilities), `seed`, `sim`, `runtime`, and an `autopilot` slot: set a function `(dt, rt) => ({ moveX, moveY })` to replace the player's
movement while playing, `null` to hand control back. Games add their own in
`load()` (the demo: `player()`, `pickups()`, `layout()`, `assets()`). Each page
load is a fresh wasm instance: reload between headless runs rather than reusing
a page, so no clock or phase leaks between them.

**Focused test scenes.** Judge one asset class in a scene that contains only
that class, not in a full round: debug routes that run a whole match are slow
to reach the moment in question and bury defects under gameplay. Read
`?scene=<name>` in the game's `load()` and build a studio with a neutral floor,
fixed light and camera, and no bots, timer, HUD or level dressing. Useful
scenes, one per asset class:

| Scene | Shows |
| --- | --- |
| `characters` | every character in a row, each clip selectable, every socket holding an asymmetric marker or its real item |
| `props` | each prop at its pivot beside a 1 m reference, with its collider drawn |
| `fx` | each effect looping on a timer against plain and busy backgrounds |

`preview.html` shows static models; a scene runs the game's own draw path, so
it also exercises attachment order, animation blending and effects. Give each
scene an id the game exposes on `__game` (for example `scene()`) so scripted
captures can assert they loaded the right one. Keep scenes out of release menus.
A scene opens straight into control, from its menu entry, a direct link, a
restart or a reset: its `skipCountdown()` returns true, so there is no 3-2-1,
countdown sound or opening swoop (hiding `#countdown` is not enough: input and
the round would still wait for GO).

## Tests and the smoke check

- `npm test`: `cargo test --workspace`. The engine: the clock (alpha, 60 Hz,
  hitches), events, math, `params!` (dense tables, empty tables), `DrawnPose`
  (smooth under 120 Hz aliasing, the short way round, snap, hold) and
  `export_engine_abi!` end to end on a small world (`crates/engine/tests/abi.rs`).
  The blank game: round start, time, pause, reset, determinism, its exports.
  The demo: movement, walls, bumps, collection, win/lose, the bonus gem, pause,
  determinism, params, debug tools, non-finite input, the drawn-pose regression
  and its exports through raw pointers.
- `npm run test:game` (Vitest): the engine's suites (ABI check and lifecycle on
  the active game's real `sim.wasm`, input, settings, particles, camera, time
  formats, platform adapters, saves, renderer selection, shared model/frame state,
  audio, first-person input, skin poses and engine import boundaries: no
  literal path from `src/`, `vite.config.ts`, `scripts/` or `tests/` into `game/` or
  `addons/`, and `@game` only in `src/main.ts` and tests)
  and the active game's own (the demo adds its ABI mirror, layout and
  GLB/animator suites).
- `npm run test:release` (node:test): the packager's checks against fixtures,
  the active-game resolver and `game.json` validation (and game Vite plugins),
  that every game in the checkout is a complete folder with a distinct id and
  storage prefix, that Git tracks no ignored file (`git ls-files -ci
  --exclude-standard` is empty: a force-added `sim.wasm` stays tracked
  otherwise; skipped outside a Git checkout), the CDP driver's event
  listeners (`tests/lib/cdp.mjs`: `on(fn)` hears every event, `on(method, fn)`
  one method's params, and anything else throws, since a listener that never
  fires lets an error check pass without checking), and
  `scripts/test_sync_skills.py` (skipped, saying so, without `python3`).
- `npm run smoke`: packages the web target, serves it under `/builds/<id>/`
  (`scripts/serve-release.mjs`), launches Chrome headless with `--mute-audio
  --enable-unsafe-webgpu` and a fresh profile, and uses trusted CDP input over
  Node's built-in WebSocket (no puppeteer). The engine's part, for every game:
  desktop 1280×720: click to start, menu, How to play (or the game's first
  `menu.extra` popup when it has no help), Play, countdown (or straight to
  playing, with no number shown, when the game skips it), playing,
  *the game's driver*, Esc pause (sim steps, presentation clock and stats
  frozen), Settings from the pause card and back, Resume (they advance), a
  window blur that does what the game's focus mode says (`__game.pauseOnBlur()`:
  `"pause"` pauses; `"input"` keeps the round running with input withheld until
  focus returns, `"none"` keeps it running, and Escape then pauses), Escape
  resume, Quit to menu. Phone 390×844 with touch emulation and
  reduced motion: tap to start, Play, *the game's driver*, the HUD pause button,
  frozen, Resume, Restart round (one more `rounds()`, through a new countdown
  unless the game skips it; with `pause: { restart: false }`, a check that the
  card has none), Quit to menu (or Menu from
  the results card if the driver ended the round). Each session first throws
  an exception and a `console.error` on purpose and fails unless it heard both.
  It fails on console errors, page exceptions, missed
  requests, a request or WebSocket to any origin but the release server and
  the driver's fixtures, dev-only UI in the release, an audio context not
  running within 5 s of the start gesture, or a second tab. The blank game's driver checks its HUD and round
  clock; the demo's drives an A* route to all 12 gems with real keys, wins,
  replays, and on the phone steers the touch stick to a gem and times out.
  Runs WebGPU and WebGL 2, each on desktop and phone. Limit a run with
  `npm run smoke -- --renderer=webgl2` (or `webgpu` / `auto`). A full run
  that passes records `release/web-smoke.json`, which uploads require
  ([release.md](release.md#preflight-what-must-be-true-before-a-client-ships)). Screenshots land
  in `out/smoke/<id>/<renderer>-<session>-<step>.png` (ignored); look at them.
- `npm run test:graphics`: deterministic captures plus injected missing API,
  missing/stalled adapter, rejected device, already-configured canvas and
  pipeline validation failures; WebGL without usable float render targets;
  both APIs unavailable; strict WebGPU failure; WebGL context loss; a 1440p
  DPR 2 capture at full size with `maxpx` and capped without it. Verifies
  replacement-canvas pointer input, portrait resize, clean errors and stopped
  simulation on loss. Then the materials scenario builds
  `tests/fixtures/graphics-game.ts` around the active game and checks probe
  pixels on WebGPU and WebGL 2: BLEND see-through and back-to-front order, a
  MASK cut-out, depth of field blurring a far wall but not the subject, and a
  `bump` card shading relief, and clouds that `cloudOpacity` removes and
  `cloudTint` colours; relief and clouds must change the same way on both
  backends (`--no-materials` skips it). Evidence is in `out/graphics/<id>/`. These injections
  establish fallback behavior, not real unsupported-device coverage. The full
  harness needs a test machine with both APIs; use `smoke -- --renderer=webgl2`
  for gameplay checks on a WebGL-only machine.
- `npm run test:frontend`: a browser fixture around the active game checks real
  mouse capture through an intro, skip/restart/resume, `menu.extra` popups from
  the menu, pause card, results card and `rt.openPopup` with `help: false`, the `"input"` focus policy
  (blur keeps the round running, input withheld) and `rt.setPauseOnBlur`
  switching it to `"pause"` and `"none"` mid-round, touch move/look/action,
  custom/default results dismissal, and `skipCountdown` (Play straight into
  play with no countdown phase or intro, control and mouse capture at once).
  Then, on each renderer, the wipe and the cut start (`#boot.is-ready`, a long
  title still centred, no wipe and the camera carried on for the cut, the menu
  entries cascading in), `rt.captureFrame`, `rt.returnToMenu`, a game modal
  owning Escape over the pause card and a `menu.extra` link. Fixture wins establish shell behavior only.
  It also checks the overlay layout at every portal size and on a phone in
  portrait, landscape and 667×375, all at DPR 1: in play, the game's pieces in
  the top bar, the mute and pause buttons, the touch buttons and every element
  marked `data-no-overlap` must fit the screen and overlap no other (one inside
  another is fine); the pause and results cards must fit. Mark a HUD piece of
  your own (a notice, a status panel, a chat box) with `data-no-overlap` to
  include it.
- `npm run test:mobile-view`: on the dev server, the *Mobile view* button opens
  a window in play, marked for touch, with its touch buttons, a mouse drag on
  the move stick and no dev panels. The view survives a reload, *Rotate* and
  the button work, and `?mobileView` makes any window one. Headless Chrome
  ignores a pop-up's size, so the test checks the size the page asks for.
- Clean export: copying `git ls-files -co --exclude-standard` to a temp dir,
  then `npm ci && npm run build && npm test && npm run test:game && npm run
  test:release && npm run smoke` there; the same with `addons/` deleted; and
  with `GAME_DIR=addons/starter-arena`.

### The smoke driver

The module `game.json` `smoke` names default-exports any of these
(`tests/lib/smoke-driver.mjs` checks them before the run):

| Field | Meaning |
| --- | --- |
| `desktop`, `phone` | `{ query?, play?, drive(t) }`: the game's own round in that session, played with real input through `t` (`press`, `key`, `tap`, `waitPhase`, `check`, `shot`, and `p` for raw CDP). `query` replaces the session's URL query (`?seed=7` / `?seed=3`). |
| `play` | a selector for the menu entry pressed for Play, for a menu with several `data-act="play"` entries (default the first `.mbtn[data-act="play"]`) |
| `allowedOrigins` | origins of the game's own local fixtures, such as a game server the driver starts at import: `["http://127.0.0.1:<port>"]`, loopback only. Requests and WebSockets to them pass; any other origin still fails the run. |
| `sharedWorld` | `true` when the world goes on on a server while the local round is paused: pause must still freeze the sim and the presentation clock, but not the game's stats |
| `cleanup()` | async: stops what the driver started (a server process, a data folder). Awaited after the run, whether it passed or not. |

The driver is imported before the web package is built, so a driver that
starts a fixture can also set the shell values the build reads
(`process.env.<NAME>` for a `fromEnv` target value).

## Known limits

- **WebGPU or WebGL 2 required.** No WebGL 1/software renderer. WebGL without
  float render targets disables bloom. Actual low-end phones and embedded
  browsers still need device testing.
- **glTF subset** (`src/gltf/glb.ts`): triangle lists, float/normalised-int
  accessors, embedded buffers/images, LINEAR/STEP/CUBICSPLINE samplers,
  base colour factor/texture, emissive (+ `KHR_materials_emissive_strength`),
  `alphaMode`/`alphaCutoff`, the `vgd_kind` material extra, one skin per
  character, four influences. Not supported: morph targets, sparse accessors,
  external files, metal/roughness/normal/occlusion maps, texture transforms,
  Draco/meshopt, cameras/lights. BLEND ordering is per primitive (see
  [Materials and the translucent pass](#materials-and-the-translucent-pass)).
  Required extensions are rejected with an error naming them.
- The rotation-per-bone interpolation doesn't keep IK-planted feet exactly on
  the ground between keys; dense sampling (90/s for the demo) keeps the error
  small (see the demo's asset contract).
- One sim world per wasm instance; the fixed step is 120 Hz with at most 12
  steps per frame (a slower machine runs the game slower, not choppier).
- `tsc` sees `@game` only as the `GameModule` contract (`src/game-module.d.ts`);
  each game's `index.ts` is type-checked on its own.
- In `?capture` mode UI tweens (WAAPI) still run on wall-clock time; the
  countdown text is hidden on the frame clock so captures match.
- Headless fps (60) is not a device benchmark. Physical phones, real
  gamepads, audible audio output and OS-level tab switching have not been
  verified by the automated checks (emulation and synthetic events only).
- The demo's thresholds (speeds, time limit, camera spans) are starting
  points, not tuned feel. No navmesh or AI.

## Deliberately not included

- A game server or netcode. `platform.lobbies` is the host's matchmaking and
  P2P transport; authority, sync and rollback are the game's (see
  [Online games](#online-games)).
- Analytics/telemetry, backends, dashboards. Use the optional
  [play-stats recipe](analytics.md) to add these at the game boundary.
- The video and capture production kit (trailers, teasers, store art, key art,
  recording scripts) and the headless tuning bot.
- Music and sky images (the music module supports optional tracks; the sky is
  procedural), and web fonts (the UI uses the system font stack; ship an OFL
  font with its licence if you add one).
- A mechanics gym page (see the gym pattern above).

## Lessons kept in the code

| Lesson | Where |
| --- | --- |
| Memory growth detaches views: re-derive every access | `Sim.f32`, the event copy in `runtime.ts` |
| Fresh wasm instance per headless run | this page; `tests/smoke.mjs` uses a fresh profile per pass |
| Draw the interpolated pose; aliasing steps make running stutter | `vgd_engine::interp`, the demo's player record |
| Pick with the stable, unshaken view-projection | `Camera.pickGround`, the demo's `ArenaGame.input` |
| Clamp the visible footprint, not the camera centre | `Camera.clampFocus` |
| Dt = 0 on paused frames must not blow up integrators; lay out explicitly | `Particles.update`, `FixedStep`, the demo's `ArenaArt.drawRunner` |
| Hue-preserving roll-off at the bright end | `post.wgsl` |
| Screen-constant ink, pushed back along the view ray | `common.wgsl` `inkWorldWidth`, `mesh.wgsl`, `model.wgsl` |
| Thin sunlit rim, masked on up-facing surfaces | `mesh.wgsl`, `model.wgsl` |
| Version saved keys instead of migrating stale snapshots | `settings.ts`, the demo's records, `dev/tuning.ts` |
| `[hidden]` must beat component `display` | `style.css` |
| Scope game keys; leave popup/screen keys to the UI; handled events don't leak | `input.ts`, `ui/frontend.ts`, `flow.ts` (`defaultPrevented`) |
| Gamepad A presses the focused button; it doesn't close popups | `Frontend.pollPad` |
| CDP-synthesised Enter doesn't press a focused native button: tests click | `tests/smoke.mjs` |
| Web Audio needs a gesture; touch activation is the end of a tap | `audio.ts`, `Frontend.waitForStart` |
| Dev UI must be unreachable, not just hidden; check the release bundle | `main.ts` (`import.meta.env.DEV`), `vgd:dev-only` markers, smoke + packager |
| Debug outcomes go through the real paths | the demo's `sim_debug_collect_all`, `sim_debug_add_time` |
| Semantic material names make reskins data | `ModelRenderer.recolor`, the demo's gold gem |
| Popup → popup swaps need their own path; closing a card to open another is not a resume | `Frontend.swapPopup`, `Flow.closeQuietly` |
| Delegated clicks: scope selectors (`button[data-close]`) | `Frontend` |
| Capture mouse look during the starting click, preserve it through setup | `Flow.play`, `Input.clear(true)` |
| Closing results must leave a reachable screen | `Flow.popupClosed`, `tests/frontend.mjs` |
| Resume interrupted audio on a user gesture | `AudioBus.unlock` |
| Fullscreen is a platform concern | `platform.toggleFullscreen()` only (CrazyGames forbids custom fullscreen) |
| Measure against a frozen production build | the smoke test serves the packaged build, not the dev server |
| A Cargo glob that matches nothing is an error | `Cargo.toml` members (`[ag]*/**/crate`) |
