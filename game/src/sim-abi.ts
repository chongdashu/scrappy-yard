// Mirror of this game's Rust ABI (crate/src/{world,params,lib}.rs). Keep in sync: the
// version, strides, indices, event kinds and param ids are the contract. The engine's loader
// checks SIM_ABI_VERSION and every stride at boot, so a stale public/wasm/sim.wasm fails
// loudly instead of rendering garbage. When you change the Rust side, change this file too
// and bump both versions.
import type { ParamDef } from "@engine/game";
import type { SimExports, SimLayout } from "@engine/wasm";

/** Must equal `world::ABI_VERSION` (exported as `sim_abi_version()`). */
export const SIM_ABI_VERSION = 3;

/** This game's output buffers: name → floats per record (`buf_<name>_stride()`). The engine adds `events`. */
export const STRIDES = {
  stats: 15,
  player: 14,
  obstacles: 6,
  nuts: 4,
} as const;

/** What the engine checks at boot (GameModule.abi). */
export const ABI: SimLayout = { version: SIM_ABI_VERSION, strides: STRIDES };

/** This game's exports on top of the engine's (crate/src/lib.rs). */
export interface GameExports extends SimExports {
  /** A lane nudge: slide to the next lane centre left (< 0) or right (> 0); screen-left is −X. */
  sim_lane(dir: number): void;
  /** The held sideways axis −1..1 (screen-left −X); 0 = released, the player stops where it is. */
  sim_strafe(axis: number): void;
  /** A jump press (buffered briefly until the floor allows it). */
  sim_jump(): void;
  /** 0 gym (rules run), 1 asset viewer (no rules). */
  sim_set_mode(mode: number): void;
}

/** Stats record (`ST_*` in world.rs). */
export const ST = {
  time: 0, roundTime: 1, state: 2, paused: 3, round: 4, steps: 5, nuts: 6, nutsTotal: 7,
  distance: 8, course: 9, loseReason: 10, mechGap: 11, practice: 12, stumbles: 13, mode: 14,
} as const;

/**
 * Player record. x/y/z are the authoritative pose; rx/ry/rz and rgap are the DRAWN pose
 * (interpolated between the last two fixed steps): draw, follow and animate from those.
 */
export const PL = {
  x: 0, y: 1, z: 2, rx: 3, ry: 4, rz: 5, lane: 6, grounded: 7, stumble: 8, vy: 9, gap: 10, rgap: 11, falling: 12, speed: 13,
} as const;

/** Obstacle record. */
export const OB = { kind: 0, lane: 1, z: 2, halfL: 3, height: 4, hit: 5 } as const;
export const OB_KIND = { barrel: 1, car: 2, gap: 3 } as const;
/** Collision half-widths (x) per kind, from world.rs (for drawing collision bounds). */
export const HALF_W = { barrel: 0.42, car: 0.6 } as const;
export const PLAYER_HALF_L = 0.2;
/** Nut pickup half-width (x) at the least; the sim widens it to half a lane + 0.05. */
export const NUT_HALF_W = 0.55;

/**
 * The lanes whose hazards the player at x currently meets, by the sim's lane-corridor rule
 * (world.rs: |x − lane·lw| < max(playerHalfW + halfW, lw / 2), barrel width): always the nearest
 * lane, plus the neighbour while straddling the line between them. HUD radar, lamps, pings.
 */
export function lanesAt(x: number, lw: number, playerHalfW: number, halfW: number = HALF_W.barrel): number[] {
  const w = Math.max(playerHalfW + halfW, lw / 2);
  const near = Math.max(-1, Math.min(1, Math.round(x / Math.max(0.01, lw))));
  return [-1, 0, 1].filter((l) => l === near || Math.abs(x - l * lw) < w);
}

/** Nut record. */
export const NU = { x: 0, y: 1, z: 2, collected: 3 } as const;

export const STATE = { ready: 0, playing: 1, won: 2, lost: 3 } as const;
export const LOSE = { none: 0, crash: 1, fall: 2, caught: 3 } as const;
export const MODE = { gym: 0, viewer: 1 } as const;

/** Event kinds: record = [kind, a, b, c, d, e]. */
export const EV = {
  /** a round, b nuts total, c course length */
  roundStart: 1,
  /** a index, b x, c y, d z, e collected so far */
  nut: 2,
  /** a x, b z, c obstacle kind, d mech gap */
  stumble: 3,
  /** a x, b z */
  jump: 4,
  /** a x, b z, c impact speed */
  land: 5,
  /** nearest (logical) lane changed: a lane, b direction */
  lane: 6,
  /** a round time, b nuts, c total */
  win: 7,
  /** a reason, b z, c nuts */
  lose: 8,
} as const;

/** DEV tuning sliders: [id, label, min, max, step]; ids match crate/src/params.rs. */
export const PARAMS: ParamDef[] = [
  [0, "Run speed (m/s)", 3, 16, 0.1],
  [1, "Lane width (m)", 0.8, 2.4, 0.05],
  [2, "Lane switch time (s)", 0.05, 0.5, 0.01],
  [3, "Jump speed (m/s)", 3, 14, 0.1],
  [4, "Gravity (m/s²)", 6, 60, 0.5],
  [5, "Mech gap at start (m)", 3, 30, 0.5],
  [6, "Mech gap at finish (m)", 2, 30, 0.5],
  [7, "Mech gap recovery (m/s)", 0, 4, 0.05],
  [8, "Caught at gap (m)", 0.5, 6, 0.1],
  [9, "Stumble time (s)", 0, 2, 0.05],
  [10, "Stumble speed (×run)", 0, 1, 0.05],
  [11, "Course length (m, next round)", 60, 1200, 10],
  [12, "Practice (1 = no deaths)", 0, 1, 1],
  [13, "Player half-width (m)", 0.1, 0.7, 0.01],
  [14, "Player height (m)", 0.5, 2, 0.05],
  [15, "Coyote time (s)", 0, 0.3, 0.01],
  [16, "Jump buffer (s)", 0, 0.4, 0.01],
  [17, "Strafe speed (m/s)", 2, 14, 0.1],
  [18, "Strafe accel (m/s²)", 10, 200, 1],
  [19, "Strafe edge margin (m)", 0, 1.2, 0.05],
  [20, "Mech surge every (m, 0 = off)", 0, 300, 5],
  [21, "Mech surge depth (m)", 0, 8, 0.25],
  [22, "Mech surge close rate (m/s)", 0, 6, 0.1],
];
export const PARAM = {
  runSpeed: 0, laneWidth: 1, laneSwitch: 2, jumpSpeed: 3, gravity: 4, gapStart: 5, gapEnd: 6, recover: 7,
  catchGap: 8, stumbleTime: 9, stumbleSpeed: 10, course: 11, practice: 12, halfWidth: 13, height: 14, coyote: 15, jumpBuffer: 16,
  strafeSpeed: 17, strafeAccel: 18, strafeMargin: 19, surgeEvery: 20, surgeDepth: 21, surgeRate: 22,
} as const;

/** Mech surge strength 0..1 at course z (mirrors `surge_at` in crate/src/world.rs). */
export function surgeAt(z: number, every: number): number {
  const LEAD = 40, LEN = 32;
  if (every <= 0 || z < LEAD) return 0;
  const ph = (z - LEAD) % Math.max(every, LEN);
  return ph < LEN ? Math.sin((Math.PI * ph) / LEN) : 0;
}
