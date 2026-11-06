// The scrapyard runner (Play / `?scene=gym`) and the asset viewer scene. The player is the rigged
// raccoon GLB (player-model.ts); the mech, barrel, scrap car, hex nut and lane tile are static GLBs
// (static-model.ts). Play boots once the raccoon is ready; the rest stream in and hot-swap over
// placeholders (lane next, mech last). Any GLB that fails to load stays a placeholder. The gym
// de-risks the oncoming camera, free strafe over three hazard lanes, jump, collect and mech chase
// pressure before any final art lands. Rules live in the Rust sim (crate/src/world.rs); this file
// maps input to it and draws what it reports.
//
// Scenes (`?scene=`, and a DEV main-menu entry each): `gym` (default), `viewer` and `character`
// (alias `char-test`: the character animation test scene, game/src/character.ts).
// Axes (docs/asset-contract.md): metres, +Y up, the run direction and character fronts are +Z;
// the oncoming camera sits ahead of the player looking back toward −Z, so screen-left is −X.
import { currentSkin, SKINS } from "./skins";
import { customisePreviewId, isCustomiseOpen, setCustomiseLoading } from "./customise";
import type { DebugAction, Game, Phase, RoundState, RoundSummary } from "@engine/game";
import type { EyePose, Shot } from "@engine/camera";
import type { InputSnapshot } from "@engine/input";
import type { GameRuntime } from "@engine/runtime";
import type { Sim } from "@engine/wasm";
import { PARTICLE } from "@engine/fx";
import { MESH, hex, type InstanceBatch } from "@engine/gpu/meshes";
import { EV, HALF_W, LOSE, MODE, NU, NUT_HALF_W, OB, OB_KIND, PARAM, PL, PLAYER_HALF_L, ST, STATE, STRIDES, lanesAt, surgeAt, type GameExports } from "./sim-abi";
import { GymHud } from "./hud";
import { icon } from "./icons";
import { submitRun } from "./leaderboard";
import { Sfx } from "./sfx";
import { AssetViewer } from "./viewer";
import { CharacterTest } from "./character";
import { deathLean, PlayerModel } from "./player-model";
import { QI, STATIC_LOAD_ORDER, StaticKind, StaticModels, quatAxis, quatMul, type StaticId } from "./static-model";
const FILL_PROPS: StaticId[] = ["env_tire_stack", "env_corrugated_sheets", "env_pallet_stack", "env_drum_cluster", "env_scrap_pipes", "env_fence_panel", "env_tire_stack", "env_drum_cluster"];
const LANDMARKS: StaticId[] = ["env_crane", "env_container_stack", "env_scrap_heap", "env_container_stack"];

export type SceneId = "gym" | "viewer" | "character";
export const SCENES: SceneId[] = ["gym", "viewer", "character"];
const SCENE_ALIASES: Record<string, SceneId> = { "char-test": "character", char: "character" };

export function sceneFromUrl(search = typeof location !== "undefined" ? location.search : ""): SceneId {
  const s = new URLSearchParams(search).get("scene");
  const id = s ? (SCENE_ALIASES[s] ?? s) : "gym";
  if (!SCENES.includes(id as SceneId)) {
    console.warn(`[gym] unknown ?scene=${s}; opening the gym`);
    return "gym";
  }
  return id as SceneId;
}

const DEG = Math.PI / 180;

/**
 * Oncoming camera presets. "mockup D" was matched by eye to share/media/review-1/D.png and is
 * recorded in docs/direction/kickoff-gym.md and the brief. Each has a portrait and a landscape
 * framing; the eye blends between them by aspect (portrait ≤ 0.56, landscape ≥ 1.33).
 * height: eye above the track (m); dist: eye ahead of the player along +Z (m); pitch: downward
 * tilt (deg); fov: vertical (deg); follow: share of the player's lane offset the eye follows.
 */
export const CAMERAS = [
  {
    // Default since the 2026-11-04 owner read ("not enough heads-up"): the eye sits farther ahead
    // of the player and lower, with a wider lens, so ~5–6 m of oncoming track shows between the
    // bottom of the frame and the player's feet (mockup D showed ~1–2 m). See kickoff-gym.md.
    name: "heads-up",
    portrait: { height: 3.0, dist: 8.6, pitch: 9, fov: 74, follow: 0.6 },
    landscape: { height: 2.1, dist: 9.0, pitch: 4, fov: 56, follow: 0.45 },
  },
  {
    name: "mockup D",
    portrait: { height: 3.5, dist: 5.8, pitch: 11, fov: 68, follow: 0.6 },
    landscape: { height: 2.7, dist: 6.0, pitch: 6, fov: 46, follow: 0.45 },
  },
  {
    name: "high read",
    portrait: { height: 5.2, dist: 7.5, pitch: 24, fov: 68, follow: 0.6 },
    landscape: { height: 4.6, dist: 6.5, pitch: 26, fov: 50, follow: 0.4 },
  },
  {
    name: "low chase",
    portrait: { height: 1.9, dist: 5.5, pitch: 2, fov: 72, follow: 0.7 },
    landscape: { height: 1.7, dist: 4.4, pitch: 4, fov: 54, follow: 0.5 },
  },
] as const;
export type CameraPreset = (typeof CAMERAS)[number];

/** A preset's framing at an aspect (width / height). */
export function framing(preset: CameraPreset, aspect: number) {
  const t = Math.min(1, Math.max(0, (aspect - 0.56) / (1.33 - 0.56)));
  const a = preset.portrait, b = preset.landscape;
  const l = (k: keyof typeof a) => a[k] + (b[k] - a[k]) * t;
  return { height: l("height"), dist: l("dist"), pitch: l("pitch"), fov: l("fov"), follow: l("follow") };
}

/** Incoming warnings (HUD radar, track lamps, lane pings) look this many seconds ahead (was 2.2). */
export const WARN_SECONDS = 3.5;
/** Under this many seconds a warning in the player's lane is "hot" (bright lamp, second ping). Was 1.2. */
export const HOT_SECONDS = 1.0;
/** The soft first ping waits until a hazard is this close (s); lamps still grow in from WARN_SECONDS. */
export const TICK_SECONDS = 2.0;
/** Draw window around the player (m behind = toward the mech, m ahead = toward the camera). */
const DRAW_BEHIND = 55, DRAW_AHEAD = 14;
/**
 * Track tiles, side junk and neon signs reach this far behind the player: deep into the haze
 * (hazeEnd 110), so the far end of the scenery is never a visible edge.
 */
export const SCENERY_BEHIND = 100;
/** Side junk grows out of the deck over this many metres in front of the player (toward the camera). */
export const SIDE_GROW = 7;
/**
 * Side junk height scale by distance d (m) behind the player (negative: between the player and
 * the camera). Flat SIDE_GROW m in front, 30% at the player (the near sides stay open, mockup D),
 * full 22 m back. Continuous in d, so as the run carries scenery past the player nothing pops:
 * walls rise smoothly from the deck instead of appearing at the player's depth.
 */
export function sideRise(_d: number) {
  // Owner 2026-11-04: side dressing must already stand at full size when it enters frame (no grow-in).
  return 1;
}
/** Stick / key x → strafe axis: a dead band to 0.25, full speed from 0.8. */
export function strafeAxis(moveX: number) {
  const m = Math.abs(moveX);
  return m <= 0.25 ? 0 : Math.sign(moveX) * Math.min(1, (m - 0.25) / 0.55);
}

/**
 * Metres of oncoming track visible between the bottom of the frame and the player: the eye's
 * distance ahead minus where its lowest ray meets the ground (height / tan(pitch + fov/2)).
 */
export function visibleAhead(f: { height: number; dist: number; pitch: number; fov: number }) {
  const a = (f.pitch + f.fov / 2) * DEG;
  const near = a >= Math.PI / 2 ? 0 : f.height / Math.tan(a);
  return Math.max(0, f.dist - near);
}
const TRACK_HALF = 2.5;
/** The mech placeholder's draw scale (5 m boxes → ~6 m) and draw distance for a rule gap. */
export const MECH_SCALE = 1.2;
/** The junk mech GLB is drawn at its contract height (5 m): scale 1. */
export const MECH_GLB_SCALE = 1;
/** Intro cutscene length (s). */
export const INTRO_LEN = 3.2;
export const mechDrawGap = (gap: number) => 6 + gap * 1.5;
/** The resolution governor's floor (device pixels). */
const MIN_PIXELS = 350_000;
/** Scenery step (junk walls, neon signs, and the greybox track fallback). */
const TILE = 4;
/**
 * The env_scrapyard_lane GLB tile: 8 m along +Z from its start edge, deck top at y = 0. The sim has
 * no tile grid (gaps sit at any z), so the floor between two gaps is split into whole tiles of
 * nominal 8 m, each stretched a little along Z (round(L / 8) tiles over a run of length L), so every
 * tile edge next to a gap is exactly the sim's gap edge. See laneTiles().
 */
export const LANE_TILE = 8;
type Smash = { t: number; car: boolean; x: number; z: number; v: number[]; axis: number[]; spin: number };
const smashKey = (o: { kind: number; lane: number; z: number }) => `${o.kind}:${o.lane}:${o.z.toFixed(2)}`;

/** Floor tiles [start, end] for a course: runs between gaps, each cut into ~LANE_TILE pieces. */
export function laneTiles(gaps: { z: number; halfL: number }[], from: number, to: number): [number, number][] {
  const g = [...gaps].sort((a, b) => a.z - b.z);
  const runs: [number, number][] = [];
  let a = from;
  for (const o of g) {
    const g0 = o.z - o.halfL, g1 = o.z + o.halfL;
    if (g0 > a) runs.push([a, g0]);
    a = Math.max(a, g1);
  }
  if (to > a) runs.push([a, to]);
  const out: [number, number][] = [];
  for (const [u, v] of runs) {
    const n = Math.max(1, Math.round((v - u) / LANE_TILE));
    for (let i = 0; i < n; i++) out.push([u + ((v - u) * i) / n, u + ((v - u) * (i + 1)) / n]);
  }
  return out;
}

const C = {
  track: hex(0x8a8f98),
  trackDark: hex(0x6d727c),
  laneLine: hex(0xd8dde6),
  railYellow: hex(0xffc93d),
  railBlack: hex(0x23232b),
  pit: hex(0x2a1d2e),
  junk: [hex(0xc2552f), hex(0x3d6fb6), hex(0xe0a43a), hex(0x5aa36b), hex(0xd8436e), hex(0x8b5a3c), hex(0x6a7f8f)],
  neonPink: hex(0xff4fa3),
  neonCyan: hex(0x48f0ff),
  neonGreen: hex(0x7dff6a),
  fur: hex(0x9a6b4a),
  furLight: hex(0xf1e4d2),
  mask: hex(0x3a2c2a),
  scarf: hex(0xe8452c),
  goggle: hex(0x5ec8ff),
  barrel: hex(0xc8402b),
  barrelBand: hex(0x3a3a44),
  car: hex(0x4e86c9),
  carHit: hex(0x8892a0),
  nut: hex(0xffc93d),
  /** Barrel hazard lamp — vivid orange, not gold (nuts use nut/railYellow). */
  lampBarrel: hex(0xff6a1a),
  flash: hex(0xffb347),
  mechA: hex(0x7d8a96),
  mechB: hex(0xc26a3a),
  mechC: hex(0x4f77a8),
  mechEye: hex(0xffe14d),
  magnet: hex(0xd8312f),
  gate: hex(0xf2f2f2),
  gateDark: hex(0x222228),
  bounds: hex(0x39ff88),
  boundsBad: hex(0xff3b5c),
  boundsNut: hex(0xffe14d),
};

/** Small deterministic hash for scenery (no RNG state, same every frame). */
const hash = (i: number, k: number) => {
  let h = (i * 374761393 + k * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export class ScrapyardGame implements Game {
  bounds: [number, number, number, number] = [-10, -100, 10, 1300];
  readonly scene: SceneId = sceneFromUrl();
  private rt!: GameRuntime;
  private sim!: Sim<GameExports>;
  private hud!: GymHud;
  private viewer: AssetViewer | null = null;
  private character: CharacterTest | null = null;
  /** The raccoon GLB for the gym's player (null: placeholder shapes). */
  private playerModel: PlayerModel | null = null;
  /** Mech, props, nut and lane GLBs (any missing one keeps its placeholder shapes). */
  private statics: StaticModels | null = null;
  /** laneTiles() for the current course, keyed by its gaps. */
  private tiles: { key: string; list: [number, number][] } = { key: "", list: [] };
  /** The non-gym scene, if any: both run no rules and own the camera. */
  private get preview(): AssetViewer | CharacterTest | null {
    return this.viewer ?? this.character;
  }
  /** Obstacle z values already pinged in the player's lane: [entered window, went hot]. */
  private pinged = new Map<number, number>();
  private showBounds = new URLSearchParams(location.search).has("bounds");
  private cam = 0;
  private jumpArmed = true;
  private runPhase = 0;
  /** Seconds since the round was lost (< 0 while alive): drives the death pose. */
  private deadT = -1;
  private landSquash = 0;
  private stumbleFlash = 0;
  /** Resolution governor: seconds spent under LOW_FPS while playing. */
  private slow = 0;
  private lastFrame = 0;
  private sfx!: Sfx;
  /** Seconds to the next mech footfall while playing. */
  private stompT = 0;

  async load(rt: GameRuntime, progress: (p: number, label?: string) => void) {
    this.rt = rt;
    this.sim = rt.sim as Sim<GameExports>;
    this.sfx = new Sfx(rt.audio);
    const ui = rt.audio.ui;
    ui.hover = () => this.sfx.play("ui_hover", 0.5);
    // Play and "press start" get the heavy engine-rev + gate-slam; every other press the steel lever clunk.
    ui.press = () => {
      const el = typeof document !== "undefined" ? document.activeElement : null;
      const big = !!el && (el.id === "press-start" || (el as HTMLElement).dataset?.act === "play");
      return this.sfx.play(big ? "ui_start" : "ui_click", big ? 0.75 : 0.8);
    };
    ui.back = () => this.sfx.play("ui_back", 0.8);
    ui.whoosh = () => this.sfx.play("ui_start", 0.7);
    rt.onPhase((ph, prev) => {
      this.sfx.load();
      if (ph === "title" || ph === "menu") rt.audio.playMusic("menu");
      else if (ph === "countdown" || ph === "playing") {
        rt.audio.playMusic("play");
        if (ph === "countdown" && (prev === "results" || prev === "ending" || prev === "paused")) this.sfx.play("retry", 0.8);
      }
    });
    progress(0, "Stacking scrap…");
    // A deep canyon floor under the track: gaps show it.
    rt.renderer.ground.color = C.pit;
    rt.renderer.ground.y = -7;
    rt.renderer.background = hex(0x3b2448);
    if (new URLSearchParams(location.search).has("practice")) this.sim.x.sim_param_set(PARAM.practice, 1);
    this.hud = new GymHud();
    const b = this.hud.buttons;
    b.bounds.addEventListener("click", () => (this.showBounds = !this.showBounds));
    b.practice.addEventListener("click", () => this.togglePractice());
    b.camera.addEventListener("click", () => (this.cam = (this.cam + 1) % CAMERAS.length));
    // The on-screen gym panel (Bounds / Practice / Camera) is a dev tool: it covered the top-left of the track in the
    // released game and in the phone view (owner, 2026-11-05). It shows in the asset viewer (Bounds) and with ?gym; the keys
    // X / V / G and the dev Debug panel's buttons do the same everywhere.
    if (this.scene === "viewer" || new URLSearchParams(location.search).has("gym")) document.body.classList.add("gym-tools");
    if (this.scene === "viewer") {
      this.sim.x.sim_set_mode(MODE.viewer);
      this.viewer = await AssetViewer.load(rt, progress);
      document.body.classList.add("scene-viewer");
    } else if (this.scene === "character") {
      this.sim.x.sim_set_mode(MODE.viewer);
      this.character = await CharacterTest.load(rt, progress, currentSkin().id);
      document.body.classList.add("scene-viewer", "scene-character");
    } else {
      // First playable frame waits only on the raccoon (~3.8 MB). The lane starts in parallel;
      // nut / barrel / car / mech stream in after Play and hot-swap over placeholders (mech last).
      this.statics = StaticModels.attach(rt);
      const laneReady = this.statics.ensure("env_scrapyard_lane");
      this.playerModel = await PlayerModel.load(rt, progress, currentSkin().id);
      void laneReady.then(() => {
        this.statics?.loadBackground(STATIC_LOAD_ORDER.filter((id) => id !== "env_scrapyard_lane"));
      });
    }
    Object.assign(rt.hooks, {
      scene: () => this.scene,
      player: () => this.player(),
      obstacles: () => this.obstacles(),
      camera: () => ({ preset: CAMERAS[this.cam].name, ...this.currentFraming(), eye: this.eye() }),
      viewer: () => this.viewer?.info() ?? null,
      character: () => this.character?.info() ?? null,
      pickClip: (c: number | string) => this.character?.pick(c),
      showBounds: () => this.showBounds,
      playerModel: () => this.playerModel?.info() ?? { loaded: false },
      staticModels: () => this.statics?.info() ?? { loaded: [], missing: [], pending: [], kinds: [] },
      laneTiles: () => this.tiles.list,
      customiseOpen: () => isCustomiseOpen(),
      previewSkin: (id: string) => void this.playerModel?.swap(id),
    });
    // Customise panel (menu-skin) dispatches sd-customise when browse/open/close changes.
    // Hide the old mesh immediately inside swap(); surface loading state for the chrome.
    // `pendingPreview` stops setCustomiseLoading's re-emit from starting a second swap.
    let customiseSwapGen = 0;
    let pendingPreview = "";
    window.addEventListener("sd-customise", () => {
      if (!isCustomiseOpen()) return;
      const id = customisePreviewId();
      if (!id || !this.playerModel) return;
      if (id === pendingPreview) return;
      const info = this.playerModel.info() as { id?: string; visible?: boolean };
      if (info.id === id && info.visible !== false) return;
      pendingPreview = id;
      const gen = ++customiseSwapGen;
      const name = SKINS.find((s) => s.id === id)?.name ?? "skin";
      setCustomiseLoading(true, `Loading ${name}…`);
      void this.playerModel.swap(id).finally(() => {
        if (gen !== customiseSwapGen) return;
        pendingPreview = "";
        setCustomiseLoading(false);
      });
    });
    progress(1, "Ready");
  }

  private togglePractice() {
    const on = this.sim.x.sim_param_get(PARAM.practice) > 0.5;
    this.sim.x.sim_param_set(PARAM.practice, on ? 0 : 1);
    if (!on) this.practiceRound = this.sim.f32("stats")[ST.round]; // practice this round: no leaderboard entry
  }

  /** Round index whose run was sent to the leaderboard / that used practice (one submit per round, none in practice). */
  private submittedRound = -1;
  private practiceRound = -1;

  /** A finished gym run (game over or finish) → Convex leaderboard: distance covered and nuts picked. */
  private reportRun(won: boolean) {
    const s = this.sim.f32("stats");
    const round = s[ST.round];
    if (this.preview || s[ST.mode] !== MODE.gym || round === this.submittedRound) return;
    if (s[ST.practice] > 0.5 || round === this.practiceRound) return;
    this.submittedRound = round;
    void submitRun(s[ST.distance], s[ST.nuts], won);
  }

  private player() {
    const p = this.sim.f32("player");
    return Object.fromEntries(Object.entries(PL).map(([k, i]) => [k, p[i]])) as Record<keyof typeof PL, number>;
  }

  private obstacles() {
    const v = this.sim.f32("obstacles");
    const out: { kind: number; lane: number; z: number; halfL: number; height: number; hit: boolean }[] = [];
    for (let i = 0; i < v.length; i += STRIDES.obstacles) {
      out.push({ kind: v[i + OB.kind], lane: v[i + OB.lane], z: v[i + OB.z], halfL: v[i + OB.halfL], height: v[i + OB.height], hit: v[i + OB.hit] > 0.5 });
    }
    return out;
  }

  reset() {
    this.hud.reset();
    this.jumpArmed = true;
    this.landSquash = this.stumbleFlash = 0;
    this.deadT = -1;
    this.preview?.reset();
    this.pinged.clear();
    this.smashed.clear();
    this.surge = 0;
  }

  startRound() {
    this.sim.x.sim_round_start();
  }

  /**
   * The viewer / character scenes open straight into control. Real play runs the mech intro
   * (beginIntro: it drops in, slams, roars, lunges) in place of the 3-2-1; a key or tap skips it.
   */
  skipCountdown() {
    return !!this.preview;
  }

  round(): RoundState {
    const s = this.sim.f32("stats")[ST.state];
    return s === STATE.playing ? "playing" : s === STATE.won ? "won" : s === STATE.lost ? "lost" : "ready";
  }

  input(snap: InputSnapshot) {
    if (snap.pressed.has("bounds")) this.showBounds = !this.showBounds;
    if (snap.pressed.has("camera")) this.cam = (this.cam + 1) % CAMERAS.length;
    if (snap.pressed.has("practice")) this.togglePractice();
    if (this.preview) {
      this.preview.input(snap);
      return;
    }
    const x = this.sim.x;
    // Sideways is free, continuous strafe: keys, d-pad, gamepad stick and touch drag all feed
    // moveX, which strafes every frame at the stick's strength; letting go stops where the player
    // is (no lane snap, no tap-to-lane nudge). Collisions stay lane-based: the sim counts the
    // nearest-lane corridor(s) the player overlaps.
    // Screen-left is −X under the oncoming camera (Camera.groundBasis right = +X at yaw π).
    x.sim_strafe(strafeAxis(snap.moveX));
    if (snap.moveY > -0.3) this.jumpArmed = true;
    let jump = snap.pressed.has("jump");
    if (jump) this.jumpArmed = false;
    else if (this.jumpArmed && snap.moveY < -0.6) {
      this.jumpArmed = false;
      jump = true;
    }
    if (jump) x.sim_jump();
  }

  event(kind: number, ev: Float32Array, i: number) {
    const { rt } = this;
    const a = rt.audio;
    const px = this.sim.f32("player");
    switch (kind) {
      case EV.nut: {
        const [x, y, z] = [ev[i + 2], ev[i + 3], ev[i + 4]];
        rt.particles.spawn({ kind: PARTICLE.ring, x, y, z, size: 0.9, life: 0.35, color: C.nut, glow: 0.8 });
        rt.particles.burst(5, { kind: PARTICLE.sparkle, x, y, z, size: 0.18, life: 0.4, color: C.nut, glow: 1 }, [1, 2.5], [1, 3]);
        const n = ev[i + 5];
        if (!this.sfx.play("pickup", 0.7, 1 + (n % 8) * 0.03)) a.tone("sine", 880 + (n % 8) * 60, 1320 + (n % 8) * 60, a.now, 0.08, 0.06);
        break;
      }
      case EV.stumble: {
        const [x, z] = [ev[i + 1], ev[i + 2]];
        this.stumbleFlash = 1;
        rt.camera.addTrauma(0.45);
        rt.particles.burst(10, { kind: PARTICLE.chip, x, y: 0.5, z: z + 0.3, size: 0.16, life: 0.6, color: C.barrel, gravity: 9 }, [2, 4], [2, 5]);
        rt.pops.pop(x, 1.6, z, "Stumble!", "bad", 0.8);
        if (!this.sfx.play("hit", 0.9)) {
          a.noise(a.now, 0.18, 300, 0.2, "lowpass");
          a.tone("square", 220, 110, a.now, 0.18, 0.05);
        }
        break;
      }
      case EV.jump:
        if (!this.sfx.play("jump", 0.7)) a.tone("triangle", 330, 660, a.now, 0.12, 0.05);
        break;
      case EV.land:
        this.landSquash = Math.min(1, ev[i + 3] / 8);
        this.sfx.play("land", Math.min(0.8, 0.3 + ev[i + 3] / 12));
        rt.particles.burst(5, { kind: PARTICLE.glow, x: ev[i + 1], y: 0.05, z: ev[i + 2], size: 0.25, life: 0.35, color: C.furLight }, [0.8, 1.6], [0.2, 0.6]);
        break;
      case EV.lane:
        if (!this.sfx.play("strafe", 0.35)) a.noise(a.now, 0.06, 1800, 0.05);
        break;
      case EV.win:
        this.reportRun(true);
        rt.particles.burst(30, { kind: PARTICLE.star, x: px[PL.x], y: 1.2, z: px[PL.z], size: 0.3, life: 1.2, color: C.nut, glow: 1 }, [2, 5], [3, 7]);
        if (!this.sfx.play("win", 0.9)) {
          a.tone("sine", 660, 990, a.now, 0.3, 0.08);
          a.tone("sine", 990, 1320, a.now + 0.12, 0.4, 0.06);
        }
        break;
      case EV.lose:
        this.reportRun(false);
        rt.camera.addTrauma(1);
        if (ev[i + 1] === LOSE.fall) this.sfx.play("fall", 0.8);
        else if (ev[i + 1] === LOSE.crash) this.sfx.play("hit", 1);
        if (!this.sfx.play("gameover", 0.8)) a.tone("sawtooth", 300, 80, a.now, 0.5, 0.07);
        break;
    }
  }

  private currentFraming() {
    const aspect = this.rt.canvas.clientWidth / Math.max(1, this.rt.canvas.clientHeight);
    return { aspect, ...framing(CAMERAS[this.cam], aspect) };
  }

  /** The oncoming eye: ahead of the player (+Z), looking back toward −Z at it and the mech. */
  eye(): EyePose {
    if (this.preview) return this.preview.eye();
    const p = this.sim.f32("player");
    const f = this.currentFraming();
    let y = f.height + Math.max(0, p[PL.ry]) * 0.25;
    const sh = this.shake * this.shake;
    y += Math.sin(this.rt.clock * 60) * sh * 0.25;
    if (this.introT >= 0) {
      // Intro: start pulled up and back over the player toward the mech, settle into the chase framing by the end.
      const u = Math.min(1, this.introT / INTRO_LEN), e = u * u * (3 - 2 * u);
      return {
        x: p[PL.rx] * f.follow + Math.sin(this.rt.clock * 53) * sh * 0.2,
        y: y + 2.5 * (1 - e), z: p[PL.rz] + f.dist + 3 * (1 - e),
        yaw: Math.PI, pitch: -(f.pitch * e + 4 * (1 - e)) * DEG, fovY: f.fov * DEG,
        shadowFocus: [p[PL.rx] * 0.5, p[PL.rz] - 3],
      };
    }
    return {
      x: p[PL.rx] * f.follow + Math.sin(this.rt.clock * 53) * sh * 0.2,
      y,
      z: p[PL.rz] + f.dist,
      yaw: Math.PI,
      pitch: -f.pitch * DEG,
      fovY: f.fov * DEG,
      shadowFocus: [p[PL.rx] * 0.5, p[PL.rz] - 3],
    };
  }

  frame(dt: number, snap: InputSnapshot, _phase: Phase): [number, number] {
    const s = this.sim.f32("stats");
    const p = this.sim.f32("player");
    this.landSquash = Math.max(0, this.landSquash - dt * 5);
    this.stumbleFlash = Math.max(0, this.stumbleFlash - dt * 2.5);
    if (s[ST.state] === STATE.lost) this.deadT = Math.max(0, this.deadT) + (this.deadT < 0 ? 0 : dt);
    else this.deadT = -1;
    if (this.deadT < 0) this.runPhase += dt * (p[PL.speed] / 1.6);
    // Mech footfalls: louder and quicker as it closes in.
    if (_phase === "playing" && !this.preview && s[ST.state] !== STATE.lost) {
      this.stompT -= dt;
      if (this.stompT <= 0) {
        const gap = Math.max(0, p[PL.rgap]);
        this.stompT = 0.55 + Math.min(0.35, gap * 0.03);
        this.sfx.play("stomp", Math.max(0.15, 0.7 - gap * 0.05), 0.95 + Math.random() * 0.1);
      }
    }
    if (this.introT >= 0) this.introT += dt;
    this.shake = Math.max(0, this.shake - dt * 1.5);
    {
      const gap = Math.max(0, p[PL.rgap]);
      const live = _phase === "playing" && s[ST.state] !== STATE.lost && !this.preview;
      // Surge beats (world.rs surge_at): the sim dips the comfort gap; here the mech roars, the
      // camera kicks and its stride quickens so the pressure reads before the gap closes.
      const surge = live ? surgeAt(p[PL.z], this.sim.x.sim_param_get(PARAM.surgeEvery)) : 0;
      if (surge > 0 && this.surge === 0) {
        this.sfx.play("stomp", 0.9, 0.75);
        this.shake = Math.max(this.shake, 0.4);
        this.rt.pops.pop(p[PL.rx], 2.2, p[PL.rz] - 1.5, "Mech surging!", "bad", 1);
      }
      this.surge = surge;
      const k = Math.max(0, Math.min(1, 1 - gap / 12));
      this.chaseK += (Math.max(k, surge * 0.9) - this.chaseK) * Math.min(1, dt * 3);
      this.mechPhase += dt * (live ? 1.3 + this.chaseK * 1.2 : 1);
      this.mechRunT += dt * (1.15 + 0.35 * surge);
      this.smashClock += dt;
      if (live) this.mechSmash(p);
    }
    this.govern(_phase);
    this.preview?.frame(dt);
    this.hud.update({
      progress: s[ST.distance] / Math.max(1, s[ST.course]),
      mechGap: p[PL.rgap],
      nuts: s[ST.nuts],
      touch: snap.touchActive,
      stick: this.rt.input.touchStick,
      camera: CAMERAS[this.cam].name,
      bounds: this.showBounds,
      practice: s[ST.practice] > 0.5,
    });
    if (!this.preview) this.pingLane(p);
    return [p[PL.rx], p[PL.rz]];
  }

  /**
   * A runner needs a steady frame rate more than full resolution: when frames stay under 24 fps
   * for 1.5 s of play (a weak phone GPU, software WebGL2 in CI), lower the renderer's pixel cap a
   * step (×0.6), down to 0.35 MP. It never raises it again in a session.
   */
  private govern(phase: Phase) {
    const r = this.rt.renderer;
    const now = performance.now();
    const dt = Math.min(1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (phase !== "playing" || r.maxPixels <= MIN_PIXELS || dt <= 0) return;
    this.slow = dt > 1 / 24 ? this.slow + dt : Math.max(0, this.slow - dt);
    if (this.slow < 1.5) return;
    this.slow = 0;
    const [w, h] = r.pixelSize;
    r.maxPixels = Math.max(MIN_PIXELS, Math.round(Math.min(r.maxPixels, w * h) * 0.6));
    console.info(`[gym] slow frames: render pixel cap → ${(r.maxPixels / 1e6).toFixed(2)} MP`);
  }

  /** The nearest hazard ahead in each lane within WARN_SECONDS: [kind, urgency 0..1, seconds, z]. */
  private warnings(pz: number, speed: number): [number, number, number, number][] {
    const out: [number, number, number, number][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const best = [Infinity, Infinity, Infinity];
    const reach = speed * WARN_SECONDS;
    const v = this.sim.f32("obstacles");
    for (let i = 0; i < v.length; i += STRIDES.obstacles) {
      const d = v[i + OB.z] - v[i + OB.halfL] - pz;
      if (d < 0 || d > reach || v[i + OB.hit] > 0.5) continue;
      const kind = v[i + OB.kind];
      const lanes = kind === OB_KIND.gap ? [-1, 0, 1] : [v[i + OB.lane]];
      for (const l of lanes) {
        if (d < best[l + 1]) {
          best[l + 1] = d;
          out[l + 1] = [kind, 1 - d / reach, d / speed, v[i + OB.z]];
        }
      }
    }
    return out;
  }

  /** The lanes the player is in right now (nearest, plus the neighbour while straddling). */
  private myLanes(p: Float32Array) {
    return lanesAt(p[PL.x], this.sim.x.sim_param_get(PARAM.laneWidth), this.sim.x.sim_param_get(PARAM.halfWidth));
  }

  /**
   * Audio heads-up for the player's own lane(s) (myLanes: straddling two lanes hears both): a
   * quiet tick once a hazard is within TICK_SECONDS, a sharper double beep when it goes hot
   * (< HOT_SECONDS). Once per hazard per stage.
   */
  private pingLane(p: Float32Array) {
    if (this.rt.phase !== "playing") return;
    const w = this.warnings(p[PL.z], Math.max(1, p[PL.speed]));
    let kind = 0, secs = Infinity, z = 0;
    for (const l of this.myLanes(p)) {
      const [k, , s, oz] = w[l + 1];
      if (k && s < secs) [kind, secs, z] = [k, s, oz];
    }
    if (!kind || secs > TICK_SECONDS) return;
    const stage = secs < HOT_SECONDS ? 2 : 1;
    const had = this.pinged.get(z) ?? 0;
    if (stage <= had) return;
    this.pinged.set(z, stage);
    const a = this.rt.audio;
    if (stage === 1) a.tone("sine", 520, 620, a.now, 0.05, 0.018);
    else if (!this.sfx.play("danger", 0.5)) {
      a.tone("square", 880, 880, a.now, 0.05, 0.03);
      a.tone("square", 1040, 1040, a.now + 0.08, 0.05, 0.03);
    }
    if (this.pinged.size > 64) this.pinged.clear();
  }

  /**
   * Track lamps: for each lane with a hazard inside the warning window, a glowing bar on the track
   * just inside the bottom of the frame (where oncoming track first shows), in the hazard's
   * colour, pulsing faster as it nears. Presentation only: it reads in-world before the hazard
   * itself is on screen.
   */
  private drawLamps(box: InstanceBatch, p: Float32Array, lw: number) {
    const f = this.currentFraming();
    const ahead = visibleAhead(f);
    const z = p[PL.rz] + Math.max(1.4, ahead - 0.6);
    const w = this.warnings(p[PL.z], Math.max(1, p[PL.speed]));
    w.forEach(([kind, u, secs, oz], i) => {
      if (!kind) return;
      // Once the hazard itself is nearer than the lamp line, it is on screen: no lamp.
      if (oz < z + 0.5) return;
      const hot = secs < HOT_SECONDS;
      const col = kind === OB_KIND.car ? C.boundsBad : kind === OB_KIND.gap ? C.neonPink : C.lampBarrel;
      // Grow in, don't shout: ease-in growth g (≈0 when the hazard enters the window, 1 at contact)
      // drives size, glow and pulse depth, so early lamps are a faint sliver and only the last
      // ~HOT_SECONDS reads loud (owner, 2026-11-05: difficulty).
      const g = u * u;
      const amp = 0.1 + 0.4 * u;
      const pulse = 1 - amp + amp * Math.abs(Math.sin(this.rt.clock * (2.5 + 11 * u)));
      const x = (i - 1) * lw;
      const glow = hot ? 2.6 : 0.12 + 1.3 * g;
      box.push(x, 0.02, z, 0, 0, 0, lw * (0.22 + 0.58 * g), 0.03, 0.06 + 0.5 * g, col, 0.6, 0, 0, 1, glow * pulse);
      // Chevron pair pointing at the player (toward −Z): fades in only past mid-window, scales with g.
      if (u > 0.4) {
        const c = Math.min(1, (u - 0.4) / 0.6);
        for (const s of [-1, 1]) box.push(x + s * 0.16 * c, 0.03, z - 0.25 - 0.2 * c, s * 0.7, 0, 0, 0.36 * c, 0.02, 0.08 * c, col, 0.6, 0, 0, 1, (hot ? 1.8 : 1.4 * c) * pulse);
      }
    });
  }

  draw(dt: number) {
    if (this.preview) {
      this.preview.draw(this.showBounds);
      return;
    }
    const b = this.rt.batches;
    const s = this.sim.f32("stats");
    const p = this.sim.f32("player");
    const lw = this.sim.x.sim_param_get(PARAM.laneWidth);
    const pz = p[PL.rz];
    const z0 = Math.max(-30, pz - DRAW_BEHIND), z1 = pz + DRAW_AHEAD;
    const zs0 = Math.max(-60, pz - SCENERY_BEHIND);
    const course = s[ST.course];
    const obs = this.obstacles();
    const gaps = obs.filter((o) => o.kind === OB_KIND.gap);

    const st = this.statics;
    st?.begin();
    const lane = st?.get("env_scrapyard_lane") ?? null;
    // Track: the lane GLB tiled between gaps (laneTiles), or greybox tiles if it did not load.
    const box = b[MESH.box];
    if (lane) {
      const key = `${course}|${gaps.map((g) => `${g.z}:${g.halfL}`).join(",")}`;
      if (key !== this.tiles.key) this.tiles = { key, list: laneTiles(gaps, -60, course + 80) };
      for (const [a, c] of this.tiles.list) {
        if (c < zs0 || a > z1) continue;
        lane.put([0, 0, a], QI, [1, 1, (c - a) / LANE_TILE]);
      }
    }
    // GLB side dressing (env-dressing.md): once the fill props stream in, the front junk row and
    // the box neon signs give way to tire stacks, drums, pallets, billboards, cranes, etc.
    if (st) this.drawDressing(st, pz, zs0, z1, dt);
    for (let t = Math.floor(zs0 / TILE); t * TILE < z1; t++) {
      const ta = t * TILE, tb = ta + TILE;
      if (!lane) for (const [a, c] of this.cutGaps(ta, tb, gaps)) {
        const len = c - a, mid = (a + c) / 2;
        box.push(0, -0.25, mid, 0, 0, 0, TRACK_HALF * 2, 0.5, len, t % 2 ? C.track : C.trackDark, 0.3, 0, 1, 0.6);
        for (const lx of [-0.5, 0.5]) box.push(lx * lw, 0.005, mid, 0, 0, 0, 0.05, 0.01, len * 0.7, C.laneLine, 0.2, 0, 0, 0);
      }
      // Rails: yellow/black blocks along both edges (they span gaps as a bridge rail).
      for (const side of [-1, 1]) {
        if (!lane) {
          box.push(side * (TRACK_HALF + 0.12), 0.25, ta + 1, 0, 0, 0, 0.24, 0.5, 2, t % 2 ? C.railYellow : C.railBlack, 0.3);
          box.push(side * (TRACK_HALF + 0.12), 0.25, ta + 3, 0, 0, 0, 0.24, 0.5, 2, t % 2 ? C.railBlack : C.railYellow, 0.3);
        }
        // (Owner 2026-11-04: no box/cube placeholder junk walls or box neon signs; side dressing is GLB props only, see drawDressing.)
      }
    }
    // Gap pits: dark rims so the hole reads.
    for (const g of gaps) {
      if (g.z + g.halfL < zs0 || g.z - g.halfL > z1) continue;
      for (const e of [-1, 1]) box.push(0, -0.3, g.z + e * g.halfL, 0, 0, 0, TRACK_HALF * 2, 0.6, 0.1, C.railBlack, 0.2, 0, 1, 0);
    }

    // Finish gate ahead of the player (toward the camera) at the course end.
    if (course > z0 && course < z1 + 30) {
      for (const side of [-1, 1]) {
        b[MESH.cylinder].push(side * (TRACK_HALF + 0.3), 0, course, 0, 0, 0, 0.3, 3.4, 0.3, C.gate, 0.5, 0, 1, 1, 0.3);
        box.push(side * (TRACK_HALF + 0.3), 2.2, course, 0, 0, 0, 0.12, 1.4, 0.12, C.neonGreen, 0.6, 0, 0, 1, 2);
      }
      for (let i = 0; i < 10; i++) box.push(-TRACK_HALF + 0.25 + i * 0.5, 3.2, course, 0, 0, 0, 0.5, 0.4, 0.15, i % 2 ? C.gate : C.gateDark, 0.4);
    }

    // Obstacles.
    const barrel = st?.get("prop_oil_barrel") ?? null, car = st?.get("prop_scrap_car") ?? null;
    this.drawSmashed(barrel, car);
    for (const o of obs) {
      if (o.z < z0 || o.z > z1) continue;
      if (o.kind !== OB_KIND.gap && this.smashed.has(smashKey(o))) continue;
      const x = o.lane * lw;
      if (o.kind === OB_KIND.barrel && barrel) {
        // A hit barrel tips over backward (−Z) about its base, lifted so its rim stays above ground.
        if (o.hit) barrel.put([x, 0.38, o.z - 0.1], quatAxis(1, 0, 0, -1.2));
        else barrel.put([x, 0, o.z]);
      } else if (o.kind === OB_KIND.car && car) {
        // A crashed car flashes pale and sits slightly askew.
        car.put([x, 0, o.z], o.hit ? quatAxis(0, 1, 0, 0.18) : QI, [1, 1, 1], o.hit ? 0.35 : 0);
      } else if (o.kind === OB_KIND.barrel) {
        const tip = o.hit ? 1.2 : 0;
        b[MESH.cylinder].push(x, o.hit ? 0.4 : 0, o.z, 0, tip, 0, 0.8, 0.85, 0.8, C.barrel, 0.45);
        if (!o.hit) for (const y of [0.22, 0.62]) b[MESH.cylinder].push(x, y, o.z, 0, 0, 0, 0.82, 0.06, 0.82, C.barrelBand, 0.3, 0, 0);
      } else if (o.kind === OB_KIND.car) {
        const col = o.hit ? C.carHit : C.car;
        box.push(x, 0.45, o.z, 0, 0, 0, 1.3, 0.8, 3.0, col, 0.5);
        box.push(x, 1.05, o.z - 0.2, 0, 0, 0, 1.1, 0.55, 1.6, col, 0.5);
        box.push(x, 1.05, o.z + 0.62, 0, 0, 0, 1.0, 0.45, 0.04, C.goggle, 0.8, 0, 0);
        for (const wx of [-0.62, 0.62]) for (const wz of [-1, 1]) b[MESH.cylinder].push(x + wx, 0.32, o.z + wz, 0, 0, Math.PI / 2, 0.6, 0.2, 0.6, C.railBlack, 0.2, 0, 0);
      }
      if (this.showBounds && o.kind !== OB_KIND.gap) {
        const hw = o.kind === OB_KIND.car ? HALF_W.car : HALF_W.barrel;
        this.wire(box, x, o.height / 2, o.z, hw, o.height / 2, o.halfL, o.hit ? C.boundsBad : C.bounds);
      }
      if (this.showBounds && o.kind === OB_KIND.gap) this.wire(box, 0, -0.05, o.z, TRACK_HALF, 0.05, o.halfL - 0.1, C.boundsBad);
    }

    // Nuts: gold hex nuts facing the camera, spinning about Y (the GLB pivot is centre-bottom).
    const nv = this.sim.f32("nuts");
    const clock = this.rt.clock;
    const nut = st?.get("prop_hex_nut") ?? null;
    for (let i = 0; i < nv.length; i += STRIDES.nuts) {
      const z = nv[i + NU.z];
      if (nv[i + NU.collected] > 0.5 || z < z0 || z > z1) continue;
      const x = nv[i + NU.x], y = nv[i + NU.y] + Math.sin(clock * 3 + z) * 0.06;
      if (nut) nut.put([x, y - 0.25, z], quatAxis(0, 1, 0, clock * 2.5 + z), [1, 1, 1], 0, 0.4);
      else b[MESH.cylinder].push(x, y - 0.07, z, clock * 2.5 + z, Math.PI / 2, 0, 0.5, 0.14, 0.5, C.nut, 0.8, 0, 1, 1, 0.6);
      if (this.showBounds) this.wire(box, x, y, z, Math.max(NUT_HALF_W, lw * 0.5 + 0.05), 0.85, 0.6, C.boundsNut, 0.015);
    }

    this.drawLamps(box, p, lw);
    this.drawPlayer(p, dt);
    this.drawMech(p);
  }

  /** The raccoon GLB at the sim pose, or the placeholder raccoon if it did not load. */
  private drawPlayer(p: Float32Array, dt: number) {
    const b = this.rt.batches;
    if (this.playerModel) {
      this.playerModel.draw(p, dt, this.landSquash, this.stumbleFlash > 0 ? 0.6 * this.stumbleFlash : 0, this.deadT);
      if (this.showBounds) {
        const hw = this.sim.x.sim_param_get(PARAM.halfWidth), h = this.sim.x.sim_param_get(PARAM.height);
        this.wire(b[MESH.box], p[PL.rx], Math.max(-3, p[PL.ry]) + h / 2, p[PL.rz], hw, h / 2, PLAYER_HALF_L, C.bounds);
      }
      return;
    }
    // Placeholder raccoon (fur body, mask, ears, scarf, goggles), feet at its origin, facing +Z.
    const x = p[PL.rx], y = Math.max(-3, p[PL.ry]), z = p[PL.rz];
    const dead = this.deadT >= 0;
    const grounded = !dead && p[PL.grounded] > 0.5;
    const bob = grounded ? Math.abs(Math.sin(this.runPhase * Math.PI)) * 0.08 : 0;
    const sq = this.landSquash * 0.18;
    const lean = dead ? deathLean(this.deadT) : p[PL.stumble] > 0 ? -0.35 * p[PL.stumble] : 0.12;
    const flash = this.stumbleFlash > 0 ? 0.6 * this.stumbleFlash : 0;
    const yb = y + bob;
    const sph = b[MESH.sphere], box = b[MESH.box];
    // Legs (alternating).
    const sw = dead ? 0 : grounded ? Math.sin(this.runPhase * Math.PI) * 0.25 : 0.15;
    for (const side of [-1, 1]) box.push(x + side * 0.13, yb + 0.18, z + side * sw * 0.6, 0, side * sw, 0, 0.16, 0.36, 0.18, C.mask, 0.3, flash);
    sph.push(x, yb + 0.55, z, 0, lean, 0, 0.55, 0.6 * (1 - sq), 0.48, C.fur, 0.4, flash);
    sph.push(x, yb + 0.52, z + 0.14, 0, lean, 0, 0.34, 0.4, 0.25, C.furLight, 0.4, flash, 0);
    box.push(x, yb + 0.78, z + 0.02, 0, lean, 0, 0.5, 0.1, 0.46, C.scarf, 0.4, flash);
    // Head with mask, ears and goggles.
    const hy = yb + 1.0 - sq * 0.3;
    sph.push(x, hy, z + 0.04, 0, 0, 0, 0.5, 0.42, 0.44, C.fur, 0.4, flash);
    box.push(x, hy + 0.02, z + 0.24, 0, 0, 0, 0.42, 0.12, 0.06, C.mask, 0.3, flash, 0);
    sph.push(x, hy - 0.08, z + 0.26, 0, 0, 0, 0.18, 0.14, 0.14, C.furLight, 0.4, flash, 0);
    for (const side of [-1, 1]) {
      b[MESH.cone].push(x + side * 0.17, hy + 0.2, z, 0, 0, side * -0.3, 0.16, 0.2, 0.12, C.mask, 0.3, flash);
      sph.push(x + side * 0.1, hy + 0.17, z + 0.18, 0, 0, 0, 0.13, 0.11, 0.08, C.goggle, 0.9, flash, 0, 1, 0.5);
    }
    // Tail behind (−Z).
    sph.push(x, yb + 0.45, z - 0.32, 0, 0.6, 0, 0.18, 0.18, 0.4, C.mask, 0.3, flash);
    if (y > -0.5) this.rt.blob(x, z, 0.38 * (1 - Math.min(0.6, y * 0.3)), 0.55);
    if (this.showBounds) {
      const hw = this.sim.x.sim_param_get(PARAM.halfWidth), h = this.sim.x.sim_param_get(PARAM.height);
      this.wire(box, x, y + h / 2, z, hw, h / 2, PLAYER_HALF_L, C.bounds);
    }
  }

  /**
   * The junk mech, stomping along behind the player: the static GLB (5 m, faces +Z) playing its
   * stomp_loop clip when rigged (code bob / sway fallback for a static export), or the placeholder boxes if it did not load.
   */
  private flyClock = 0;
  /** Side props, landmarks, skyline/clouds and overhead flyovers. Pure decoration (no collision). */
  private drawDressing(st: StaticModels, pz: number, zs0: number, z1: number, dt: number) {
    const put = (id: StaticId, t: ArrayLike<number>, yaw = 0, sc = 1, sy = sc) => st.get(id)?.put(t, quatAxis(0, 1, 0, yaw), [sc, sy, sc]);
    // Ground: the side terrain strip (curb, cliff skirt to the pit, yard, scrap berm) tiled every
    // 8 m on both sides so the fill props and landmarks below stand on dirt instead of floating
    // over the y = −7 pit. Local x 0 is the track edge; the left side is the same tile turned π.
    const terrain = st.get("env_side_terrain");
    if (terrain) {
      const YAW_PI = quatAxis(0, 1, 0, Math.PI);
      for (let k = Math.floor(zs0 / LANE_TILE); k * LANE_TILE < z1 + LANE_TILE; k++) {
        terrain.put([TRACK_HALF, 0, k * LANE_TILE], QI);
        terrain.put([-TRACK_HALF, 0, (k + 1) * LANE_TILE], YAW_PI);
      }
    }
    // Fill: one prop per tile per side on the front row (x ≈ 4.3–5.5 m), height grows with sideRise.
    for (let t = Math.floor(zs0 / TILE); t * TILE < z1; t++) {
      for (const side of [-1, 1]) {
        const zc = t * TILE + 2 + (hash(t, side * 3 + 40) - 0.5) * 1.6;
        const rise = sideRise(pz - zc);
        if (rise <= 0.002) continue;
        const g = 1; // full size always (no grow-in)
        const yaw = (hash(t, side * 5 + 41) - 0.5) * 1.2 + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
        const x = side * (TRACK_HALF + 1.9 + hash(t, side * 7 + 42) * 1.1);
        if ((((t % 5) + 5) % 5) === (side > 0 ? 2 : 0) && st.get("env_neon_billboard")) {
          put("env_neon_billboard", [side * (TRACK_HALF + 1.6), 0, t * TILE + 2], side * -0.5, 0.75, 0.75 * g);
          continue;
        }
        const id = FILL_PROPS[Math.floor(hash(t, side * 9 + 43) * FILL_PROPS.length)];
        put(id, [x, 0, zc], yaw, 1.1 + hash(t, side + 44) * 0.5, (1.1 + hash(t, side + 44) * 0.5) * g);
      }
      // Landmarks: every 3 tiles one hero piece further out, alternating sides; only behind the player.
      if ((((t % 3) + 3) % 3) === 0) {
        const zc = t * TILE + 2, rise = sideRise(pz - zc);
        if (rise > 0.3) {
          const side = hash(t, 50) < 0.5 ? -1 : 1;
          const id = LANDMARKS[Math.floor(hash(t, 51) * LANDMARKS.length)];
          const g = 1;
          const sc = id === "env_crane" ? 0.9 + hash(t, 52) * 0.4 : 0.8 + hash(t, 52) * 0.5;
          put(id, [side * (TRACK_HALF + 9 + hash(t, 53) * 6), 0, zc], side > 0 ? -Math.PI / 2 + 0.4 : Math.PI / 2 - 0.4, sc, sc * g);
        }
      }
    }
    // Sky: skyline silhouette strip and drifting clouds, carried with the player (far behind the mech).
    this.flyClock += dt;
    const c = this.flyClock;
    for (const [dz, dx, sc] of [[95, 0, 1.2], [80, 60, 0.9], [80, -60, 0.9]] as const) put("env_skyline", [dx, -1, pz - dz], 0, sc);
    for (let i = 0; i < 5; i++) {
      const x = ((((c * 1.2 + i * 41) % 200) + 200) % 200) - 100;
      put("env_clouds", [x, 26 + (i % 3) * 7, pz - 60 - i * 9], 0, 0.8 + (i % 2) * 0.5);
    }
    // Flyovers: a scrap plane every 11 s flies from behind the mech over the track toward the camera,
    // and another crosses left↔right in the mid distance (offset phase).
    const plane = st.get("prop_scrap_plane");
    if (plane) {
      const T1 = 11, u = (c % T1) / T1; // 0→1
      const zz = pz - 90 + u * 130, xx = Math.sin(c * 0.4) * 4;
      // The plane GLB's nose points along −X (wings along Z, belly down), so yaw it onto the
      // flight direction (+π/2 → +Z; 0 → −X; π → +X) and bank about its own nose axis (local X).
      const bank = quatMul(quatAxis(0, 1, 0, Math.PI / 2), quatAxis(1, 0, 0, Math.sin(c * 0.8) * 0.25));
      plane.put([xx, 10 + Math.sin(u * Math.PI) * 3, zz], bank, [1.4, 1.4, 1.4]);
      const T2 = 17, v = ((c + 6) % T2) / T2, dir = Math.floor((c + 6) / T2) % 2 ? 1 : -1;
      plane.put([dir * (-70 + v * 140), 16, pz - 45], quatMul(quatAxis(0, 1, 0, dir > 0 ? Math.PI : 0), quatAxis(1, 0, 0, 0.2)), [1.1, 1.1, 1.1]);
    }
  }

  /** Chase: stomp_loop clock (advanced faster as the gap closes) and 0..1 intensity. */
  private mechPhase = 0;
  private chaseK = 0;
  /** Intro cutscene clock (s), or -1 when none is running. */
  private introT = -1;
  private introStomped = false;
  private skipIntro = () => { if (this.introT >= 0) this.introT = Math.max(this.introT, INTRO_LEN); };

  beginIntro(): boolean {
    if (this.preview) return false;
    this.introT = 0; this.introStomped = false;
    this.sfx.play("ui_start", 0.6);
    window.addEventListener("keydown", this.skipIntro);
    window.addEventListener("pointerdown", this.skipIntro);
    return true;
  }
  introActive(): boolean {
    if (this.introT < 0) return false;
    if (this.introT >= INTRO_LEN) {
      this.introT = -1;
      window.removeEventListener("keydown", this.skipIntro);
      window.removeEventListener("pointerdown", this.skipIntro);
      return false;
    }
    return true;
  }
  /** Mech pose during the intro: drops from the sky (0–0.7 s), slams down, roars (idle, reared back), lunges forward. */
  private introPose() {
    const t = this.introT;
    if (t < 0) return null;
    if (t < 0.7) { const u = t / 0.7; return { y: 18 * (1 - u * u), dz: 0, lean: 0, squash: 1, clip: "idle", time: 0 }; }
    if (!this.introStomped) { this.introStomped = true; this.sfx.play("stomp", 1, 0.8); this.shake = 0.6; }
    const k = t - 0.7;
    if (k < 0.25) return { y: 0, dz: 0, lean: 0.1, squash: 1 - 0.18 * Math.sin(k / 0.25 * Math.PI), clip: "idle", time: k };
    if (k < 1.6) { const u = (k - 0.25) / 1.35; return { y: 0.3 * Math.sin(u * Math.PI), dz: 0, lean: -0.3 * Math.sin(u * Math.PI), squash: 1, clip: "idle", time: k }; }
    const u = Math.min(1, (k - 1.6) / (INTRO_LEN - 2.3));
    return { y: 0, dz: u * 1.5, lean: 0.25 * u, squash: 1, clip: "stomp_loop", time: k * 1.6 };
  }
  private shake = 0;
  /** Current mech surge strength (0..1, surgeAt). */
  private surge = 0;
  /** Run-clip clock for surges (s). */
  private mechRunT = 0;
  /** Hazards the mech has smashed: key → launch (time, start, velocity, spin). */
  private smashed = new Map<string, Smash>();
  private smashClock = 0;

  private mechChasing(): boolean {
    return this.rt.phase === "playing" && this.sim.f32("stats")[ST.state] === STATE.playing;
  }

  /**
   * Mech smash: when the drawn mech's front (its z + ~1.2 m) reaches a barrel or scrap car the
   * player has already passed, the hazard launches up and off the deck, tumbling, with a burst
   * of chips, sparks and a flash; hit/stomp SFX at low volume. Presentation only (the sim's
   * obstacle stays where it was, behind the player).
   */
  private mechSmash(p: Float32Array) {
    const mz = p[PL.rz] - mechDrawGap(p[PL.rgap]) + 1.2;
    const lw = this.sim.x.sim_param_get(PARAM.laneWidth);
    for (const o of this.obstacles()) {
      if (o.kind === OB_KIND.gap || o.z > mz || o.z < mz - 6) continue;
      const key = smashKey(o);
      if (this.smashed.has(key)) continue;
      const x = o.lane * lw, car = o.kind === OB_KIND.car;
      const h = hash(Math.round(o.z * 10), o.lane + 7);
      const side = o.lane !== 0 ? Math.sign(o.lane) : h < 0.5 ? -1 : 1;
      const ax = [0.3 + h, 0.4, 1 - h], n = Math.hypot(ax[0], ax[1], ax[2]);
      this.smashed.set(key, {
        t: this.smashClock, car, x, z: o.z,
        v: [side * (car ? 3 + h * 2 : 4 + h * 3), car ? 7 + h * 2 : 8 + h * 3, car ? 5 : 6 + h * 3],
        axis: [ax[0] / n, ax[1] / n, ax[2] / n], spin: (car ? 5 : 9) * (h < 0.5 ? -1 : 1),
      });
      const P = this.rt.particles, col = car ? C.car : C.barrel, y = car ? 0.8 : 0.5;
      P.spawn({ kind: PARTICLE.glow, x, y, z: o.z, size: car ? 3.2 : 2.4, life: 0.28, color: C.flash, glow: 2.5 });
      P.spawn({ kind: PARTICLE.ring, x, y: 0.1, z: o.z, size: car ? 3 : 2.2, life: 0.4, color: C.flash, glow: 1 });
      P.burst(car ? 18 : 14, { kind: PARTICLE.chip, x, y, z: o.z, size: 0.3, life: 0.9, color: col, gravity: 14 }, [3, 7], [4, 9]);
      P.burst(10, { kind: PARTICLE.chip, x, y, z: o.z, size: 0.22, life: 0.8, color: C.railBlack, gravity: 14 }, [2, 6], [3, 7]);
      P.burst(12, { kind: PARTICLE.sparkle, x, y, z: o.z, size: 0.22, life: 0.5, color: C.flash, glow: 1.5, drag: 2 }, [4, 9], [2, 6]);
      this.sfx.play("hit", car ? 0.5 : 0.4, car ? 0.7 : 0.9);
      this.shake = Math.max(this.shake, car ? 0.25 : 0.15);
    }
  }

  /** Smashed hazards in flight: ballistic arc under gravity, tumbling, gone after 2.4 s (or into the pit). */
  private drawSmashed(barrel: StaticKind | null, car: StaticKind | null) {
    const b = this.rt.batches;
    for (const [key, m] of this.smashed) {
      const t = this.smashClock - m.t;
      if (t > 2.4) { if (t > 60) this.smashed.delete(key); continue; }
      const y = (m.car ? 0 : 0.1) + m.v[1] * t - 9 * t * t;
      const pos = [m.x + m.v[0] * t, y, m.z + m.v[2] * t];
      const q = quatAxis(m.axis[0], m.axis[1], m.axis[2], m.spin * t);
      const model = m.car ? car : barrel;
      if (model) model.put(pos, q, [1, 1, 1], Math.max(0, 0.5 - t));
      else if (m.car) b[MESH.box].push(pos[0], pos[1] + 0.45, pos[2], m.spin * t, m.spin * t * 0.6, 0, 1.3, 0.8, 3.0, C.car, 0.5);
      else b[MESH.cylinder].push(pos[0], pos[1], pos[2], m.spin * t, m.spin * t * 0.6, 0, 0.8, 0.85, 0.8, C.barrel, 0.45);
    }
  }

  private drawMech(p: Float32Array) {
    const b = this.rt.batches;
    // Not on the title / menu: the menu shot is the raccoon and the yard; the mech drops in with the intro.
    const ph = this.rt.phase;
    if (!this.preview && (ph === "boot" || ph === "title" || ph === "menu")) return;
    if (!this.preview && ph === "countdown" && this.introT < 0) return;
    // Drawn farther back than the rule gap so it looms above the horizon like mockup D instead
    // of standing on the hazards the player has to read; the HUD meter and the bounds overlay's
    // catch line show the real gap.
    const z = p[PL.rz] - mechDrawGap(p[PL.rgap]);
    const mech = this.statics?.get("char_junk_mech") ?? null;
    if (mech) {
      const t = this.rt.clock, S = MECH_GLB_SCALE;
      const intro = this.introPose();
      if (intro && mech.animator) {
        mech.putAnimated([0, intro.y, z + intro.dz], quatAxis(1, 0, 0, intro.lean), [S, S, S * intro.squash], intro.clip, intro.time);
      } else if (mech.animator && !this.mechChasing()) {
        // Not chasing (paused, round over, ready): stand on the idle clip instead of walking in place.
        mech.putAnimated([0, 0, z], quatAxis(0, 1, 0, Math.sin(t * 0.5) * 0.05), [S, S, S], "idle", t);
      } else if (mech.animator && this.surge > 0.12 && mech.animator.clipNames.includes("run")) {
        // Surge: the exaggerated run clip (big counter-swinging arms, pitched forward), sped up,
        // with a hard forward lean, a deep lunge and a side-to-side roll so it reads at distance.
        const k = this.surge, ph = this.mechRunT * Math.PI * 4; // two strides a clip second
        const lun = Math.abs(Math.sin(ph / 2)) * (0.6 + 0.9 * k);
        const r = quatMul(quatAxis(0, 0, 1, Math.sin(ph / 2) * 0.07 * k), quatAxis(1, 0, 0, 0.22 + 0.22 * k));
        mech.putAnimated([Math.sin(ph / 2) * 0.2, Math.abs(Math.cos(ph / 2)) * 0.35 * k, z + lun], r, [S, S, S], "run", this.mechRunT);
      } else if (mech.animator) {
        // Rigged: stomp_loop sped up with chase intensity, leaning forward and lunging on each step so it reads as pursuit.
        const lun = Math.abs(Math.sin(this.mechPhase * Math.PI * 2 / 0.79)) * (0.3 + this.chaseK * 0.6);
        const r = quatMul(quatAxis(0, 1, 0, Math.sin(t * 2) * 0.04), quatAxis(1, 0, 0, 0.12 + this.chaseK * 0.16));
        mech.putAnimated([Math.sin(this.mechPhase * 4) * 0.12, lun * 0.25, z + lun], r, [S, S, S], "stomp_loop", this.mechPhase);
      } else {
        const step = Math.sin(t * 4);
        const r = quatMul(quatAxis(0, 1, 0, Math.sin(t * 2) * 0.06), quatAxis(0, 0, 1, step * 0.05));
        mech.put([step * 0.08, Math.abs(step) * 0.22, z], r, [S, S, S]);
      }
      this.rt.blob(0, z, 1.9 * S, 0.5);
      if (this.showBounds) this.wire(b[MESH.box], 0, 0.05, p[PL.rz] - this.sim.x.sim_param_get(PARAM.catchGap), TRACK_HALF, 0.05, 0.02, C.boundsBad);
      return;
    }
    const S = MECH_SCALE;
    const scaled = (batch: InstanceBatch) => ({
      push: (x: number, y: number, zz: number, yaw: number, pitch: number, roll: number, sx: number, sy: number, sz: number, ...rest: [[number, number, number], ...number[]]) =>
        batch.push(x * S, y * S, z + (zz - z) * S, yaw, pitch, roll, sx * S, sy * S, sz * S, ...rest),
    });
    const box = scaled(b[MESH.box]), sph = scaled(b[MESH.sphere]), cyl = scaled(b[MESH.cylinder]);
    const t = this.rt.clock;
    const stomp = Math.abs(Math.sin(t * 4));
    const y = stomp * 0.25;
    const sway = Math.sin(t * 4) * 0.06;
    for (const side of [-1, 1]) {
      const lift = side * Math.sin(t * 4) > 0 ? stomp * 0.4 : 0;
      box.push(side * 0.8, 0.9 + lift, z + lift * 0.4, 0, 0, 0, 0.8, 1.8, 0.9, C.mechA, 0.4);
      box.push(side * 0.8, 0.15 + lift, z + 0.2 + lift * 0.4, 0, 0, 0, 1.0, 0.3, 1.3, C.mechC, 0.4);
    }
    box.push(0, 2.6 + y, z, sway, 0, sway * 0.5, 2.6, 1.8, 1.8, C.mechB, 0.4);
    box.push(-0.5, 2.9 + y, z + 0.92, 0, 0, 0.2, 0.9, 0.7, 0.06, C.mechC, 0.4, 0, 0);
    box.push(0.6, 2.3 + y, z + 0.92, 0, 0, -0.1, 0.7, 0.5, 0.06, C.mechA, 0.4, 0, 0);
    box.push(0, 4.0 + y, z + 0.1, sway, 0, 0, 1.5, 1.1, 1.3, C.mechA, 0.4);
    for (const side of [-1, 1]) sph.push(side * 0.35, 4.1 + y, z + 0.78, 0, 0, 0, 0.42, 0.42, 0.2, C.mechEye, 0.8, 0, 1, 1, 1.5);
    box.push(0, 3.65 + y, z + 0.76, 0, 0, 0, 0.9, 0.12, 0.08, C.railBlack, 0.3, 0, 0);
    // Arms: the left holds up the magnet.
    box.push(-1.7, 3.3 + y, z + 0.3, 0, -0.5, 0.5, 0.5, 1.8, 0.5, C.mechC, 0.4);
    box.push(-2.2, 4.4 + y, z + 0.7, 0, 0, 0, 0.9, 0.35, 0.35, C.magnet, 0.6);
    for (const s of [-1, 1]) box.push(-2.2 + s * 0.35, 4.75 + y, z + 0.7, 0, 0, 0, 0.22, 0.5, 0.35, C.magnet, 0.6);
    box.push(1.7, 2.4 + y, z + 0.2, 0, 0.3, -0.3, 0.5, 1.7, 0.5, C.mechB, 0.4);
    for (const s of [-1, 1]) cyl.push(s * 0.5, 4.55 + y, z - 0.1, 0, 0, s * 0.3, 0.06, 0.6, 0.06, C.railBlack, 0.3, 0, 0);
    this.rt.blob(0, z, 2.2 * S, 0.5);
    if (this.showBounds) {
      const catchGap = this.sim.x.sim_param_get(PARAM.catchGap);
      // The catch line: reaching it is "caught".
      this.wire(b[MESH.box], 0, 0.05, p[PL.rz] - catchGap, TRACK_HALF, 0.05, 0.02, C.boundsBad);
    }
  }

  /** The parts of [a, b] not inside any gap. */
  private cutGaps(a: number, b: number, gaps: { z: number; halfL: number }[]): [number, number][] {
    let parts: [number, number][] = [[a, b]];
    for (const g of gaps) {
      const g0 = g.z - g.halfL, g1 = g.z + g.halfL;
      parts = parts.flatMap(([u, v]): [number, number][] => {
        if (g1 <= u || g0 >= v) return [[u, v]];
        const out: [number, number][] = [];
        if (g0 > u) out.push([u, g0]);
        if (g1 < v) out.push([g1, v]);
        return out;
      });
    }
    return parts.filter(([u, v]) => v - u > 0.01);
  }

  /** A collision box drawn as 12 thin glowing edges. */
  private wire(box: InstanceBatch, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, col: [number, number, number], t = 0.025) {
    for (const sy of [-1, 1]) for (const sz of [-1, 1]) box.push(cx, cy + sy * hy, cz + sz * hz, 0, 0, 0, hx * 2, t, t, col, 0, 0, 0, 0, 2);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box.push(cx + sx * hx, cy, cz + sz * hz, 0, 0, 0, t, hy * 2, t, col, 0, 0, 0, 0, 2);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) box.push(cx + sx * hx, cy + sy * hy, cz, 0, 0, 0, t, t, hz * 2, col, 0, 0, 0, 0, 2);
  }

  /** Menu: a slow drift across the start line and the empty yard behind (the mech arrives with the intro).
   * Customise preview: hero-like close-up on the player so the skin fills the frame. */
  menuShot(t: number): Shot {
    if (this.preview) return this.preview.menuShot(t);
    const p = this.sim.f32("player");
    if (isCustomiseOpen()) {
      return {
        target: [p[PL.rx], 0.95, p[PL.rz]],
        pitch: 0.2,
        yaw: 0.22 * Math.sin(t * 0.22),
        distance: 4.0,
      };
    }
    return { target: [0, 1.6, p[PL.rz] - 4], pitch: 0.18, yaw: 0.35 * Math.sin(t * 0.15), distance: 11 };
  }

  heroShot(): Shot {
    if (this.preview) return this.preview.menuShot(0);
    const p = this.sim.f32("player");
    return { target: [p[PL.rx], 0.9, p[PL.rz]], pitch: 0.22, yaw: 0.25, distance: 4.5 };
  }

  summary(): RoundSummary {
    const s = this.sim.f32("stats");
    const won = s[ST.state] === STATE.won;
    const reason = s[ST.loseReason];
    const why = reason === LOSE.caught ? "The mech caught you" : reason === LOSE.fall ? "Fell into a gap" : reason === LOSE.crash ? "Crashed into a scrap car" : "Run over";
    const dist = `${s[ST.distance].toFixed(0)} m`;
    const nuts = String(s[ST.nuts] | 0);
    // Custom scrapyard plate: ribbon + title + two glanceable tiles (banner art removed).
    const card = document.createElement("div");
    card.className = `sd-results ${won ? "won" : "lost"}`;
    card.innerHTML =
      `<div class="sd-results-body">` +
      `<div class="sd-results-ribbon">${won ? "Finished!" : "Busted"}</div>` +
      `<h2 class="sd-results-title">${won ? "You outran the mech" : why}</h2>` +
      `<div class="sd-results-stats">` +
      `<div class="sd-stat dist"><span class="sd-stat-ico">${icon("flag")}</span><span class="sd-stat-lbl">Distance</span><b class="sd-stat-val">${dist}</b></div>` +
      `<div class="sd-stat nuts"><span class="sd-stat-ico"><i class="sd-nut" aria-hidden="true"></i></span><span class="sd-stat-lbl">Hex nuts</span><b class="sd-stat-val">${nuts}</b></div>` +
      `</div></div>`;
    return {
      won,
      ribbon: won ? "Finished!" : "Busted",
      title: won ? "You outran the mech" : why,
      rows: [
        ["Distance", dist],
        ["Hex nuts", nuts],
      ],
      note: "",
      custom: card,
      buttons: { again: "Retry" },
    };
  }

  countdown(_n: number) {}

  showHud(on: boolean) {
    this.hud.show(on);
  }

  stats(): Record<keyof typeof ST, number> {
    const s = this.sim.f32("stats");
    return Object.fromEntries(Object.entries(ST).map(([k, i]) => [k, s[i]])) as Record<keyof typeof ST, number>;
  }

  debugActions(): DebugAction[] {
    return [
      { label: "Bounds", title: "Toggle collision bounds (X)", run: () => (this.showBounds = !this.showBounds) },
      { label: "Camera", title: "Cycle the camera preset (V)", run: () => (this.cam = (this.cam + 1) % CAMERAS.length) },
      { label: "Practice", title: "Toggle practice: nothing is lethal (G)", run: () => this.togglePractice() },
    ];
  }

  debugInfo(): string {
    const s = this.stats();
    const f = this.currentFraming();
    return `scene ${this.scene} · phase ${this.rt.phase} · round ${s.round} · seed ${this.rt.seed}\n` +
      `z ${s.distance.toFixed(1)}/${s.course} m · nuts ${s.nuts}/${s.nutsTotal} · mech gap ${s.mechGap.toFixed(2)} m · stumbles ${s.stumbles}\n` +
      `camera ${CAMERAS[this.cam].name}: h ${f.height.toFixed(2)} d ${f.dist.toFixed(2)} pitch ${f.pitch.toFixed(1)}° fov ${f.fov.toFixed(1)}° aspect ${f.aspect.toFixed(2)} · ${this.rt.fps} fps`;
  }
}
