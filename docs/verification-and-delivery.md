# Verification and delivery checklist

Record what was actually checked for a specific build. Mark each result
pass/fail/pending and include the input, viewport, browser/device, revision,
and evidence path. Do not treat fixtures, emulation, or a clean inventory as
proof of a different claim.

## Automated browser runs are silent

Headless Chrome still plays sound through the machine's speakers, and a
scripted "click to start" unlocks the game's audio. The person at the machine
hears music and effects with nothing on screen. Always launch test browsers
with `--mute-audio`, e.g.
`agent-browser --session <name> --args "--enable-unsafe-webgpu,--mute-audio" open <url>`
(and add it to any puppeteer or CDP launch args). Close sessions and stop
servers when a run is done, and list tabs before trusting an interaction result.

Stop only processes you started, by PID or by port (`lsof -ti tcp:<port>`),
never by name (`pkill node`, `pkill -f vite`). Other agents share the machine:
a restart script that killed servers by name took down another agent's server
twice. After test loops, sweep orphaned headless browsers. Sixteen left over
from stopped loops, one to seven hours old, each used a full CPU core; stopping
them brought the load average from 21 to 8.

## Build receipt

- [ ] Isolated candidate contains only intended changes; record dirty-source identity when applicable (for uncommitted work, a snapshot commit's hash and parent: the shared-checkout rules in [AGENTS.md](../AGENTS.md)). In a shared checkout, tests, smoke and captures ran there too, on its own port (`git worktree add --detach <dir> <rev>`, or `git archive <rev> | tar -x -C <dir>`, then `npm ci`).
- [ ] `npm run smoke` passed on this candidate; a release ships only after it does: `TBD`
- [ ] Source revision / build hash: `TBD`
- [ ] Build command and timestamp: `TBD`
- [ ] Browser, OS, and target viewport: `TBD`
- [ ] Package path and size: `TBD`
- [ ] Known limitations and open questions: `TBD`

## Actual input and state

- [ ] Start the game with the documented launch path.
- [ ] Use actual keyboard, pointer, or touch input supported by the target.
- [ ] Steer scripted movement with a helper that follows the game's paths or colliders, not key timings (the starter arena's smoke driver steers along an A* route: `addons/starter-arena/tests/route.mjs`). In one game, timed runs broke about six times as props and colliders moved.
- [ ] Reach late states (a boss, an ending) with a fixture, then use real input for the step under test. Keep one full playthrough with real input for release candidates.
- [ ] Complete the intended success path.
- [ ] Exercise failure, recovery, pause, resume, reset, and replay.
- [ ] Exercise relevant transitions, interaction edges, collision, and timing.
- [ ] Close results with Escape/back/gamepad B; verify a reachable next screen.
- [ ] For mouse look, verify capture from the starting click through intro/countdown, skip, resume and restart.
- [ ] Test a second round or equivalent repeated session.
- [ ] Record whether checks used a human, scripted input, or injected fixture.
- [ ] Give each user-reported regression fixed in this build a guard (test, smoke assertion, asset check), or record why it has none; check the decision log's vetoes.

## Visual comparison

This is a gate: a look task is reported done with its comparison sheet and gap
list, or reported as still open.

- [ ] Clear dev overrides before judging. The DEV tuning panel saves its sliders
      per browser and reapplies them on every load (**Defaults** resets them);
      also check URL flags and any game-owned saved look. A forgotten override
      can replace the lighting while the code looks correct.
- [ ] Build a comparison sheet: each mockup beside a runtime frame from the
      camera `docs/brief.md` records for it (position, FOV, aspect, time of
      day). Save it with the evidence; a runtime screenshot alone is not a
      comparison. If the brief records no camera, say so once there, with the
      camera you use instead, rather than hedging every record: in one game
      about a third of the session records repeated that the concept camera
      was unknown.
- [ ] List the gaps that remain, per frame (silhouette, palette, lighting,
      materials, effects, UI). An empty list is a claim to check, not a default.
- [ ] For a look change, keep the baseline running: a second Git worktree of
      the base revision (`git worktree add ../<game>-base main`, then `npm ci`)
      served with `npm run dev -- --port 5175`. Review live, then hand over a
      synchronized side-by-side or slider video.
- [ ] Check actor/object silhouette, scale, pose, attachments, lighting, and readability.
- [ ] Check camera framing at the center, edges, corners, and smaller levels.
- [ ] Check world prompts and HUD for overlap with actors and objectives.
- [ ] Wait for motion to settle before capture; record any transition defects.
- [ ] Keep UI criteria aligned with the canonical [game UI reference](../.agents/skills/blender-wasm-webgpu/references/game-ui-design.md).

## Loading screen and UI motion

- [ ] Check the loading screen on a production build served under the host's
      nested path, with the network throttled and the cache off. In one game
      the cause of a blank preloader showed only that way (3 MB/s, no cache):
      its styled screen arrived with the game's code chunk.
- [ ] Check that nothing moves when the game becomes ready, unless the
      [front-end storyboard](collaborative-game-pipeline.md#front-end-flow)
      asks for it. For example, the start prompt takes the loading bar's slot.
- [ ] Verify UI animation timing with a per-frame trace, not screenshots. Log
      the relevant classes and computed `opacity`/`transform` on every
      `requestAnimationFrame` from the press onward. Capture latency made one
      slide look already finished in screenshots.

## Desktop and touch composition

- [ ] Test the host's actual iframe sizes at DPR 1, including medium and short landscape; source/date the matrix.
- [ ] Recheck affected screens after wording changes and with two transient messages visible at once.
- [ ] Add each new overlay, notice or dev control to the overlap check (`npm run test:frontend`) in the change that adds it, and keep it inside the viewport. In one game, HUD and overlay collisions took 11 fixes, and one fix itself overflowed the viewport.
- [ ] Review desktop with a fine pointer and the intended keyboard hints.
- [ ] Review touch with thumb-reachable controls, safe areas, and usable hit targets.
- [ ] Check short landscape, rotation, hybrid input, pointer cancellation, and simultaneous move/action where relevant.
- [ ] Verify camera and HUD are composed for each mode; responsive shrinking alone is not evidence.
- [ ] Distinguish desktop emulation from physical-device testing in the record.

## Audio lifecycle

- [ ] Confirm first-gesture audio unlock and saved mute/volume behavior.
- [ ] Confirm optional music loading does not block Play.
- [ ] Confirm pause, menu, rematch, and teardown do not stack or leak sources.
- [ ] Check audio recovery after interruptions on the next gesture; a fake context does not establish physical iOS behavior.
- [ ] Confirm background-tab behavior follows the game's pause/audio policy.
- [ ] Confirm state-driven music transitions and audible gameplay effects.
- [ ] Record browser autoplay and device limitations separately from game logic.

## Package and nested assets

- [ ] Inspect the final package contents, including nested asset directories.
- [ ] Confirm every referenced GLB, texture, font, audio file, manifest, and WASM module is present.
- [ ] Check paths and case sensitivity from the packaged location.
- [ ] Serve the build under a nested URL prefix and exercise deferred asset loads; root-only startup can hide absolute-path failures.
- [ ] Confirm review-only sources, caches, credentials, and unrelated generated output are excluded.
- [ ] Load the package from its intended local server or launch path.
- [ ] Record an asset inventory and content hashes, including deferred audio; verify the uploaded directory still matches the reviewed bytes.

## Hosted validation (separate gate)

- [ ] Record host, URL, deployment revision, and timestamp.
- [ ] Verify the hosted package independently from local success.
- [ ] Check asset paths, MIME/CORS behavior, WASM loading, audio, and refresh/deep-link behavior.
- [ ] Record the tested browser/device and any host-specific limitation.
- [ ] Record external tester access and telemetry ingestion separately; owner access and upload success do not establish either.

## Analytics questions

Use the optional [play-stats recipe](analytics.md). Analytics should answer a product question. Before adding them,
record:

- What decision will this event inform? `TBD`
- What minimum fields are needed? `TBD`
- Is consent, privacy, or retention policy required? `TBD`
- Can the question be answered by local playtest notes instead? `TBD`
- How will events be disabled in development and verified in production? `TBD`

Do not claim a retention, engagement, or balance result until the collection
window, sample, and analysis are defined and the data has actually arrived.
