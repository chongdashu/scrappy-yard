# Kickoff — char_raccoon_player source mesh

Date: 2026-11-04 (HKT). Owner approved spend: one fal turnaround + one Tripo player mesh.

## 1. fal turnaround

- Model: fal GPT Image 2.5 Flare text-to-image (`gpt-image-2.5-flare-t2i`), `landscape_4_3`, quality high, 1024×768.
- Prompt: `out/fal/char_raccoon_player/prompt-turnaround.txt` (v0 kept beside it). Tightened from the draft: one horizontal row (front, 3/4, side facing left, back), wide gaps, A-pose with empty hands, D palette (orange-brown fur, blue-lens goggles, red-orange scarf, slate vest, shorts, boots), flat #D0D0D0 studio gray.
- Request ID `01a1a3ee-2b9b-7f31-882b-429e44fe90de`; reconciled cost **$0.0385** (fal billable units). No edit pass needed.
- Promoted: `share/media/kickoff/char_raccoon_player-turnaround.png`.

## 2. Tripo mesh

- Views cropped from the sheet into `experiments/tripo/2026-11-04-char-raccoon-player/views/` (front, left = sheet profile, back; 3/4 kept but unused, Tripo multiview has no 3/4 slot).
- `tripo make front.png left.png back.png --model tripo-p1 -p face_limit=10000 -p texture=true -p pbr=true` → multiview-to-model, P1-20260311.
- Task ID `5b845239-9b46-40e9-bd5d-69aca860c2f1`; **50 credits**; balance 2600 → **2550**.
- Untouched download: `assets/source/tripo/char_raccoon_player/tripo-out/char-raccoon-player-5b845239/` (`model.glb`, `preview.png`, `rendered_image.webp`, `task.json`) + `job.json` (CLI result). Run record: `experiments/tripo/2026-11-04-char-raccoon-player/run.json`.
- Measured (raw glTF, single node, no transform): 9,719 tris / 11,932 verts, one PBR material (baseColor + metallicRoughness + normal, double-sided), bounds 0.58 × 1.00 × 0.60 units, +Y up, normalized to ~1 unit tall. Scale ×1.1 for the 1.1 m contract → ≈0.63 × 1.10 × 0.66 m (depth over the 0.55 m box because of the tail; collider is code-side so OK).

## Quality vs D mockup

- Matches: raccoon read, mask, blue goggles on forehead, red-orange scarf, slate vest, belt, shorts, boots, ringed tail, toon look.
- Differences: palette is more orange/red-panda-ish than D's brown-gray raccoon; D's scarf is longer and trails behind (here it is a short knotted bandana); D has a bigger head/chibi ratio; tail here is shorter and tucked to the side; gloves are dark brown (D reads darker/blackish). No neon accents/emissive on goggles yet (contract wants `mat_goggles` emissive → Blender).
- Mesh: arms A-pose ~45° down, hands open, legs separate (good for rigging). Tail sits close to right hip — check for fusion in Blender. 3/4 sheet panel was almost a front view (not used).

## 3. Tripo auto-rig + clips (2026-11-04, owner-approved)

- `tripo anim check` on the mesh task → task `5a5d5c48-212e-4924-a06b-f0dba2e42cbf`, **0 credits**, riggable, biped.
- `tripo anim rig` (v1.0-20240301, biped, spec tripo, glb) → task `32e89e12-11e6-4c80-92f4-23c0411717a8`, **25 credits**. 41 bones (Root/Hip/Pelvis/spine/arms/legs/hands); **no tail bone** (the tail rides the hip/leg weights).
- `tripo anim retarget` presets `biped:idle`, `biped:run`, `biped:jump`, `biped:jump_down`, in place → task `e1c271f7-c616-40d0-979e-e48d4c4fb166`, **40 credits**.
- Total this stage **65 credits**; balance 2550 → **2485**. Running Tripo total 115 credits.
- Untouched downloads: `assets/source/tripo/char_raccoon_player/tripo-out/rig-32e89e12/` and `.../retarget-e1c271f7/`. Run records: `experiments/tripo/2026-11-04-char-raccoon-player/{check,rig,clips}-result.json`, `run.json`.

## 4. Blender polish

`blender -b --python assets/scripts/normalize_char_raccoon_player.py` (Blender 5.2.3; rerunnable, never edits the provider files):

- Rotates so the front is glTF +Z, scales ×1.1022 → **1.100 m** rest height, feet-centre pivot at y = 0, applies transforms (unit node scale).
- Resamples clips at 24 fps: `idle` 15.333 s loop, `run` 1.250 s loop (seam eased closed), `jump` 0.625 s (matches sim airtime), `land` 0.292 s (over the ≤0.2 s target; noted in the contract). Hips recentred per clip so the feet stay on the origin; seams 0.00°, loop drift 0.
- Splits `mat_goggles` (62 blue-lens faces, emissive cyan) from `mat_raccoon_body`.
- Saves `assets/blender/characters/char_raccoon_player.blend`, exports `game/public/assets/characters/char_raccoon_player.glb` (3.9 MB), reimports it in a clean scene → `out/blender/reimport-char_raccoon_player.txt`.
- Contact sheet: `share/media/kickoff/char_raccoon_player-clips.png`. In-engine: `share/media/kickoff/char-test-idle.png`, `char-test-run.png` (`?scene=character`).

## Next

Done above. Still open: owner read of the clips in `?scene=character` (run stride vs 8 m/s on the treadmill, tail deformation), optional `stumble` clip, a tighter `land`, then swap the gym's greybox raccoon for the GLB.
