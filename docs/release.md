# Release pipeline and platform layer

This page covers publishing a game build. For versioned releases of this
template repository, see [template releases](template-releases.md).

One build pipeline, one package per host. Each package is built once, checked,
hashed and frozen under `release/<target>/`; deploy scripts re-hash it before
uploading, and record what went live in `deploy/<target>/deployment.json`.

| Target | Adapter (`VITE_PLATFORM`) | Upload | Host |
| --- | --- | --- | --- |
| `web` | `web` | `release/web` + `vercel.json` | your static host (Vercel scripted) |
| `wavedash` | `wavedash` | `release/wavedash` | Wavedash (`wavedash build push`) |
| `crazygames` | `crazygames` | `release/crazygames` + a timestamped zip beside it | CrazyGames Developer Portal (manual upload) |

Everything packages the **active game** (`game.config.json` `"gameDir"`, or
`GAME_DIR` for one command; see [starter.md](starter.md#the-active-game)).
Rules live in two files: the game's `<gameDir>/game.json` (`id` names builds
and the local release server's prefix; `title` goes in receipts;
`storagePrefix` prefixes every saved key; `release.assets` is the public asset
allowlist over `<gameDir>/public/`) and the engine-wide `deploy/release.json`
(targets, preflight, prebuild, forbidden strings).

## Commands

```sh
npm run package:web                  # → release/web (+ vercel.json), manifest release/web-manifest.json
npm run package:wavedash             # → release/wavedash
npm run package:crazygames           # → release/crazygames + release/<time>-crazygames-<build>.zip, no ads
npm run package:crazygames -- --ads  # the same with the ads adapter on (Full Launch only)
npm run serve:release -- web         # http://127.0.0.1:5190/builds/<game id>/ ; misses at /__misses
npm run deploy:web [-- --preview]    # verify, deploy to Vercel, record deploy/web/deployment.json
npm run wavedash:push -- -m "What changed"        # verify, upload an unpublished build, record it (package first)
npm run wavedash:publish -- <BUILD_ID> --title "v1.0" --summary "..."   # make a reviewed build live
npm run test:release                 # the packager's own checks, against a fixture (node --test)
GAME_DIR=addons/starter-arena npm run package:web   # package another game (here the demo add-on)
```

Packaging steps: `preflight` → `prebuild` (the active game's wasm) → Vite build
of `index.html` only, with the active game's `@game` alias, identity and title
→ stage → checks → sha256 manifest → swap into `release/<target>/`. The
manifest records `gameId` and `gameDir`.

`deploy:web` and `wavedash:push` upload the package that is already in
`release/<target>`; they do not build. They refuse a package made from other
source than the current tree (the build id differs), so run `package:<target>`
first; `--allow-stale` uploads an older package on purpose. A release build
shows its build id at the bottom of Settings, which is how to check that the
build you published is the one being served.

Target values supplied from the shell (`{ "fromEnv": "NAME" }`) are checked
the same way: keep each one set as it was for packaging when you upload. The
upload compares them with the package manifest, because the commit stays the
same when only the shell changes: a package built for a playtest server must
not go out to production under a fresh message.

## Release lane

Publish every host build from one lane: the main branch, packaged from a
detached worktree or export of the intended commit. A second lane drifts. In
one game the public build lived on a release branch that lacked features
already on main. Later, a concurrent publish from another session went live
without the analytics client the previous build had shipped, and the next build
had to merge both.

Before publishing, check that the live build's source commit is an ancestor of
the candidate:

```sh
git merge-base --is-ancestor <live commit> <candidate commit> && echo ok
```

Read the live commit from the host (the build id in the live build's Settings,
`<game id>-<commit>`) or from a receipt you know is current. A non-zero exit
means the candidate lacks commits that are live: merge them and package again.

## `release.assets` (in the game's `game.json`)

Globs over `<gameDir>/public/` (`*` within a segment, `**` across). Only
matches ship, and a glob matching nothing fails the package (naming the
`game.json`). The blank game ships `favicon.svg` and `wasm/*.wasm`; the demo
add-on adds `assets/demo/**`. A target can add globs with
`targets.<name>.assets` in `deploy/release.json`.

## `deploy/release.json`

| Field | Meaning |
| --- | --- |
| `entry` | The one page that ships (`index.html`). |
| `targets.<name>.env` | `VITE_*` values baked into that build. A value is a string or `{ "fromEnv": "NAME", "optional": true }`, read from the shell. `.env` files are ignored by release builds. |
| `targets.<name>.forbidden` | Strings no file in that package may contain (plus the global `forbidden`). |
| `targets.<name>.vercel` / `.zip` | Write `vercel.json` / zip the upload directory. |
| `targets.<name>.publicUrl` | The stable public page, copied into receipts. |
| `preflight` | Gates run before anything is built: `{ "name", "run": [cmd, ...args], "why"?, "targets"? }`. A non-zero exit stops the release. |
| `prebuild` | Commands that produce build inputs (the WASM module). |
| `maxFileBytes`, `devMarker`, `runtimeExtensions`, `sourcePaths` | Per-file cap, dev-only marker string, file types allowed to ship, engine paths the build id covers (the active game's whole folder is always added). A `runtimeExtensions` list replaces the default types (`DEFAULT_RUNTIME_EXTENSIONS` in `scripts/lib/package-game.mjs`, which includes `txt` for a font's licence) rather than adding to them. |

`assets` and `publicDir` are refused here: they belong to the game.

A new host target is an entry here, an adapter in `src/platform/`, and a
one-line `scripts/package-<name>.mjs`.

## What each check catches

| Check | Catches | Why it exists |
| --- | --- | --- |
| Vite build with `configFile: false`, `index.html` as the only input | Dev pages (`preview.html`, gyms) and dev-server plugins in the release | The dev config builds several pages; only the game ships. |
| `envDir: false` | A developer's `.env.local` values (dev endpoints, keys) baked into a release | Release values come from `deploy/release.json` alone. |
| Build id `<id>-<commit>[-d<hash>]` in `VITE_BUILD_ID` | Releases that can't be traced to source | The `-d` hash covers the current bytes of uncommitted files in `sourcePaths` and the active game's folder, so a package built from a dirty tree says so and two different dirty trees get different ids. |
| Public-asset allowlist; a glob matching nothing fails | Review files, source art and inspectors shipping; a renamed asset silently dropped | A bundler's default public-directory copy ships everything. |
| Runtime file types only; no dotfiles, `..`, symlinks | `.blend`, notes, credentials, links out of the tree | |
| Root-absolute references in HTML fail; missing HTML dependencies fail | `src="/assets/…"` | Works at an origin root, breaks on hosts that serve each build under a nested path (Wavedash, CrazyGames). |
| Root-absolute runtime paths in JS/CSS fail (`"/assets/`, `/wasm/`, `/fonts/` and every top-level package directory) | A `fetch("/wasm/…")` or `url(/fonts/…)` | Same failure, found only after upload. |
| Per-file size cap (default 25 MiB) | Oversized files | Static hosts and portals cap file sizes. |
| Dev-only marker `vgd:dev-only` anywhere in the package | Tuning/debug panels in a release | In the source game a "hidden" dev menu stayed reachable by keyboard and gamepad; portals reject debug UI. Dev panels live behind `import.meta.env.DEV` and carry the marker, so the release must not contain it at all. |
| Per-target forbidden strings | Another host's SDK left in a bundle; the Fullscreen API in the CrazyGames build | Proves the adapter selection folded (see below) and enforces host rules mechanically. |
| sha256 manifest beside (not inside) the upload; `verifyPackage()` before every deploy | Files changed between review and upload | Other sessions or tools may touch `release/` after packaging; the uploaded bytes must be the reviewed bytes. |
| Staged build, then swap | A failed package replacing the last good one | Checks run on the staging copy; `release/<target>` changes only when all pass. |
| `vercel.json`: only Vite-fingerprinted `assets/*-<hash>.*` immutable | A year-long cache on fixed-name models, audio or WASM | Fixed names revalidate; hashed names never change content. |

## Preflight: what must be true before a client ships

`preflight` is where release-order rules go. The source game lost a release's
worth of analytics: a client that sent a new event field went live while the
production backend's schema still rejected it; every batch got a 400 and the
client dropped it. Nothing visible failed. A rule like "the analytics backend is
deployed before this client" belongs here as a command that exits non-zero
until it is true, for example:

```json
{ "name": "analytics-backend-first", "why": "the backend must accept this client's events", "run": ["node", "scripts/check-analytics-schema.mjs"], "targets": ["web", "wavedash"] }
```

The starter's preflight runs the typecheck, the Vitest suites (`npm run
test:game`, which first builds this source's `sim.wasm`, so the ABI suites
test it rather than skip) and `cargo test`: seconds on a warm cache, on
every package, so no package exists that failed them. Other good steps: a
clean tree for production builds, a backend that is already deployed. Steps
get `RELEASE_TARGET` in their environment. Edit the list to change them.

Smoke cannot be a preflight step: it packages the web target itself, so it
would run inside its own packaging (packaging refuses to start inside a step
rather than recurse). Uploads check it instead. A full `npm run smoke` (both
renderers and sessions) that passes records `release/web-smoke.json` with the
source build id it played; every run first removes the last record, so a
failed or partial run leaves none. `deploy:web` and `wavedash:push` refuse a
package whose build id has no passing run. In one game smoke was broken for
12 hours while four builds shipped. Smoke plays the web package; the Wavedash
package is the same source with another adapter, so the match is on the
source, not the bytes. `--skip-smoke-check` uploads without it once;
`"requireSmoke": false` turns it off. CrazyGames uploads are manual: run
smoke on the same commit before submitting the zip.

## Receipts

Deploy scripts write `deploy/<target>/deployment.json` only after the host
reports success; a failed command records nothing, and Vercel previews are
printed rather than recorded. The starter ships no receipts. Commit your own:
they are the "what's live" record (release id, build id, commit, dirty flag,
file count and bytes, URLs, and for Wavedash the build id and playtest URL of
the latest upload and the live build). CrazyGames uploads are manual: when a
zip goes live, record its name, build id and commit in
`deploy/crazygames/deployment.json` by hand.

Name each identifier by its kind in receipts, reports and handoffs. One release
has several, and two records in one game logged an "unresolved release ID
conflict" that was two different kinds compared:

| Kind | Where it appears |
| --- | --- |
| Package (content) id | `releaseId` in the manifest and receipts: a hash of the shipped files |
| Source build id | `VITE_BUILD_ID`, `<game id>-<commit>[-d<hash>]`: Settings, `buildId` in the Vercel receipt, `buildLabel` in the Wavedash receipt |
| Host build id | the host's id for an upload: `latestUpload.buildId` and `liveBuild.buildId` in the Wavedash receipt, the argument to `wavedash:publish` |
| Host publication id | the host's id for making a build live, where it reports one. The scripts do not record it; add it by hand under that name |

`buildId` means the source build id in the Vercel receipt and the host's
build id in the Wavedash receipt.

Host identity is configuration, never code:
- Vercel: `deploy/<target>/project.json` (copy `deploy/web/project.example.json`;
  `vercel project inspect` shows the ids) or `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`
  (optional `VERCEL_SCOPE`, `VERCEL_DOMAIN`). Without ids the CLI would link or
  create a project by itself, so the script refuses.
- Wavedash: `wavedash.toml` (copy `wavedash.toml.example`; `wavedash project create`
  prints the `game_id`). `upload_dir` must be `./release/wavedash`.

Deploy scripts refuse to run under a test harness (`node --test`, Vitest).

## Local check under a nested path

`npm run serve:release -- <target> [--port 5190] [--isolated]` serves the frozen
package at `/builds/<game id>/` with `Cache-Control: no-store` and logs every
404 to the console and `/__misses`. A root-only server hides absolute-path bugs.
Play past the title screen: deferred loads (music, later levels) count.
`--isolated` adds COOP/COEP headers, an approximation of a cross-origin-isolated
host iframe, so third-party resources without CORP/CORS fail locally too. This
proves routing and MIME types, not the host: check the hosted build separately
(see `docs/verification-and-delivery.md`).

## A separate release shell

The packager ships one `index.html`. If a game adds its own public shell (a
different start screen or entry module, selected by `VITE_PLATFORM` or a flag),
keep one frame and draw path, and put what both entries show in shared modules
rather than copies. Give the shell a dev command (`npm run dev:<shell>`), and
run the release browser test on that entry at the host's frame sizes. In one
game the public shell drew the play scene without the frame's `dt`, so other
players slid instead of walking, and features added to the dev entry were
missing from the public build until they moved into shared modules. The release
test on that entry caught a HUD overlap on short touch screens.

## Your own game server

A game that runs its own server (a multiplayer room, a reward ledger) has a
second deploy, which the packager neither builds nor checks.
[Online games](starter.md#online-games) covers the client side.

- Refuse to start without the required configuration. A production server
  missing the host's environment ID, its auth mode or a mounted persistent
  volume should exit, not start in guest mode or keep its world on a disk that
  a redeploy erases.
- Serve `/health` with the build label, protocol version and auth mode, and
  true/false for "environment ID set" and "volume attached", never the values.
  Check it after every deploy. Set the build label yourself where the host
  supplies a commit only for Git-triggered deploys (Railway does).
- Add a read-only status endpoint, which takes no seat, for the authoritative
  state players report on: round, objective, a boss's position, phase and
  health, connected players with bots marked. In one game the developer found
  the boss gone from its courtyard and the round not restarting; the boss's live
  location "was not available", and the cause was found only by reproducing it
  in simulation.
- Keep a server receipt per environment, separate from the client's. Client and
  server commits can differ while the protocol matches, so record both commits
  and the protocol version.
- Before calling a release verified, play one full round on the hosted build,
  through to the start of the next round, with two accounts. That missing-boss
  report took four user messages, and even the fix's release record says "The
  hosted boss defeat and next-round cycle … were not verified".

Railway examples:
- Railway's infrastructure-as-code is diffed against the live environment, so
  applying it removes a variable set in the dashboard or CLI that the code does
  not declare. Declare each such variable with `preserve()`, which keeps the
  value Railway holds and keeps secrets out of the repository.
- `railway up` uploads the working tree. Give it a `.railwayignore` that
  matches the Docker build context, so it sends the server's files instead of
  the whole game.

## Platform layer (`src/platform/`)

Game code imports only `platform` (and helpers) from `src/platform`:

- `init()` (await before reading any save), `loading(0..1)`, `ready()`, `failed()`
- `gameplayStart()` / `gameplayStop()`: real play vs menus, results, pause (not focus loss)
- `celebrate()`, `storage` (read at use time), `hostMuted` / `onHostMute()`
- `ownFullscreen` / `toggleFullscreen()`: the only place the Fullscreen API is used
- `canShowAd(kind)` / `showAd(kind, hooks)`; `ownAnalytics`
- Optional host services, undefined where the host lacks them: `stats`, `boards`, `paid`, `lobbies` (with `lobbies.p2p`), `flush()`, `reportProgress()`
- `storageKey(name, version)` → `<storagePrefix>:<name>:v<version>`; use it for every persisted key

Release builds define `VITE_PLATFORM` (and `VITE_PLATFORM_ADS`); the selection in
`src/platform/index.ts` then folds to one adapter and the others are dropped.
The forbidden strings check it: the web package may not contain
`sdk.crazygames.com` or Wavedash's `updateLoadProgressZeroToOne`, and so on. In
dev, `?platform=web|wavedash|crazygames` picks one (`&ads` for CrazyGames'
local placeholder ads); otherwise Wavedash when its SDK is injected, else web.

`src/save.ts` `VersionedSave<T>`: a versioned key, `fresh()`, a `sanitize` hook
for everything loaded, an optional `migrate` hook from older versions, storage
from `platform.storage`, and a try/catch around every read and write (private
windows, blocked storage and corrupt JSON fall back to `fresh()`).

## Host notes

**Wavedash**
- Each build is served from its own origin and nested path: every URL must be
  relative (the packager checks), and localStorage starts empty after each
  update. The adapter mirrors every `storagePrefix` key to the player's Wavedash
  cloud storage (`cloud-save.ts`): restored in `init()`; nothing uploads until
  the cloud has been read, so a slow or failed read never overwrites a real
  save. Without this, every release reset every player's progress in the source
  game, and only the analytics showed it.
- The SDK is injected as `window.Wavedash`; do not import the npm SDK (it throws
  without the global). `ready()` calls `init()` (reveals the game); `failed()`
  calls `loadComplete()` so the game's own error card is visible.
- Games run in a cross-origin-isolated iframe: self-host fonts and other
  third-party resources.
- Fullscreen: the adapter keeps the web behaviour (the element Fullscreen API,
  offered only when the iframe allows it). Wavedash's SDK has its own fullscreen
  control (docs.wavedash.com/sdk/fullscreen); it is not wired here.
- Uploads are immutable and unpublished; use the playtest URL the CLI returns.
  `publish` refuses until the Developer Portal listing is complete. Headless
  Chrome may not advance frames inside the Wavedash page; verify playtests in a
  visible browser.
- The production game cloud ID (the gameplay token's `gcid`) appeared only
  after the first publish, in the live game's public configuration. Until it is
  set, a server that checks `gcid` keeps the production world closed and the
  client classifies no session as live. Plan an extra cycle: publish, read the
  production ID, set it on the server and in the client's live classification,
  package and publish again, then confirm a live session in the production
  report.
- If the game server keeps player names, record each name's source (generated,
  host or custom) from the first write. The host username can arrive after the
  profile exists, and without the marker the server cannot tell a generated
  name it may replace from one the player chose. In one game, profiles written
  before the marker kept their generated names in the public build until the
  server learned to recognise its own defaults.
- A landing page can embed the published game (an iframe on
  `https://wavedash.com/embed/games/<slug>/play`). The embed shows only the
  published build and is a 404 page until the first publish, so make the
  landing deploy refuse while it returns 404. Headless browsers have been shown
  "unavailable in this frame" there: check play in a signed-in, visible
  browser, and record what that check left out (joining from the page,
  fullscreen, sound, touch, guest play).

**CrazyGames** (rules as documented at docs.crazygames.com; recheck before submitting)
- The adapter loads SDK v3 itself, so only this build fetches it; outside
  CrazyGames (`environment: "disabled"`) it stays inert.
- Custom fullscreen buttons are prohibited: `ownFullscreen` is false and the
  package may not contain `requestFullscreen`. Route fullscreen through
  `platform.toggleFullscreen()`; a direct call fails this package.
- First-party analytics collecting more than the SDK does needs a privacy
  notice: `ownAnalytics` is false; add the analytics endpoint's host to this
  target's `forbidden` if the game gains one.
- Ads only through the SDK. Basic Launch disables them: build without ads, and
  `--ads` for Full Launch. A no-fill carries on; ad-block or
  `adsDisabledBasicLaunch` errors turn offers off for the visit. Show an offer
  only when `canShowAd()` is true: no dead reward buttons.
- `gameplayStart` when play starts or resumes, `gameplayStop` on menus,
  results and pause; the host's mute setting wins over the game's.
- Saves use the Data module (select it in the submission form), falling back
  to localStorage.
- No debug UI, relative paths only, and size and file-count limits on the
  initial download; the upload is the zip beside `release/crazygames`.

**Your own static host (Vercel)**
- The package is static; `vercel.json` sets the cache headers.
  `deploy-vercel.mjs` removes `.vercel/` droppings before and after upload.
- WebGPU needs a secure context: HTTPS in production.
- A custom domain has five separate facts; check and record each one.
  Authoritative and public DNS (`dig @<authoritative server>`, `dig @1.1.1.1`).
  The local resolver, which can hold a negative cached answer from before the
  records existed. TLS and HTTP, through a resolve override that keeps
  certificate verification (`curl --resolve <host>:443:<ip> https://<host>/`,
  never `-k`). The host's domain status. Which app deploy the domain serves. A
  browser's `ERR_NAME_NOT_RESOLVED` while public DNS answers is the local
  cache, not the records, and a working override does not mean the cache has
  cleared.

## Optional host services

The platform contract offers optional `stats`, `boards`, `paid`, `lobbies`,
`flush()` and `reportProgress()` capabilities. The Wavedash adapter queues stats/achievements
until accepted, retries with a bound, resolves board names to IDs, and clamps
score metadata. `setStat(id, value)` replaces an absolute value; use
`{ keepHighest: true }` for lifetime totals/records. This merge is not suitable
for balances or resettable progress. `store()` asks the host to persist accepted
writes; a queued write is not a server receipt. Configure identifiers for this
game in the host before using them.

Paid content and P2P are off by default; a game turns them on in its own
`game.json`, `"platform": { "wavedash": { "paidContent": true, "p2p": true } }`
([starter.md](starter.md#gamejson) has the fields), never by editing
`src/platform/`. The setting is validated when the game is loaded (an unknown
key or out-of-range value fails dev, tests and packaging alike) and bundled
with the game's identity; there is no other packaging change, since the web and
CrazyGames packages drop the Wavedash adapter either way. Lobbies need no
opt-in: nothing reaches the host until the game calls `platform.lobbies`, and a
lobby should be created on a player action (Quickplay), never at boot, or it
stays listed while the player idles. `p2p: true` passes the SDK's defaults to
`init()`; `{ messageSize, maxIncomingMessages }` sets the slot size (45..65536
bytes, header included) and per-channel queue to the game's largest message and
send rate. Lobby chat is capped at 500 characters, so game state goes over P2P.
Two tabs in one browser share one user id and are never peers: test with two
accounts, and check P2P on the hosted build between two players, since the fake
SDK does not reach WebRTC.

Turn on `paidContent` only once the game has its own approved offer/catalog;
no catalog, sync script, payment
account or purchase UI is supplied. Missing services should have game-defined
fallbacks. `flush()` can send a pending cloud save, but a local reset/navigation
must not wait for a slow upload. Unit coverage uses a fake SDK; validate live
host services separately before shipping them.

Use the [CrazyGames skill](../.agents/skills/crazygames/SKILL.md) for current
launch requirements, actual portal frame sizes, SDK/input checks and submission
materials. A packaged ZIP is not evidence of portal acceptance. The blank
starter's title-plus-menu flow needs adaptation for Full Launch's entry flow.

For games with telemetry, follow the [play-stats recipe](analytics.md): backend
first, derived-data refresh, client release, then verify the arriving build label
and traffic class.
