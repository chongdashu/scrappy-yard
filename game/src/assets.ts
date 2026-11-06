// The asset list from docs/asset-contract.md: ids, runtime paths, target sizes (proposed) and
// clip names. The asset viewer loads each path when it exists and shows a placeholder of the
// target size when it doesn't. Keep this in step with the contract.

export type AssetKind = "character" | "prop" | "environment";

export interface AssetSpec {
  id: string;
  kind: AssetKind;
  /** Relative to the game's public/ (the GLB the Blender leg exports). */
  url: string;
  /** Proposed bounding size [x width, y height, z depth] in metres (contract; not yet measured). */
  size: [number, number, number];
  /** Clip names the contract proposes (characters only). */
  clips: string[];
  note: string;
}

export const ASSETS: AssetSpec[] = [
  { id: "char_raccoon_player", kind: "character", url: "assets/characters/char_raccoon_player.glb", size: [0.7, 1.1, 0.55], clips: ["idle", "run", "jump", "land", "stumble"], note: "Player; faces +Z (toward the oncoming camera)" },
  { id: "char_fox_player", kind: "character", url: "assets/characters/char_fox_player.glb", size: [0.7, 1.1, 0.55], clips: ["idle", "run", "jump", "land"], note: "IAP player skin (Scrap Fox); same rig + clips as the raccoon" },
  { id: "char_cat_player", kind: "character", url: "assets/characters/char_cat_player.glb", size: [0.7, 1.1, 0.55], clips: ["idle", "run", "jump", "land"], note: "IAP player skin (Alley Cat); same rig + clips as the raccoon" },
  { id: "char_badger_player", kind: "character", url: "assets/characters/char_badger_player.glb", size: [0.7, 1.1, 0.55], clips: ["idle", "run", "jump", "land"], note: "IAP player skin (Bandit Badger); same rig + clips as the raccoon" },
  { id: "char_possum_player", kind: "character", url: "assets/characters/char_possum_player.glb", size: [0.7, 1.1, 0.55], clips: ["idle", "run", "jump", "land"], note: "IAP player skin (Yard Possum); same rig + clips as the raccoon" },
  { id: "char_otter_player", kind: "character", url: "assets/characters/char_otter_player.glb", size: [0.7, 1.1, 0.55], clips: ["idle", "run", "jump", "land"], note: "IAP player skin (Junk Otter); same rig + clips as the raccoon" },
  { id: "char_junk_mech", kind: "character", url: "assets/characters/char_junk_mech.glb", size: [3.6, 5.0, 2.4], clips: ["idle", "stomp_loop", "run"], note: "Background chaser; run is derived from stomp_loop in Blender (surges)" },
  { id: "prop_hex_nut", kind: "prop", url: "assets/props/prop_hex_nut.glb", size: [0.5, 0.5, 0.14], clips: [], note: "Collectible; spins in code" },
  { id: "prop_oil_barrel", kind: "prop", url: "assets/props/prop_oil_barrel.glb", size: [0.8, 0.85, 0.8], clips: [], note: "Jumpable stumble hazard (collider 0.84 × 0.8 × 0.7)" },
  { id: "prop_scrap_car", kind: "prop", url: "assets/props/prop_scrap_car.glb", size: [1.3, 1.4, 3.0], clips: [], note: "Lethal lane blocker (collider 1.2 × 1.4 × 3.0)" },
  { id: "env_scrapyard_lane", kind: "environment", url: "assets/env/env_scrapyard_lane.glb", size: [5.0, 0.5, 8.0], clips: [], note: "One 8 m track tile, three 1.4 m lanes + rails; side junk walls separate" },
  { id: "env_side_terrain", kind: "environment", url: "assets/env/env_side_terrain.glb", size: [40, 11.7, 8], clips: [], note: "Blender side terrain strip (curb, cliff skirt to the pit, yard, scrap berm); tiles beside the track, props stand on it" },
  { id: "env_tire_stack", kind: "environment", url: "assets/env/env_tire_stack.glb", size: [1.7, 1.9, 1.0], clips: [], note: "Blender tire stack; decoration only" },
  { id: "env_corrugated_sheets", kind: "environment", url: "assets/env/env_corrugated_sheets.glb", size: [3, 2.2, 0.8], clips: [], note: "Blender leaning corrugated sheets; decoration only" },
  { id: "env_pallet_stack", kind: "environment", url: "assets/env/env_pallet_stack.glb", size: [1.3, 0.6, 1.3], clips: [], note: "Blender pallet stack; decoration only" },
  { id: "env_drum_cluster", kind: "environment", url: "assets/env/env_drum_cluster.glb", size: [2.2, 1.8, 1.4], clips: [], note: "Blender decorative drum cluster; decoration only" },
  { id: "env_scrap_pipes", kind: "environment", url: "assets/env/env_scrap_pipes.glb", size: [2.8, 1.5, 3.5], clips: [], note: "Blender scrap pipe pile; decoration only" },
  { id: "env_fence_panel", kind: "environment", url: "assets/env/env_fence_panel.glb", size: [4, 2.2, 0.1], clips: [], note: "Blender chain-link fence panel; decoration only" },
  { id: "env_neon_billboard", kind: "environment", url: "assets/env/env_neon_billboard.glb", size: [3.3, 5.3, 0.2], clips: [], note: "Blender neon billboard frame; decoration only" },
  { id: "env_container_stack", kind: "environment", url: "assets/env/env_container_stack.glb", size: [5.2, 5.2, 6], clips: [], note: "Blender container stack landmark; decoration only" },
  { id: "env_scrap_heap", kind: "environment", url: "assets/env/env_scrap_heap.glb", size: [9, 6.5, 9], clips: [], note: "Blender scrap heap landmark; decoration only" },
  { id: "env_skyline", kind: "environment", url: "assets/env/env_skyline.glb", size: [160, 30, 2], clips: [], note: "Blender distant city silhouette strip; decoration only" },
  { id: "env_clouds", kind: "environment", url: "assets/env/env_clouds.glb", size: [36, 6, 6], clips: [], note: "Blender sunset cloud cluster; decoration only" },
  { id: "env_crane", kind: "environment", url: "assets/env/env_crane.glb", size: [14.7, 14, 7.3], clips: [], note: "Tripo gantry crane landmark (40 cr); decoration only" },
  { id: "prop_scrap_plane", kind: "prop", url: "assets/props/prop_scrap_plane.glb", size: [3.9, 2.2, 5.6], clips: [], note: "Tripo scrap plane (40 cr); overhead flyovers, no collision" },
];
