# Asset contract — Scrapyard Dash (kickoff)

Copied from [`templates/asset-contract.md`](templates/asset-contract.md) and
filled in at kickoff. **Measured** values come from a source, export or
runtime check. **Proposed** values are starting choices that still need a
check. At kickoff no production asset exists yet: no Tripo mesh and no
Blender file (Blender 5.2.3 LTS is installed; per-asset sizes still Proposed until measured after export). So every per-asset
number here is **Proposed** until the Blender leg measures it. The
conventions are **Measured** only where the engine's starter-arena demo
assets already prove them.

The direction is locked: Review 1 pick **D — Scrapyard neon**
([`direction/review-1.md`](direction/review-1.md),
`share/media/review-1/D.png`).

## Contract header

| Field | Value |
| --- | --- |
| Game / slice | Scrapyard Dash (`games/blank-start`): an oncoming three-lane runner. Kickoff greybox gym, then the vertical slice |
| Contract version | 0.1 (kickoff) |
| Owner | Chong-U Lim (direction); agent (contract upkeep) |
| Runtime format and loader | glTF 2.0 binary (`.glb`), loaded by the engine's `loadGlb` / `ModelRenderer` (skinned clips through `Animator`) |
| Authoring tool/version | Mesh: Tripo (image-to-3D from fal GPT Image 2.5 Flare turnarounds). Rig, clips, cleanup and export: **Blender 5.2.3 LTS** at `/home/box/tools/blender-5.2.3-linux-x64/blender` (measured 2026-11-03) |
| Status | Proposed |

## Source boundaries

```text
assets/
  source/tripo/<asset_id>/        # untouched provider downloads + job JSON (never edited)
  blender/
    characters/char_raccoon_player.blend
    characters/char_junk_mech.blend
    props/prop_hex_nut.blend
    props/prop_oil_barrel.blend
    props/prop_scrap_car.blend
    environment/env_scrapyard_lane.blend
    scenes/review_lineup.blend    # links the above; review only, never exported
  scripts/normalize_<asset_id>.py # rerunnable fixes on the provider original
game/public/assets/
  characters/  props/  env/       # promoted runtime exports (see game/src/assets.ts)
out/
  fal/  tripo/  gym/              # generator and capture outputs only
```

| Source or library | Owns | Runtime exports | Owner | Status |
| --- | --- | --- | --- | --- |
| `assets/blender/characters/char_raccoon_player.blend` | Player mesh, rig, clips | `game/public/assets/characters/char_raccoon_player.glb` | agent | **Built** 2026-11-04 by `assets/scripts/normalize_char_raccoon_player.py` |
| `assets/blender/characters/char_junk_mech.blend` | Mech mesh, rig, stomp loop | `game/public/assets/characters/char_junk_mech.glb` | agent | **Built (skinned)** 2026-11-04 by `assets/scripts/normalize_char_junk_mech.py` (Tripo mesh `70693399…`, rig `85055f87…` biped 41 joints, retarget `48a343f6…` biped:idle + biped:walk in place) |
| `assets/blender/props/*.blend` | Nut, barrel, car (one file each) | `game/public/assets/props/<id>.glb` | agent | `prop_hex_nut.blend` **Built** 2026-11-04 by `assets/scripts/normalize_prop_hex_nut.py`; `prop_oil_barrel.blend` and `prop_scrap_car.blend` **Built** 2026-11-04 by `assets/scripts/normalize_prop_oil_barrel.py` / `normalize_prop_scrap_car.py` (shared helper `tripo_static_normalize.py`; Tripo `1a794519…`, `08cfc360…`) |
| `assets/blender/environment/env_scrapyard_lane.blend` | One 8 m lane tile + rails (side junk walls stay separate) | `game/public/assets/env/env_scrapyard_lane.glb` | agent | **Built** 2026-11-04 by `assets/scripts/normalize_env_scrapyard_lane.py` |
| `assets/blender/scenes/review_lineup.blend` | Links all of the above for review renders | none | agent | Proposed |

Dependencies run one way: provider download → normalise script → asset
`.blend` → linked review scene. The normalise script plus the untouched
Tripo download are authoritative, so the set rebuilds without paying again.
fal, Tripo and capture tools write only to `out/<tool>/`. Promoting a file
into `game/public/assets/` is a deliberate copy with its own commit and a
hash check.

## Shared conventions

| Concern | Contract value | Evidence / status |
| --- | --- | --- |
| Units | 1 Blender unit = 1 m = 1 runtime unit | **Measured** by the engine demo (`addons/starter-arena/docs/demo-assets.md` line 84: arena 21.00 m, runner 1.463 m). The gym sim uses metres (`game/crate/src/params.rs`) |
| Up axis and forward axis | Runtime/glTF: **+Y up**, asset front **+Z**, asset left +X. Blender: Z up, front −Y; the exporter (`export_yup`) maps Blender (x, y, z) → (x, z, −y) | **Measured** by the engine demo (`demo-assets.md` line 85: runner face centroid z = +0.180). In this game the player and mech run toward +Z, toward the oncoming camera (yaw π, looking −Z), so both characters face the camera at yaw 0 and screen-left is −X |
| Export transform policy | Apply scale and modifiers; unit node scale; no baked root motion (the sim owns position) | Proposed |
| Character origin / prop pivot | Characters: feet centre on y = 0 (midpoint between the feet, rest pose). Props: centre of the ground contact on y = 0 (nut: bottom of the rim when upright) | Proposed; the viewer shows the origin axes for each asset |
| Grid or placement increment | Lanes at x = −1.4, 0, +1.4 m (`LANE_WIDTH` 1.4); track 5.0 m wide (half 2.5); lane tiles 8 m along Z; layout on a 0.5 m grid | Proposed (gym values) |
| Stable asset ID rule | `char_` / `prop_` / `env_` + snake_case; the file name is the ID; `col_<id>` collider nodes (never drawn); `mk_<id>` markers; `mat_<role>` materials | Proposed; IDs fixed in `game/src/assets.ts` |

Target sizes. All are **Proposed**. They are mirrored in `game/src/assets.ts`,
and the asset viewer (`?scene=viewer`) draws them as green boxes next to the
measured cyan boxes.

| Asset ID | Intended use | Dimensions (W × H × D, m) | Pivot/origin | Measured from | Status |
| --- | --- | --- | --- | --- | --- |
| `char_raccoon_player` | Player (runs, lane-dodges, jumps) | 0.7 × 1.1 × 0.55 (target height 1.0–1.2; sim collider half-width 0.32, height 1.1). **Measured** rest pose 0.657 × 1.100 × 0.635; idle frame 0 0.520 × 1.126 × 0.645 (depth over target: tail) | Feet centre (idle f0 feet midpoint (−0.012, 0.011) m from origin; soles −0.016) | Blender 5.2.3 reimport of the exported GLB, `out/blender/reimport-char_raccoon_player.txt` | **Measured** |
| `char_junk_mech` | Chaser behind the player | 3.6 × 5.0 × 2.4 (target 4–6 m tall; the gym draws it ×1.2 ≈ 6 m). **Measured** static A-pose 3.278 × 5.000 × 1.497 (uniform scale to 5.0 m; narrower and shallower than the target box) | Feet centre (lowest-slice centre; bbox centre offset x −0.034, z −0.059) | Blender 5.2.3 reimport, `out/blender/reimport-char_junk_mech.txt` | **Measured** (mesh only) |
| `prop_hex_nut` | Collectible | 0.5 × 0.5 × 0.14 (stands upright, spins on Y). **Measured** 0.500 × 0.500 × 0.140 (hex across-flats 0.50 m with the two side corners chamfered to W 0.50; hole r 0.12; axis along Z, faces the camera) | Centre-bottom (bottom flat on y = 0, x = z = 0) | Blender 5.2.3 reimport of the exported GLB, `out/blender/reimport-prop_hex_nut.txt` | **Measured** |
| `prop_oil_barrel` | Low hazard: jump it or dodge it; a hit is a stumble | 0.8 × 0.85 × 0.8 (sim collider 0.84 W × 0.8 H × 0.7 D). **Measured** 0.800 × 0.850 × 0.800 (per-axis fit: source drum was 0.70:1 W:H, widened ×1.34 for a squat toy drum) | Ground-contact centre (0, 0) | Blender reimport, `out/blender/reimport-prop_oil_barrel.txt` | **Measured** |
| `prop_scrap_car` | Tall hazard: dodge only; a hit loses the run | 1.3 × 1.4 × 3.0 (sim collider 1.2 W × 1.4 H × 3.0 D, long axis Z). **Measured** 1.300 × 1.400 × 3.000, nose toward +Z (per-axis fit: width ×0.82 vs uniform) | Ground-contact centre (bbox centre offset x −0.007, z +0.047) | Blender reimport, `out/blender/reimport-prop_scrap_car.txt` | **Measured** |
| `env_scrapyard_lane` | Repeating three-lane track tile | 5.0 × 0.5 × 8.0 (lanes 1.2–1.5 m; gym 1.4 m). **Measured** 5.000 × 0.500 × 8.000: deck x ±2.2, y −0.3..0; lanes 1.4 m at x = −1.4, 0, +1.4 (dividers at ±0.7, 0.02 high); hazard rails x ±2.2..±2.5, y −0.3..+0.1; rail lamps to y +0.2; tile spans z 0..+8 | Tile start edge centre (x = 0, z = 0), deck top y = 0.000 at all three lane centres (ray-cast) | Blender 5.2.3 reimport, `out/blender/reimport-env_scrapyard_lane.txt` | **Measured** |

## Art set

| Asset kind | Generator and preset | Size or resolution setting | Target texels per metre | Measured texels per metre | Reference | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Characters | fal GPT Image 2.5 Flare turnaround (front/side/back) → Tripo image-to-3D, textured | Tripo P1-20260311, PBR, 2048² textures; raccoon face_limit 10k (multiview front/left/back), mech 12k (multiview front/back only; edit from a D.png crop) | ~200 (player is seen close) | TBD | `share/media/review-1/D.png` (raccoon, mech crops) | Proposed |
| Hazard props | fal GPT Image 2.5 Flare single 3/4 reference → Tripo image-to-3D (P1-20260311, PBR, 2048² textures) | barrel face_limit 3k (2,839 tris), car 6k (5,810 tris) | ~120 | TBD | D.png crops (barrel, car) | Proposed |
| Collectible | Simple geometry + flat neon material (no generation needed) | N/A | N/A | N/A | D.png nut | **Built** (Blender only; render `share/media/assets/prop_hex_nut.jpg`) |
| Environment tile | Blender kit from simple geometry + generated side junk | Procedural numpy textures in the build script: `tex_track` 512 × 1024 over 4.4 × 8 m; `tex_rail_hazard` 256² over 0.6 m (repeat) | ~80 | ~116 across / 128 along (track); ~427 (hazard stripes) | D.png track and side junk | Track tile **Built** (render `share/media/assets/env_scrapyard_lane.jpg`); side junk Proposed |

- One style family: chunky low-poly toy look, neon emissive accents on a
  dusk palette (mockup D). Follow the Review 1 notes: boost contrast, keep
  the sides simpler than the track, put the finish ahead of the player.
- Small readable marks (hazard stripes, the nut's hex, neon sign glyphs) go
  on simple geometry as textures, not as generated detail.
- Send one object per reference crop and end each prompt with what to leave
  out. Record the prompt, preset, setting, cost, job ID and measured size per
  asset in `out/tripo/<id>/job.json`.
- **No credits spent at kickoff.** Turnaround and Tripo jobs wait for an
  explicit go-ahead before each spend (brief: "ask before each spend").

## Collections, materials, and exports

| Asset ID | Collection | Output path | Materials/textures | Collider | Clip list | Hash/status |
| --- | --- | --- | --- | --- | --- | --- |
| `char_raccoon_player` | `export_char_raccoon_player` | `game/public/assets/characters/char_raccoon_player.glb` | `mat_raccoon_body`, `mat_goggles` (emissive) | Sim capsule-box (code) | `idle`, `run`, `jump`, `land` (+ `stumble` optional, not built) | Exported 2026-11-04: 3,896,316 bytes, sha256 2ae2ab4831cabcb3…, 41 joints (Tripo biped rig, no tail bone), 9,719 tris; `mat_goggles` = 62 lens faces, emissive (0.15, 0.75, 1.0) ×1 |
| `char_junk_mech` | `export_char_junk_mech` | `game/public/assets/characters/char_junk_mech.glb` | `mat_mech_paint`; flat-emissive face splits `mat_mech_eye` (yellow eye, 25 faces), `mat_mech_eye_cyan` (cyan eye, 32), `mat_mech_lamp` (orange lamps, 80) — the runtime loader ignores `emissiveTexture`, so glow is per material | None (gap rule) | `idle`, `stomp_loop` | Exported 2026-11-04: 4300924 bytes, sha256 1953fde429ac79ab…, 11,014 tris, skin 41 joints, textures 1024² |
| `prop_hex_nut` | `export_prop_hex_nut` | `game/public/assets/props/prop_hex_nut.glb` | `mat_nut_neon` (base (1.0, 0.68, 0.04), emissive (1.0, 0.58, 0.02) ×1) | Sim sphere (code) | — | Exported 2026-11-04: 30,572 bytes, sha256 5ccdff3abe2e0cf7…, 448 tris, 1 mesh, unit scale |
| `prop_oil_barrel` | `export_prop_oil_barrel` | `game/public/assets/props/prop_oil_barrel.glb` | `mat_barrel` (hazard stripes in the Tripo texture) | Sim box (code) | — | Exported 2026-11-04: 3,042,152 bytes, sha256 3f58c1fc2cf2492e…, 2,839 tris |
| `prop_scrap_car` | `export_prop_scrap_car` | `game/public/assets/props/prop_scrap_car.glb` | `mat_car_rust` (double-sided from Tripo) | Sim box (code) | — | Exported 2026-11-04: 3,374,112 bytes, sha256 ac55ebabced9aaf1…, 5,810 tris |
| `env_scrapyard_lane` | `export_env_scrapyard_lane` | `game/public/assets/env/env_scrapyard_lane.glb` | `mat_track` (tex_track), `mat_rail_hazard` (tex_rail_hazard), `mat_neon_sign` (amber, emissive ×3: rail lamps at z = 2, 6 + inner rail glow strip) | None (the sim owns the floor and gaps) | — | Exported 2026-11-04: 750,712 bytes, sha256 1e771b57de73176e…, 372 tris, 1 mesh, 2 embedded PNGs, unit scale |

| Material | Alpha mode (cutoff) | Kind | Textures (alpha?) | Filtering (mag / min, mipmaps, wrap) | Shadows / ink expectation | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| All v1 materials | OPAQUE | default | Base colour only, no alpha | linear; mipmaps yes; repeat (track) / clamp (characters) | Cast shadows; ink outline on | Proposed |

Gameplay collision stays in the Rust sim (`game/crate/src/world.rs`). Mesh
colliders are not authored in v1.

## Sockets, clips, and runtime data

| Socket / marker | Parent asset | Position/orientation | Runtime meaning | Evidence |
| --- | --- | --- | --- | --- |
| None in v1 | — | — | — | Proposed. Add a socket studio before any attachment (for example the mech's magnet grabbing) |

| Asset | Clip | Loop | Duration | Notes | Status |
| --- | --- | --- | --- | --- | --- |
| `char_raccoon_player` | `idle` | loop | **15.333 s** (368 f @ 24) | Menu / results. Seam 0.00°, hip drift 0.000 m | **Measured** |
| `char_raccoon_player` | `run` | loop | **1.250 s** (30 f) | In place (Tripo `--animate-in-place`), hips recentred. Seam closed by easing the last 6 frames into frame 0 (source seam was 28° on a forearm) → 0.00°, drift 0.000 m. Stride vs 8 m/s: check on the treadmill in `?scene=character` | **Measured** |
| `char_raccoon_player` | `jump` | one-shot | **0.625 s** (15 f; source frames 12–24 retimed) ≈ 0.63 s airtime | Rise/apex/fall as one clip; the sim decides timing | **Measured** |
| `char_raccoon_player` | `land` | one-shot | ≤ 0.2 s target; **0.292 s** built (7 f, jump_down 50–70) | Blends back to `run`; over target — the game may cut it at 0.2 s or a tighter clip can be cut later | **Measured (deviation)** |
| `char_junk_mech` | `idle` | loop | 15.333 s (368 f @ 24), seam 0.00° | Fallback (not drawn in Play yet) | Built |
| `char_junk_mech` | `stomp_loop` | loop | 1.583 s (38 f @ 24, from biped:walk 2.33 s), 2 steps, seam 0.00°, hip drift 0 m | Plays all the time in Play (in place; world z from sim gap). Footfall → camera shake TODO | Built |

TODO (Blender leg): for each loop, record the largest joint difference
between its first and last frames and the hip drift over one cycle. The game
state decides outcomes; animation only presents them.

## Acceptance

| Check | Evidence path | Result | Date |
| --- | --- | --- | --- |
| Export/reimport | TODO Blender leg: `out/blender/reimport-<id>.txt` | Pending (Blender missing) | — |
| Runtime load | `?scene=viewer` (stub viewer; falls back to placeholders while the GLBs are missing) | Pending (no GLBs yet) | — |
| Socket studio | N/A in v1 (no sockets) | N/A | 2026-11-03 |
| Generated model: separate moving parts; fixes are a rerunnable script | TODO after the Tripo jobs (the mech's arms and magnet are separate parts) | Pending | — |
| Landmark scale: mech 4–6 m reads at the gameplay camera | `share/media/kickoff/desk-4x3.png`, `share/media/kickoff/phone.png` (greybox) | Placeholder reads; real mesh pending | 2026-11-03 |
| Looping clips: seam and hip drift measured | TODO Blender leg | Pending | — |
| Every clip watched in the engine at game speed | TODO: `?scene=viewer`, Space cycles clips | Pending | — |
| Visual and interaction review | `docs/direction/kickoff-gym.md` | Greybox gym ready for review | 2026-11-03 |
