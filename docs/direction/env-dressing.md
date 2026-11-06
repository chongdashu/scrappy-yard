# Env dressing (sides, sky, flyovers)

Decoration only: nothing here collides. Drawn by `drawDressing()` in `game/src/game.ts`; streamed
last in `STATIC_LOAD_ORDER` (lane + raccoon first, ~2.9 MB total dressing).

| id | source | file | size | where |
|---|---|---|---|---|
| env_side_terrain | Blender procedural (`assets/scripts/blender_env_terrain.py`), free | env/env_side_terrain.glb | 117 KB, 1.55k tris | ground strip both sides |
| env_crane | Tripo text→model (40 cr) → `assets/scripts/normalize_env_crane.py`, tex 1024 JPEG | env/env_crane.glb | 0.70 MB | landmark |
| prop_scrap_plane | Tripo text→model (40 cr) → `normalize_prop_scrap_plane.py`, tex 1024 JPEG | props/prop_scrap_plane.glb | 0.77 MB | flyovers |
| env_container_stack, env_scrap_heap | Blender (`assets/scripts/blender_env_fill.py`) | env/ | 29 / 41 KB | landmark |
| env_tire_stack, env_corrugated_sheets, env_pallet_stack, env_drum_cluster, env_scrap_pipes, env_fence_panel | Blender | env/ | 17–72 KB | side fill |
| env_neon_billboard | Blender (emissive pink/cyan) | env/ | 12 KB | replaces box neon signs |
| env_skyline, env_clouds | Blender | env/ | 87 / 139 KB | sky (follows player) |

Triggers / rules
- Ground: `env_side_terrain` tiled every 8 m (LANE_TILE) on both sides from the scenery window
  start to 8 m past the draw end; origin at the track edge (x = ±2.5), the left side is the same
  tile turned π. It carries a concrete curb with a hazard stripe, a jagged cliff skirt down to the
  y = −7 pit floor (so gaps read as trenches), a flat dirt yard at y ≈ −0.05 (x 0.6–20 m from the
  edge) where every fill prop, billboard and landmark stands, and a scrap berm rising to ~3.5 m
  beyond 22 m. Height is periodic over the tile so seams match. Before it, every side prop was
  placed at y = 0 over nothing (the ground plane is the pit at y = −7), so they floated.
- Fill: one prop per 4 m tile per side, front row x ≈ 4.4–5.5 m; height scales with `sideRise` so the
  near sides stay open (flat in front of the player). Once any fill prop loads the front junk-box
  row is dropped; the back box row stays as mass. Billboards every 5 tiles (sides offset).
- Landmarks: every 3rd tile, one side (hashed), x ≈ 11.5–17.5 m, only where `sideRise > 0.3` (behind the player).
- Sky: three skyline strips 80–95 m behind the player; 5 cloud clusters drifting in X at y 26–40.
- Flyovers: plane A every 11 s from ~90 m behind over the track toward the camera (y 10–13, banking);
  plane B every 17 s crossing X at 45 m behind, alternating direction. The plane GLB's nose is
  along −X (wings along Z, belly down), so A is yawed +π/2 (nose → +Z) and B 0 / π (nose → −X / +X)
  with the bank rolled about the nose axis; before, both flew wings-first (sideways).

Leftovers: 2 of the 4 approved Tripo heroes were spent (text→model bills 40 cr each, so 4 = 160 > the
~80 cap); containers + scrap heap were built in Blender instead. A Tripo container wreck / fridge pile
would cost another ~80 cr.
