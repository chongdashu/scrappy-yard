# Brief — blank-start (working title)

Shape-stage brief for the VGD WASM pipeline. **Owner confirmed 2026-11-03**
(Asia/Hong_Kong). Template pin: vgd-wasm-game-template **v2.7.0**.
Game folder: `/home/box/vgd-wasm-game-template/games/blank-start`.

## Fantasy

A colorful 3D platformer-runner: you sprint **toward the camera** down a
Crash / Mario 3D / Spyro–flavored course while a **mech chases in the
background**. Read the threat past you while you dodge, jump, and grab
pickups streaming at the screen.

## Objective

- **Player wants:** finish the course.
- **Threat:** lane hazards and gaps eliminate the run; the chasing mech is
  pressure and spectacle (getting caught also ends the run).
- **Win:** reach the end of the course.
- **Lose:** fall, hit a lethal hazard, or get caught by the chase.

## Core loop

Sprint → read upcoming hazards/pickups → lane-dodge / jump → collect → stay
ahead of the mech → finish or bust → instant retry.

**Why it should be fun:** readable oncoming spectacle, tight lane dodges and
jumps under chase pressure, and collect dopamine.

## Camera

Third-person **oncoming** runner: camera faces the player; the character runs
toward the viewer while the world streams past; the mech stays visible in the
deep background behind the player. Portrait-friendly framing on phones.

## Tone

Whimsical, comedic, family-friendly cartoony platformer energy — bright
materials, readable silhouettes.

## Session

About **5–10 minutes per visit**, made of **several 45–90 second rounds** with
fast retries.

## Devices and controls

Desktop **and** mobile (portrait on phones). Keyboard/mouse or gamepad on
desktop; on touch a **virtual joystick** and as few buttons as possible
(jump / action).

## Players

**Solo.** No online multiplayer in v1.

## Goal of this build

A **vertical slice of the core mechanic**: one complete run that proves
oncoming camera, chase pressure, lane dodge/jump/collect, win/lose, and
touch+desktop controls.

## Stack and assets

- Rust + WASM + WebGPU with WebGL 2 fallback; no three.js.
- Models start in Blender, exported into the game. One `.blend` per character;
  environment/props may share one. Everything at game scale.
- **Paid generation:** small budget — **ask before each spend**.

## In scope (first slice)

- Player character + run / lane dodge / jump / collect
- Oncoming camera + path/course blockout
- Chasing mech as background pressure
- Hazards, pickups, win/lose, retry
- Desktop + touch controls, basic UI/feedback/sound as the template expects

## Out of scope (first version)

Progression systems, monetisation, online multiplayer, large campaign, level
editor.

## Never show (vetoes)

Nothing beyond the host platform’s rules. No gore, horror, or sexual content.

## Decision log

| Kind | Item | Source |
| --- | --- | --- |
| Decision | Genre: Crash × Mario 3D × Spyro–style 3D runner | owner |
| Decision | Oncoming camera (face player; world streams at you) | owner |
| Decision | Mech chasing in background | owner |
| Decision | Fun: lane dodge + jump + collect under chase pressure | owner |
| Decision | Win: finish course; lose: hazard / fall / caught | owner |
| Decision | Session: 5–10 min visit via several 45–90s rounds + retries | owner |
| Decision | Devices: desktop + mobile | owner |
| Decision | Paid gen: small budget; ask before each spend | owner |
| Decision | Players: solo | agent default, accepted |
| Decision | Goal: vertical slice of core mechanic | agent default, accepted |
| Decision | Tone: whimsical / family-friendly | agent proposal, accepted |
| Decision | Out of v1: progression, monetisation, online | agent default, accepted |
| Decision | Never show: no gore/horror/sexual | agent default, accepted |
| Assumption | Working title / folder stays `blank-start` until renamed | unanswered → keep |
| Open | None blocking mockups | — |
| Decision | Review 1 pick: D — Scrapyard neon (raccoon, neon scrapyard, junk mech) | owner |
| Decision | Keep original hero; boost contrast; simplify busy sides; finish ahead of player | owner + kickoff notes |
| Open | None blocking kickoff blanks (3D tool, gym mechanics) | — |
| Decision | Kickoff camera "mockup D" (by eye vs D.png): landscape aspect ≥1.33 → height 2.7 m, 6.0 m in front of player, pitch 6° down, vFOV 46°, lane follow 0.45; portrait aspect ≤0.56 → 3.5 m, 5.8 m, 11°, 68°, follow 0.6; lerp between. See docs/direction/kickoff-gym.md | agent proposal, pending owner review |
| Decision | Asset IDs/sizes/pivots/clips per docs/asset-contract.md (all Proposed until Blender measures) | agent proposal, pending owner review |
| Open | Hazards read from behind the player (~0.7 s clear track); gym uses a 2.2 s lane warning strip — keep or replace in slice | kickoff finding → addressed by the heads-up pass below; owner to judge on device |
| Open | Blender not installed: rig, clips, .blend, GLB export/reimport blocked (TODOs in kickoff-gym.md) | kickoff finding |
| Decision | char_raccoon_player source: fal Flare turnaround ($0.0385, req 01a1a3ee…) → Tripo P1 multiview mesh (task 5b845239…, 50 credits, 9.7k tris, balance 2550). See docs/direction/kickoff-raccoon.md | owner-approved spend |
| Decision | char_raccoon_player rig: Tripo auto-rig (task 32e89e12…, 25 cr) + retarget idle/run/jump/jump_down (task e1c271f7…, 40 cr; balance 2485) → Blender polish script → `char_raccoon_player.glb` (1.10 m, +Z front, emissive goggles). Preview in new `?scene=character`; gym unchanged in sim | owner ("autorig and then blender polish") |
| Decision | Gym heads-up pass: default camera "heads-up" (landscape h 2.1 / d 9.0 / pitch 4° / fov 56°; portrait 3.0 / 8.6 / 9° / 74°) shows ~5.6 m of track ahead vs ~1.1 m with mockup D; lane radar 2.2 → 3.5 s; in-world lane lamps; audio pings; bottom control strip removed (controls in How to play / Help). Mockup D kept as a V preset. See docs/direction/kickoff-gym.md | owner ("not enough heads up", "remove the control instructions") |
| Decision | Free strafe over three hazard lanes: hold A/D / ←→ / stick / touch drag slides at 6.5 m/s (accel 60 m/s², brake 90 m/s²), release stops in place (no lane snap); a tap or flick (< 0.12 s) still hops one lane. x clamped to ±(lane width + 0.55 m) = ±1.95 m. Obstacles, nuts and gaps stay in lanes −1/0/+1; a hazard hits anywhere in its lane corridor, \|x − lane·w\| < max(physical overlap, w/2), so the nearest lane always counts and straddling meets both; HUD radar, lamps and pings use the same nearest (+ straddled) lanes | owner ("less fixed 3 lane … keep key collisions lane based") |
| Decision | Side junk / neon no longer pop in: laid out 100 m back (into the haze) to past the camera, height continuous in distance (sideRise: flat 7 m ahead of the player, 30% beside it, full 22 m back), so walls grow out of the deck instead of appearing at the player's depth; near sides stay open | owner ("the sides are popping in") |
