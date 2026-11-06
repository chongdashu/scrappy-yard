# Optional play-stats recipe

Add telemetry when there is a product question to answer. Keep its recorder,
event vocabulary, configuration and backend in the game, outside the engine.
This is a recipe, not an installed service: the blank starter sends no analytics.
Never inherit a source game's endpoint, deployment, administrator key or player IDs.

Test fixtures, rigs and examples use a placeholder endpoint (for example
`https://analytics.example.invalid`), never the production deployment URL. A
test rig that hard-codes the live URL can send test traffic to production, and
it travels with every fork. Keep live identifiers (backend deployment name and
URL, platform game IDs, hosting project IDs) in a small, listed set of config
files, such as `deploy/release.json`, `wavedash.toml` and
`deploy/web/project.json`, so a fork or public share can neutralize them in one
place. Search the tree for the deployment name before sharing it.

## Measure whether play was possible first

A Closing Time sample had 14 page loads, seven sessions that started a round,
and six terminal graphics failures. Median active playtime was 1.9 seconds over
all loads but 40 seconds among sessions that reached a round. This small historical
sample diagnosed access failures; it did not establish long-term retention.

Instrument before graphics/WASM initialization if failed loads are in the question.
An observer installed only in `Game.load()` never sees a renderer that failed
before that call. A game's entry module may install a lightweight observer before
`create()`; keep boot/error reporting independent of loaded models or a working GPU.
`__game.graphics()` exists after successful boot. Record a recovered backend
fallback separately from a terminal error; avoid a second adapter request merely
to guess why the original attempt failed.

Start with a small event contract, adapting names and props to the game:

| Event | Boundary | Useful fields |
| --- | --- | --- |
| page_load | recorder starts | build, channel, test flag |
| title_shown | usable start screen | elapsed load ms |
| graphics_ready | renderer selected | backend, fallback stage, HDR/bloom |
| load_error | terminal failure | stable reason code, before/after title |
| start_click | actual activation | input mode, coarse layout class |
| round_start | controllable gameplay | mission, attempt |
| first_action | first meaningful mechanic | time since round start |
| round_end | win, loss or quit | mission, outcome, active seconds |
| feature_open / feature_used | actual feature transition | feature ID |
| session_end | pagehide / best-effort final flush | last screen, active seconds |

Create the game's Events table at the same time as the recorder. Add a coverage
check comparing literal event calls (or a shared typed event catalog) with that
table in both directions. If events are dynamically named, declare the finite
set explicitly. Do not silently add telemetry as a side effect of a UI change:
when telemetry is enabled, update its event contract alongside reachable features.

Emit a feature event from the code that opens the feature. In one game, global
click and Tab listeners that checked a panel's `.hidden` afterwards missed real
opens. The fix moved each event into the panel's own handler, with a browser
test that opens the panel and waits for its event.

## Define denominators and clocks

- Give every funnel step an explicit parent. A second attempt follows a first
  attempt, even when the first was lost; dividing by wins can produce over 100%.
- Count sessions reaching a step once; keep attempt counts in a separate metric.
- Show all page loads, sessions that played, and feature-eligible sessions
  separately. Report the sample and window beside percentages and medians.
- Active playtime excludes loading, menus, pause and hidden time. A missing final
  beacon is an incomplete session, not proof of a particular exit screen.
- A completed session stays completed. Lifecycle events that arrive after
  `session_end` (network teardown, a late visibility change) must not clear or
  reopen it; only an explicit resume does. Keep raw events, so summaries can be
  rebuilt when this logic changes: one game rebuilt five session summaries from
  retained events after fixing it.
- Retention uses mature cohorts: do not count a player as a D7 non-returner before
  their seven-day window is over. Keep acquisition channels separate from
  untagged repeat visits. Tags on a host page may not reach the embedded game.
- Choose the returning-player key before launch. A per-page session ID cannot
  see a return, and a host that clears local storage on each update (Wavedash
  does) resets a browser-stored ID. Key retention on the server-verified
  platform identity (Online games, below), and build cohort aggregates before
  the raw-event expiry deletes their inputs. One game kept raw events for 30
  days, built no aggregate, and never measured retention.
- Validate aggregates on representative recorded sessions, with credentials and
  personal data removed, as well as synthetic edge cases. Model evaluations of
  a design are not observed player behavior.

## Online games: the server reports play

When a game server owns the rules, it emits the gameplay events: joins and
leaves, accepted inputs, combat results, shared-world milestones and connection
loss. The browser keeps boot, UI, clocks and exit screens. Server events go
through their own route with a server-only secret, so the public browser
endpoint cannot forge them. Deploying the server is in
[release.md](release.md#your-own-game-server).

- The server sets the player ID: an HMAC of the verified platform identity,
  with the key kept on the server. Rotating the key renames every player and
  breaks continuity across the rotation.
- A verified identity can be anonymous (Wavedash issues guest identities), so
  distinct IDs are pseudonymous players, not registered accounts or distinct
  people.
- For joined sessions, the server's traffic classification wins over the
  browser's.
- Count a shared-world milestone (a gate falls, a round is won) among the
  players who were eligible when they joined, that is, who joined before it.
  Report players who arrived after it separately. A milestone recorded for
  every connected player does not mean each one delivered it.
- Leave AI teammates and bots out of player counts and credits.

## Keep the recorder bounded and controllable

Gate collection on the game's configuration, player choice and host policy
(`platform.ownAnalytics`). Decide notice/consent and retention policy for this
game instead of copying another game's default. Development, capture, smoke and
other automation should stay silent unless explicitly enabled as test traffic.
Provide a way to remove test traffic from production reports.

Hosts may strip query strings before loading the game iframe: a `?analytics=test`
flag vanished on one portal's playtest. Classify test traffic from the host's
environment identity instead (a playtest or non-production environment reported
by its SDK), read locally and kept out of event payloads. To exclude a known
test session, mark it excluded with a correction record. Do not delete its
events.

That identity can arrive after the first events. Hold boot events in memory
until host storage and the identity are both in, with a cap (one game waited
up to 10 seconds), then classify the session. A session keeps the class it got
first, even if a live identity appears later, and a session that cannot be
identified is not live. When live traffic has its own
deployment, make that deployment fail closed too: it refuses any batch that is
not live traffic from the expected channel, so an old or misconfigured client
cannot write into it. Two test sessions reached one game's production
deployment before it had that check.

Use capped batches, field validation, bounded queues and a best-effort final
flush. A public ingest endpoint accepts untrusted input; enforce server-side
limits too. Collect stable error codes instead of raw stacks, full URLs or typed
text. Keep administrator credentials out of browser-exposed `VITE_` variables.
The web smoke harness fails on requests leaving its local origin, helping catch
accidental telemetry during automation.

## Release and verify the measurement

Use the packager's existing `import.meta.env.VITE_BUILD_ID` alongside
`GAME.version` for session labels. The receipt includes commit identity and a
`-d<hash>` suffix for uncommitted source. Dev builds need an explicit dev label;
a game version alone cannot distinguish two previews.

When backend schemas or aggregators change, deploy the compatible backend first,
refresh/recompute derived aggregates, then ship the client. Name the backend
target explicitly so another project's local environment cannot select it.
Deployment still requires the user's authorization; reuse authorization already
given for that release.

Check an arriving session against the shipped build label and expected events.
Verify the report actually counts them: successful ingestion alone does not prove
a new feature appears in the funnel. Old games should continue working with the
new backend. For derived-data changes, compare totals and breakdowns after refresh
so mixed old/new aggregate formats cannot silently contradict each other.

Check the traffic classification before the first public publish, once per
class: a playtest session lands in development, automation sends nothing, and
a live session reaches production. A host may issue the live environment ID
only at the first publish, which adds a publish cycle (Wavedash in
[host notes](release.md#host-notes)). In one game the live/test split, the
production refusal and the live ID were all added in the quarter hour around
the first publication.

## Reading the numbers

Give the game one report command that takes a traffic class, a window in days
and an optional build label, and selects the matching deployment itself, so
development numbers cannot be read as live ones. Print the class, window and
build with the result. A report that reads at most a fixed number of events
returns a `truncated` flag when it hits the limit; narrow the window rather than
quote a partial count. Keep client and server build labels in separate fields:
a client and a server from different commits can be compatible, and one label
cannot say which build produced an event.

A KPI view inside the dev build is optional. If it reads a private report, put
it behind a dev-server bridge that accepts only loopback, same-origin requests
carrying a custom header, runs the query with the developer's own CLI login,
never sends an admin key to the browser, and never ships (the panel behind
`import.meta.env.DEV` with the `vgd:dev-only` marker, the bridge only in the
dev server).

Before a record says a build was measured, commit the report it rests on: an
aggregate-only snapshot with window, traffic class, build, the `truncated` flag
and the counts. In one game every deployment receipt said analytics was
verified, and none of the committed files said how many people had played.
