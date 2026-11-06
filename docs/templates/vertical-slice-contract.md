# Reusable vertical-slice contract

Use this as a compact agreement for one playable level or round. It is a
template: values below are fields to decide and verify, not default game rules.
Mark each item **proposed**, **measured**, or **accepted** and link evidence.

## Scope and ownership

| Field | Value / status |
| --- | --- |
| Slice name and version | TBD |
| Player role(s) | TBD |
| Complete loop | Start → play → win/lose → replay (proposed) |
| Target devices and viewports | TBD |
| Open decisions | TBD |

| Owner | Owns | Handoff / evidence |
| --- | --- | --- |
| Gameplay | Simulation, input contract, rules, tests | TBD |
| Art/animation | Source files, exports, clips, visual checks | TBD |
| Environment | Layout, props, collision markers | TBD |
| Root/integration | Renderer, UI, audio, package, browser checks | TBD |
| Review/capture | Actual captures, findings, build receipt | TBD |

## Runtime contract

Declare which system owns each value and the update model. Example fields:

| Concern | Contract | Status / evidence |
| --- | --- | --- |
| Simulation authority | TBD | Proposed |
| Render/input responsibilities | TBD | Proposed |
| Time step and pause behavior | TBD | Proposed |
| Coordinate system and yaw | TBD | Proposed |
| Level/layout schema | TBD | Proposed |
| State phases | TBD | Proposed |
| Input shape and edge semantics | TBD | Proposed |
| Snapshot/event shape | TBD | Proposed |

Keep layout, collision, spawn, interaction, and presentation data from drifting
into separate undocumented maps. Record version and migration decisions when a
field changes.

## Game rules

Describe the smallest rule set that proves the loop. Mark initial tuning as
proposed, then measure and revise it through the blockout.

| Rule | Value | State |
| --- | --- | --- |
| Goal and success condition | TBD | Proposed |
| Floor plan, in metres: route length, path widths, objective spacing against attack ranges | TBD (link the plan) | Proposed |
| Failure and recovery | TBD | Proposed |
| Round/session timing | TBD | Proposed |
| Interaction range and timing | TBD | Proposed |
| Movement/collision behavior | TBD | Proposed |
| Bot or opponent behavior | TBD / N/A | Proposed |
| Replay/reset behavior | TBD | Proposed |

## Asset interface

List only assets needed for this slice and link the detailed contract:

| Asset ID | Source/export path | Required materials/clips | Sockets/collider | Status |
| --- | --- | --- | --- | --- |
| TBD | TBD | TBD | TBD | Proposed |

All clips, dimensions, axes, pivots, attachment policies, and hashes must agree
with [the asset contract](asset-contract.md). Preserve known-good source files;
record deliberate replacements and their reason.

## Acceptance checks

The slice is ready for review when a real player can start, understand the
current goal, complete or fail the loop, and replay it. Check:

- representative asset export, reimport, and runtime load;
- real keyboard/pointer/touch input where supported;
- collision, interaction, failure, recovery, pause, and reset;
- every spawn, by test: collider clearance for the player's radius, facing
  into play, and a clear camera line of sight to the player;
- every gameplay-critical exit, route or vehicle reachable from every spawn,
  asserted by a test and never derived from decorative randomness;
- every intended outcome and at least one consecutive replay;
- animation and attachment timing against authoritative game state;
- camera and UI composition at desktop, touch, and short-landscape sizes;
- packaged build and included assets against a recorded source revision.

In one game, unit tests caught a spawn on a lamp post and another inside a
house; the first moved again later because a lamp post stood in front of the
camera. Two spawn islands had no boat off them: shared boats were placed only
where a decorative boat, skipped at random 40% of the time, happened to sit.

Use [verification and delivery](../verification-and-delivery.md) for the
evidence record. A scripted outcome can verify setup, but does not prove that a
player understands the objective or that the frame feels readable.
