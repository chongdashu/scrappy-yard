// The contract between the engine and a game.
//
// The engine (this folder) owns the generic front end: loading, press start, menu, countdown,
// pause, settings, the results card shell, input, camera, renderer, glTF, platform, saves and
// the DEV panels. A game supplies its rules (a Rust crate on the engine's C ABI) and, through
// its entry module `<gameDir>/src/index.ts`, a `GameModule`: the `Game` that presents the
// sim, its HUD markup and CSS, tips, help text, sounds (on the engine's AudioBus), results
// summary, debug actions and tuning table. Its identity, release allowlist, preview models and
// smoke driver live in `<gameDir>/game.json` (docs/starter.md).
//
// Engine code reaches the game only through the `@game` alias (src/main.ts) and the build-time
// identity in src/config.ts; games import the engine as `@engine/…`.
import type { Volumes } from "./audio";
import type { PauseOnBlur } from "./focus";
import type { CameraMode, CameraRig, EyePose, Shot } from "./camera";
import type { Style } from "./gpu/renderer";
import type { ActionMap, InputSnapshot } from "./input";
import type { LookOptions } from "./look";
import type { TrackDef } from "./music";
import type { WavedashOptions } from "./platform/wavedash";
import type { GameRuntime } from "./runtime";
import type { TouchButtonDef } from "./ui/touch-buttons";
import type { MenuEntry } from "./ui/menu-extra";
import type { SimLayout } from "./wasm";

export type { SimLayout } from "./wasm";
export type { MenuEntry } from "./ui/menu-extra";

/** Where the front-end flow is. The flow owns it; the game reads it. */
export type Phase = "boot" | "title" | "menu" | "countdown" | "playing" | "paused" | "ending" | "results";

/** The round's authoritative state as reported by the sim. */
export type RoundState = "ready" | "playing" | "won" | "lost";

/** The page-visible part of the active game's game.json (injected at build time; src/config.ts). */
export interface GameConfig {
  id: string;
  title: string;
  /** Every saved key starts with it (src/platform/storage-key.ts). */
  storagePrefix: string;
  version: string;
  /** The DEV model preview's list (preview.html). URLs are relative to the game's public/. */
  preview: { models: PreviewModel[] };
  /** Host services the game opts into (game.json `platform`, validated by scripts/lib/active-game.mjs); all off when absent. */
  platform?: { wavedash?: WavedashOptions };
}

export interface PreviewModel {
  label: string;
  url: string;
}

/** A DEV tuning slider for one sim param: [id, label, min, max, step]; ids match the game's `params!` table. */
export type ParamDef = [id: number, label: string, min: number, max: number, step: number];

export interface RoundSummary {
  won: boolean;
  /** Ribbon and headline for the results card. */
  ribbon: string;
  title: string;
  /** Label/value rows (text only; values are escaped). */
  rows: [string, string][];
  /** A short line under the rows (a record, a tip), or "". */
  note: string;
  /**
   * The game's own results markup (a receipt, a scoreboard). Shown in place of the ribbon, title, rows and note, which stay in the page as the
   * plain text (the card is still labelled by the title). The card's Play again and Menu buttons stay. The element is built fresh for
   * each round; the game owns whatever animation it does.
   */
  custom?: HTMLElement;
  /** An element of the game's own under the card's rows and note (a rank on a board, say), when it gives one. The standard card stays as it is. */
  extra?: HTMLElement;
  /**
   * The card's two buttons. `again` is the first (default "Play again"): a label to rename it, or `false` to leave it off (then the second becomes the
   * card's one primary button). `menu` renames the second (default "Menu"), which still leaves the round for the menu screen.
   */
  buttons?: { again?: string | false; menu?: string };
}

export interface DebugAction {
  label: string;
  title?: string;
  /** A heading to list the button under (buttons with the same group sit together, in the order the groups first appear). */
  group?: string;
  run(): void;
  /** Greyed out when false (evaluated when the panel repaints). */
  enabled?: () => boolean;
}

/**
 * What `<gameDir>/src/index.ts` default-exports. Only `abi` and `create` are required. The
 * game's stylesheet is a side-effect import in that module (`import "./style.css"`); it loads
 * after the engine's src/style.css, so it can restyle anything.
 */
export interface GameModule {
  /** The sim ABI mirror (the game's sim-abi.ts): checked against sim.wasm at boot. */
  abi: SimLayout;
  /** A new Game (called once, after the host adapter and saves are ready). */
  create(): Game;
  /** One line under the title on the loading screen. */
  tagline?: string;
  /**
   * How the first press on the ready screen reaches the menu. "wipe" (default): the engine's circular wipe covers the swap and
   * the menu shot starts from t = 0. "cut": the loading screen goes at once and the camera and menu clock keep running, for a
   * game whose world already shows through its ready screen (a translucent `#boot.is-ready` in its boot style).
   */
  startTransition?: "wipe" | "cut";
  /**
   * How Play leaves the menu. "fade" (default): the menu fades out over the live scene. "wipe": the screen wipe covers the
   * swap (menu gone, round reset) and opens on the round, as returning to the menu does.
   */
  playTransition?: "fade" | "wipe";
  /**
   * The screen wipe's look. "circle" (default): a disc grows from the press. "shutter": two doors (`#wipe > .wipe-door`)
   * slam shut from top and bottom, hold a beat, and part again; style them under `#wipe.shutter .wipe-door` in the game's CSS.
   */
  wipeStyle?: "circle" | "shutter";
  /** Loading-screen tips, rotated while the game loads. */
  tips?: string[];
  /**
   * HUD markup. `top` goes into the top bar before the engine's mute and pause buttons (it is
   * a flex row marked data-cover="top", so the camera keeps the focus below it); `overlay`
   * goes into #hud after the bar (hints, meters, anything positioned by the game's CSS).
   */
  hud?: { top?: string; overlay?: string };
  /**
   * Body of the "How to play" popup (markup). The engine lists pause and mute when absent. `false` takes "How to play" out altogether:
   * no menu button, no pause-card entry, and the popup never opens.
   */
  help?: string | false;
  /**
   * The pause card. `restart: false` leaves "Restart round" off it, as `RoundSummary.buttons.again: false` does on the results card: for a
   * round the player cannot restart alone, such as a shared online world. Restart stays by default.
   */
  pause?: { restart?: boolean };
  /**
   * The game's own menu entries, after the engine's (`extra`): each opens a standard popup with the game's markup ("About", "Credits")
   * or, with an `href`, is a link (a test scene, another page),
   * with the same focus, Escape, back and focus-return behaviour as Settings; `pause: true` also lists it on the pause card, and
   * `GameRuntime.openPopup(id)` opens it from game code (a results-card button). See src/ui/menu-extra.ts. None by default.
   */
  menu?: { extra?: MenuEntry[] };
  /** Tuning sliders for the DEV panel (T on the dev server). */
  params?: ParamDef[];
  /**
   * What losing window focus (blur, a hidden tab, alt-tab out of a captured mouse) does to a round. "pause" (default) opens the
   * pause card and freezes the sim; "input" keeps the round running with the player's input withheld until focus returns (an online
   * round the server keeps simulating); "none" leaves focus alone. Esc out of a captured mouse pauses in every mode. See src/focus.ts.
   */
  pauseOnBlur?: PauseOnBlur;
  /** Extra input actions, merged over the engine's (DEFAULT_ACTIONS: pause, mute). */
  actions?: ActionMap;
  /** Camera framing overrides (CameraRig). */
  rig?: Partial<CameraRig>;
  /**
   * "follow" (default): the tilted follow camera around the ground focus `Game.frame` returns.
   * "first-person": the game supplies the eye every frame (`Game.eye`); menus, the countdown and
   * the results still use `menuShot`/`heroShot` orbits, blended in and out of the eye.
   * First person turns look input on (below) unless `look` says otherwise.
   */
  camera?: CameraMode;
  /**
   * Look input: mouse (click to capture, Esc releases and pauses), touch drag on the right of
   * the screen, gamepad right stick and the arrow keys (which then stop moving). Deltas arrive
   * in `InputSnapshot.lookX/lookY`. `true` = defaults; an object overrides sensitivities
   * (src/look.ts). Defaults to on for a first-person camera.
   */
  look?: boolean | Partial<LookOptions>;
  /**
   * On-screen action buttons for touch screens (each drives a named action from `actions`, held
   * while a finger is on it). The move stick stays on the left and the look drag on the right.
   */
  buttons?: TouchButtonDef[];
  /** The look (shader and post values) this game starts with; the DEV tuning panel edits on top. */
  style?: Partial<Style>;
  /**
   * Sound the engine's AudioBus is built with: named music tracks (`AudioBus.playMusic(name)`; see
   * src/music.ts, `native: true` for seamless loops) and the starting bus volumes (the player's
   * setting only ever sets `master`). Decoding starts at boot in the background (except `preload: false` tracks, decoded
   * on first play) and never blocks Play.
   */
  audio?: { tracks?: Record<string, TrackDef>; volumes?: Partial<Volumes> };
}

export interface Game {
  /** Camera clamp bounds [x0, z0, x1, z1] (metres). Valid after load(). */
  readonly bounds: [number, number, number, number];
  /** Build the level into the sim (the game's own exports) and load assets. */
  load(rt: GameRuntime, progress: (p: number, label?: string) => void): Promise<void>;
  /** A new round was laid out (sim already reset): reset presentation state. */
  reset(): void;
  /** READY → PLAYING in the sim (the countdown says GO); usually `sim_round_start()`. */
  startRound(): void;
  round(): RoundState;
  /**
   * Push this frame's player input into the sim. Called every frame; outside active play
   * (menus, countdown, pause, the round's ending) the snapshot is neutral: no movement, no
   * presses, no pointer held.
   */
  input(snap: InputSnapshot, dt: number): void;
  /** One sim event: record at ev[i … i + EVENT_FLOATS). */
  event(kind: number, ev: Float32Array, i: number): void;
  /**
   * First-person camera only: the eye for this frame (drawn, interpolated pose). Called after
   * `frame()`, every frame.
   */
  eye?(): EyePose;
  /**
   * Presentation update after the sim advanced and events ran. `dt` is the
   * presentation delta (0 while paused). Returns the camera's ground focus.
   */
  frame(dt: number, snap: InputSnapshot, phase: Phase): [number, number];
  /** Queue draws for this frame (instance batches, blob shadows, GLB models). */
  draw(dt: number): void;
  /** Title/menu showcase framing (t = seconds on the menu). */
  menuShot(t: number): Shot;
  /** Close-up for the countdown start and the results. */
  heroShot(): Shot;
  /** Results card content for the round that just ended. */
  summary(): RoundSummary;
  /** Countdown beat: n = 3, 2, 1, then 0 for GO. A start that skips the countdown (`skipCountdown`) gets no calls, so no countdown sound. */
  countdown(n: number): void;
  /**
   * Optional: an intro of the game's own (a cinematic level intro) in place of the countdown's swoop and 3-2-1. Called once when the countdown phase
   * begins, after the round is laid out (the sim is READY and stays so). Return true to take over: the flow then holds the phase while
   * `introActive()` is true (no numbers, no swoop; the game drives the camera through `eye()` and owns the screen and the skip), and on
   * the frame it turns false runs the GO beat at once (`countdown(0)`, `startRound()`, control to the player). Return false to get the ordinary
   * countdown. Games without an intro leave both out.
   */
  beginIntro?(): boolean;
  introActive?(): boolean;
  /**
   * Optional: skip the countdown for this start. Asked each time play starts (Play, Play again, Restart round, `?autostart`), after the round
   * is laid out (`reset()`) and before `beginIntro`, so a game with several scenes can answer per scene. Return true and the flow goes
   * straight to "playing": no 3-2-1, no "GO!", no swoop, no intro and no `countdown()` call; the round starts at once (`startRound()`, control to
   * the player). Inspection, tech-art and viewer scenes return true; a timed round keeps the countdown. Leave it out for the countdown.
   */
  skipCountdown?(): boolean;
  /** HUD visibility (true while a round is on screen). */
  showHud(on: boolean): void;
  /** Named sim numbers for `__game.stats()` (tests, captures) and the DEV panels. */
  stats(): Record<string, number>;
  /** DEV-only debug panel buttons. */
  debugActions?(): DebugAction[];
  /** Short text for the DEV debug panel's info line. */
  debugInfo?(): string;
}
