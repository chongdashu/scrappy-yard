# Kickoff — greybox gym (Scrapyard neon)

This is the first playable de-risk of the Review 1 pick **D — Scrapyard
neon** ([review-1.md](review-1.md), `share/media/review-1/D.png`). Everything
in it is a placeholder shape. There are no generated assets and no credits
were spent. Asset sizes, IDs and clips are in
[`../asset-contract.md`](../asset-contract.md).

| Mockup D | Gym, desktop 4:3 | Gym, phone | Bounds on (16:9) |
| --- | --- | --- | --- |
| `share/media/review-1/D.png` | `share/media/kickoff/desk-4x3.png` | `share/media/kickoff/phone.png` | `share/media/kickoff/desk-16x9-bounds.png` |

## Run it

```sh
npm run dev
# http://localhost:5173/?scene=gym       the gym (the default scene)
# http://localhost:5173/?scene=viewer    the stub asset viewer
# add &practice  nothing is lethal (crashes stumble, falls pop back up, the mech can't catch)
# add &bounds    start with collision bounds shown
# add &seed=7    a fixed course
```

On the dev server the main menu also has **Greybox gym** and **Asset
viewer** entries, and the debug panel (B) has Bounds / Camera / Practice
buttons. The round starts with no countdown.

## Rules (placeholder tuning, `game/crate/src/params.rs`)

- Three lanes at x = −1.4 / 0 / +1.4 m. The run is 8 m/s toward +Z, toward
  the camera, and the course is 800 m to the finish gate (about 100 s; was 420 m).
- **Barrels** (low): jump them or dodge them. A hit means a stumble: 0.7 s at
  40 % speed, and the mech gains ground.
- **Scrap cars** (tall, 3 m long): dodge only. A hit **loses** the run.
- **Gaps** in the track: jump them. Falling **loses**.
- **Mech**: it holds a comfort gap that shrinks from 12 m to 7 m along the
  course. Every slow-down hands it ground, and it reopens at 0.6 m/s. At
  1.6 m you are **caught**.
- **Hex nuts**: collect them. The HUD shows the nut count, progress to the
  🏁 and the mech gap, which turns red under 4 m.
- **Win**: reach the finish gate.
- The course is laid out from the seed: a 30 m clear run-up, then a pattern
  every 16–22 m that always leaves a way through.

## Controls (shown on screen)

| Action | Keyboard | Gamepad | Touch |
| --- | --- | --- | --- |
| Lane left / right | A / D, ← / → | D-pad ← / →, stick flick | Stick flick (one lane per flick) |
| Jump | Space, W, ↑ | A, D-pad ↑ | JUMP button, stick flick up |
| Collision bounds | X | Y | Gym panel button |
| Cycle camera preset | V | X | Gym panel button |
| Practice on/off | G | — | Gym panel button |
| Pause | Esc | Start | ❚❚ |

The screen-left lane is −X, because the camera looks back along −Z at the
oncoming player.

## Camera: matched to mockup D by eye

The camera is fixed (`camera: "first-person"`, `look: false`) in front of
the player and looks back at them (yaw π). It follows the player's lane by
a fraction (`follow`) and rises a quarter of the jump height. The preset
blends between a portrait set and a landscape set by aspect, lerping from
aspect 0.56 to 1.33 (`framing()` in `game/src/game.ts`).

**Preset "mockup D" (default):**

| Aspect | Height | Distance in front of the player | Pitch (down) | Vertical FOV | Lane follow |
| --- | --- | --- | --- | --- | --- |
| Landscape ≥ 1.33 (4:3 and 16:9) | 2.7 m | 6.0 m | 6° | 46° | 0.45 |
| Portrait ≤ 0.56 (phone, e.g. 390×844 = 0.46) | 3.5 m | 5.8 m | 11° | 68° | 0.6 |

How D was matched:

- **Desktop D (4:3):** feet about 90 % down the frame, horizon about 38–42 %
  from the top, player about a quarter of the screen height.
- **Phone D (about 0.38):** feet about 80 % down, horizon about 33 %. The
  three lanes have to fit the width, so the phone set is higher, steeper and
  wider. D's portrait frame cheats on track width, and the gym cannot match
  it with the same world.
- Other presets (V): **high read** (portrait 5.2 / 7.5 / 24° / 68°, landscape
  4.6 / 6.5 / 26° / 50°) shows more of the oncoming track. **Low chase**
  (1.9 / 5.5 / 2° / 72°, 1.7 / 4.4 / 4° / 54°) is the most dramatic.

## Kickoff findings

1. **Hazards come from behind the player on screen.** With the oncoming
   camera the hazards approach out of the background, past the mech, and
   there is only about 0.7 s of clear track between the player's back and
   the mech. Mitigations in the gym:
   - a **lane warning strip** at the bottom of the screen marks the nearest
     hazard per lane up to 2.2 s ahead;
   - practice mode;
   - the camera presets.
   
   This needs an owner read in the slice: keep the strip, or add a shadow,
   sound or rumble cue.
2. **The mech covered the oncoming track.** Drawn at its rule gap (12 m), the
   mech stood on the hazards the player has to read. The gym now draws it
   farther back (6 m + 1.5 × gap) and at ×1.2 scale, so it looms over the
   horizon as in D. The HUD meter and the bounds overlay's catch line show
   the real gap. This is presentation only; the rule is unchanged.
3. **The side junk crowded the near frame.** The side junk walls now start
   2 m outside the track, rise with distance, and are culled between the
   camera and the player. That keeps D's open near sides. This follows the
   Review 1 note to simplify the busy sides.
4. **Software WebGL2 is fill-bound on a phone-sized canvas.** Headless
   software rendering ran at about 2.5 fps at 780×1688. A **resolution
   governor** (`govern()` in `game/src/game.ts`) lowers the renderer's
   `maxPixels` by ×0.6 at a time, down to 350 k pixels, after 1.5 s under
   24 fps while playing. It logs each step with `console.info`. Real GPUs
   should never trigger it; check on a device in the slice.

## Asset viewer (stub)

`?scene=viewer` lays out every contract asset in a row on the origin, with
an orbit camera. ←/→ select an asset and Space cycles its clips. For each
asset it draws:

- the origin axes (+X red, +Y green, +Z blue);
- the contract's target box (green) and the measured rest-pose box (cyan).

It tries each GLB at its `game/src/assets.ts` URL and falls back to a
placeholder while a file is missing, which is true of every asset today.

## Blocked on the Blender leg (Blender is not installed; nothing was attempted)

- DONE: Blender 5.2.3 installed and recorded in the asset contract.
- TODO: after the turnaround and Tripo jobs (each spend needs approval),
  write the rerunnable normalise scripts (units, +Z front, feet-centre
  pivot).
- DONE for the raccoon (Tripo rig + Blender polish, 2026-11-04). TODO: rig and animate `char_junk_mech` (`idle`, `stomp_loop`), and author the
  `.blend` sources.
- TODO: export the GLBs and reimport them in a clean process. Measure the
  sizes and write them into the contract as **Measured**.
- TODO: measure each loop's first/last pose difference and hip drift.
- TODO: build the `env_scrapyard_lane` 8 m tile and check that it tiles in
  the gym.
- TODO: watch every clip in `?scene=viewer` at game speed. Then swap the gym
  placeholders for the GLBs.

## Heads-up pass (2026-11-04)

Owner: "not enough heads up for the player to react to things in front of
camera" and "remove the control instructions at bottom of screen, it
occludes". Presentation only; sim rules, speeds and layouts are unchanged.

| Change | Before | After |
| --- | --- | --- |
| Default camera | mockup D (landscape h 2.7, d 6.0, pitch 6°, fov 46°) | **heads-up**: landscape h 2.1, d 9.0, pitch 4°, fov 56°, follow 0.45; portrait h 3.0, d 8.6, pitch 9°, fov 74°, follow 0.6. D, high read and low chase stay on V |
| Track visible in front of the player | landscape 1.13 m / portrait 2.30 m | landscape **5.64 m** / portrait **5.70 m** (`visibleAhead()`, tested in `game/tests/headsup.test.ts`) |
| Lane radar | 2.2 s strip | **3.5 s** three-lane radar above the bottom edge: icon climbs to the line, seconds label, hot under 1.2 s |
| In-world cue | none | glowing lane lamps and chevrons just inside the bottom of the frame, coloured by hazard kind, pulsing when hot |
| Audio | none | tick when a hazard enters the window in the player's lane, double beep when it goes hot |
| Bottom control hints | key/touch hint strip | **removed**; controls live in How to play and the in-round Help (with a new "Heads-up" item); practice mode kept |

Character preview: `?scene=character` (dev menu "Character test"): clip
buttons 1–4, Space next, S run→jump→land sequence, P pause, `,` `.` frame
step, `[` `]` speed, T 8 m/s treadmill, X bounds, drag orbit. No gym sim.
Screens: `share/media/kickoff/gym-headsup-desktop.png`, `gym-headsup-phone.png`.
