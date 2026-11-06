// Engine runtime: boot (WebGPU/WebGL 2 → WASM + ABI check → game.load), the frame
// loop (input → sim → events → presentation → render), capture mode and the
// `window.__game` test hooks. Game rules and look come from a `Game`
// (src/game.ts); screens and round flow from src/flow.ts.
//
// Clocks: the Rust sim owns gameplay time (fixed 1/120 s steps, paused with
// sim_set_paused). The runtime owns the presentation clock (animation,
// particles, pops), which stops while paused. `?capture` replaces
// requestAnimationFrame with `__game.step(n)`: n frames of exactly 1/60 s,
// resolved after the GPU finished them, for repeatable captures.
import { Sim, AbiMismatch, EVENT_FLOATS, type SimLayout } from "./wasm";
import { Renderer, DEFAULT_STYLE, type Style } from "./gpu/renderer";
import { InstanceBatch } from "./gpu/meshes";
import { Camera, type CameraMode, type CameraRig } from "./camera";
import { Input, neutralInput, type ActionMap, type InputSnapshot } from "./input";
import type { LookOptions } from "./look";
import { TouchButtons, type TouchButtonDef } from "./ui/touch-buttons";
import { AudioBus } from "./audio";
import { Particles } from "./fx";
import { Pops } from "./ui/pops";
import { platform } from "./platform";
import type { Game, Phase } from "./game";
import { applyBudget, captureBudget, type PixelBudget } from "./capture";
import { checkPauseOnBlur, type FocusPolicy, type PauseOnBlur } from "./focus";

/** Show the error card (graphics unavailable, WASM failed, device lost…). Hands the screen back from a host loader. */
export function fatal(title: string, detail: string) {
  platform.failed();
  const el = document.querySelector("#fatal") as HTMLElement;
  el.hidden = false;
  el.querySelector("h2")!.textContent = title;
  el.querySelector("p")!.textContent = detail;
  for (const s of document.querySelectorAll<HTMLElement>(".screen, .popup, #hud")) s.hidden = true;
  console.error(`[fatal] ${title}: ${detail}`);
}

/** Test-only input source: replaces the player's movement while set (screen-space stick). */
export type Autopilot = (dt: number, rt: GameRuntime) => { moveX: number; moveY: number } | null;

export interface BootOptions {
  seed: number;
  /** The game's ABI mirror, checked against sim.wasm before anything runs. */
  abi: SimLayout;
  actions?: ActionMap;
  rig?: Partial<CameraRig>;
  /** GameModule.camera: "first-person" makes the game's `eye()` drive the view and turns look input on. */
  camera?: CameraMode;
  /** GameModule.look (see src/look.ts); on by default for a first-person camera. */
  look?: boolean | Partial<LookOptions>;
  /** GameModule.buttons: on-screen action buttons for touch. */
  buttons?: TouchButtonDef[];
  audio?: AudioBus;
  /** GameModule.pauseOnBlur: what losing focus does when the round starts (`setPauseOnBlur` changes it later). Default "pause". */
  pauseOnBlur?: PauseOnBlur;
  /** This page is the dev server's Mobile view (src/dev/mobile-view.ts): the mouse stands in for a finger from before `load()`. */
  mobileView?: boolean;
  onProgress?: (p: number, label?: string) => void;
}

const MESH_BATCH_SIZES = [1024, 512, 128, 256, 128];
const MAX_BLOBS = 256;

export class GameRuntime {
  /** Simulation frozen (pause popup). Presentation stops too; rendering continues. */
  private _paused = false;
  private phase_: Phase = "boot";
  private phaseListeners = new Set<(phase: Phase, previous: Phase) => void>();
  readonly capture = new URLSearchParams(location.search).has("capture");
  /**
   * This page is the dev server's Mobile view, a phone-sized window beside the main one (always false in a release build). An
   * online game gives it a guest identity of its own (kept under its own storage key), so it joins as a second player instead of
   * taking over the main window's.
   */
  mobileView = false;
  style: Style = { ...DEFAULT_STYLE };
  /** Camera shake scale (a presentation setting; reduced motion sets 0). */
  shake = 1;
  readonly batches = MESH_BATCH_SIZES.map((n) => new InstanceBatch(n));
  readonly blobs = new Float32Array(MAX_BLOBS * 4);
  blobCount = 0;
  readonly particles: Particles;
  readonly pops: Pops;
  /** Test-only movement override (see Autopilot). */
  autopilot: Autopilot | null = null;
  /**
   * The player's input is withheld: every frame gets the neutral snapshot while the round keeps running
   * (the flow sets it for `GameModule.pauseOnBlur: "input"` while the window is unfocused; src/focus.ts).
   */
  inputSuspended = false;
  /** The focus mode until the flow's policy takes over (boot and game.load), then the policy's. */
  private blurMode: PauseOnBlur = "pause";
  private focusPolicy: FocusPolicy | null = null;
  /**
   * Open one of the game's own popups (GameModule.menu.extra) by id from game code: a button on the results card, a HUD link. In play
   * it pauses first; closing it returns to the pause or results card it opened over. `opener` gets focus back when it closes.
   * Returns false for an unknown id, when another popup (Settings, say) is up, or between screens (countdown, ending). Installed by the flow.
   */
  openPopup: (id: string, opener?: HTMLElement | null) => boolean = () => false;
  /**
   * Leave for the menu at once, with no wipe: back out of a screen the game shows in play (a class picker, a lobby) as Quit to menu
   * does, round reset included. Returns false where there is nothing to leave (loading, the title, the menu). Installed by the flow.
   */
  returnToMenu: () => boolean = () => false;
  /** The game's on-screen touch buttons, if it declared any (a game may relabel them). */
  touchButtons: TouchButtons | null = null;
  /** Called every frame before the game input step (the flow's state machine). */
  onFrame: ((dt: number, snap: InputSnapshot) => void) | null = null;
  private frameCaptures: { resolve: (copy: HTMLCanvasElement) => void; reject: (error: unknown) => void }[] = [];
  /** Called for every sim event after the game handled it. */
  onEvent: ((kind: number, ev: Float32Array, i: number) => void) | null = null;
  /** Presentation clock (s): advances with dt, frozen while paused. */
  clock = 0;
  /** Fixed sim steps taken since boot (sim_advance's returns): frozen while paused. */
  simSteps = 0;
  /** Rounds laid out since boot (`resetRound` calls): tests tell a restart from a resume by it (`__game.rounds()`). */
  rounds = 0;
  fps = 0;
  private virtualNow = 0;
  private last = performance.now();
  private fpsAcc = 0;
  private fpsN = 0;
  private stopped = false;
  private coverAge = Infinity;

  private constructor(
    readonly canvas: HTMLCanvasElement,
    readonly renderer: Renderer,
    readonly sim: Sim,
    readonly game: Game,
    readonly input: Input,
    readonly camera: Camera,
    readonly audio: AudioBus,
    readonly seed: number,
  ) {
    this.particles = new Particles(2048, seed);
    this.pops = new Pops(document.querySelector("#pops") as HTMLElement);
  }

  /** Boot order: renderer → wasm (+ ABI check) → sim_init → game.load. Returns null after showing a fatal card. */
  static async boot(canvas: HTMLCanvasElement, game: Game, opts: BootOptions): Promise<GameRuntime | null> {
    const blurMode = checkPauseOnBlur(opts.pauseOnBlur); // (a bad GameModule value fails before any GPU work)
    const report = opts.onProgress ?? (() => {});
    const progress = (p: number, label?: string) => {
      platform.loading(p);
      report(p, label);
    };
    progress(0.05, "Starting the GPU…");
    let renderer: Renderer;
    try {
      renderer = await Renderer.create(canvas);
    } catch (e) {
      fatal("Graphics could not start", `${e instanceof Error ? e.message : String(e)} Enable hardware acceleration or try another browser, then reload.`);
      return null;
    }
    canvas = renderer.canvas;
    renderer.onLost = (why) => fatal("The graphics device was lost", `${why}. Reload the page to continue.`);
    progress(0.15, "Loading the simulation…");
    let sim: Sim;
    try {
      sim = await Sim.load(new URL("wasm/sim.wasm", document.baseURI).href, opts.abi);
      sim.verifyAbi();
    } catch (e) {
      if (e instanceof AbiMismatch) fatal("Simulation and page are out of sync", `${e.message} Rebuild with npm run wasm (or npm run build) and reload.`);
      else fatal("The simulation failed to load", String(e));
      renderer.dispose();
      return null;
    }
    sim.x.sim_init(opts.seed);
    const camera = new Camera(opts.rig, opts.camera ?? "follow");
    const input = new Input(canvas, opts.actions, opts.look ?? opts.camera === "first-person");
    const rt = new GameRuntime(canvas, renderer, sim, game, input, camera, opts.audio ?? new AudioBus(), opts.seed);
    rt.blurMode = blurMode;
    if (opts.mobileView) rt.mobileView = input.emulateTouch = true;
    if (opts.buttons?.length) rt.touchButtons = new TouchButtons(input, opts.buttons);
    renderer.onLost = (why) => {
      rt.stop();
      rt.paused = true;
      input.clear();
      fatal("The graphics device was lost", `${why}. Reload the page to continue.`);
    };
    progress(0.25, "Building the level…");
    try {
      await game.load(rt, (p, label) => progress(0.25 + p * 0.7, label));
    } catch (e) {
      fatal("The level failed to load", e instanceof Error ? e.message : String(e));
      renderer.dispose();
      return null;
    }
    if (rt.stopped) return null;
    progress(1, "Ready");
    if (rt.capture) {
      document.body.classList.add("capture");
      applyBudget(renderer, captureBudget(new URLSearchParams(location.search))); // ?capture&maxpx=…&maxdpr=…: lift the phone-sized caps
    }
    rt.installHooks();
    return rt;
  }

  /** The flow's current phase (set by src/flow.ts, and to "title" by src/main.ts). A change tells the `onPhase` listeners. */
  get phase(): Phase {
    return this.phase_;
  }

  set phase(p: Phase) {
    if (p === this.phase_) return;
    const previous = this.phase_;
    this.phase_ = p;
    for (const fn of [...this.phaseListeners]) {
      try {
        fn(p, previous);
      } catch (e) {
        console.error("[runtime] an onPhase listener failed", e); // (the flow's change still stands)
      }
    }
  }

  /**
   * Hear every phase change (title → menu → countdown → playing …) as `fn(phase, previous)`, after the flow has switched and set
   * `body[data-phase]`: for analytics, music or a game's own screens, instead of watching the DOM. Returns a function that stops it.
   */
  onPhase(fn: (phase: Phase, previous: Phase) => void): () => void {
    this.phaseListeners.add(fn);
    return () => this.phaseListeners.delete(fn);
  }

  get paused() {
    return this._paused;
  }

  set paused(on: boolean) {
    this._paused = on;
    this.sim.x.sim_set_paused(on ? 1 : 0);
    this.particles.paused = on; // nothing ages while paused, so new particles would only pile up
  }

  /** What losing window focus does to the round now (src/focus.ts): GameModule.pauseOnBlur, or the last `setPauseOnBlur`. */
  get pauseOnBlur(): PauseOnBlur {
    return this.focusPolicy?.mode ?? this.blurMode;
  }

  /**
   * Change what losing focus does, from game code, for one scene or mode: "none" in an asset viewer, "input" in an online round, back to
   * "pause" for a timed round. Callable any time, `load()` included; it applies from the next focus change, and leaving "input" hands
   * withheld input back at once. Esc out of a captured mouse still pauses in every mode. Throws on an unknown mode.
   */
  setPauseOnBlur(mode: PauseOnBlur) {
    const m = checkPauseOnBlur(mode, "setPauseOnBlur");
    if (this.focusPolicy) this.focusPolicy.setMode(m);
    else this.blurMode = m;
  }

  /** The flow hands over its focus policy (which starts in `pauseOnBlur`); `setPauseOnBlur` then changes it. */
  attachFocusPolicy(policy: FocusPolicy) {
    this.focusPolicy = policy;
  }

  /** Back to the authored round (sim + presentation). Held input is dropped; a mouse capture is kept (see `Input.clear`). */
  resetRound() {
    this.rounds++;
    this.sim.x.sim_reset();
    this.sim.x.sim_clear_frame();
    this.input.clear(true);
    this.particles.clear();
    this.pops.clear();
    this.game.reset();
  }

  /**
   * A copy of the next frame the renderer draws (a share image, a thumbnail): a 2D canvas the size of the drawing buffer,
   * without the HTML HUD, popups or screens. The copy is taken straight after rendering, while the drawing buffer still
   * holds the frame (on both backends it is gone once the page has been shown). Under `?capture` it resolves on the next
   * `__game.step`. Rejects when the loop has stopped (device loss, a fatal error) or the copy fails.
   */
  captureFrame(): Promise<HTMLCanvasElement> {
    if (this.stopped) return Promise.reject(new Error("captureFrame: the frame loop has stopped"));
    return new Promise((resolve, reject) => this.frameCaptures.push({ resolve, reject }));
  }

  /** Answer the captures waiting for this frame (just rendered). */
  private copyFrame() {
    const waiting = this.frameCaptures.splice(0);
    try {
      const copy = document.createElement("canvas");
      copy.width = this.canvas.width;
      copy.height = this.canvas.height;
      const ctx = copy.getContext("2d");
      if (!ctx) throw new Error("captureFrame: no 2D canvas for the copy");
      ctx.drawImage(this.canvas, 0, 0);
      for (const w of waiting) w.resolve(copy);
    } catch (e) {
      for (const w of waiting) w.reject(e);
    }
  }

  /** The loop stopped: captures waiting for a frame will not get one. */
  private stop() {
    this.stopped = true;
    for (const w of this.frameCaptures.splice(0)) w.reject(new Error("captureFrame: the frame loop has stopped"));
  }

  /** The game's named sim numbers (a copy; see Game.stats). */
  stats(): Record<string, number> {
    return this.game.stats();
  }

  /** World point → CSS pixels through the rendered camera (null behind it). */
  project(x: number, y: number, z: number) {
    return this.camera.project([x, y, z], this.canvas.clientWidth, this.canvas.clientHeight);
  }

  /**
   * `window.__game`: test and capture hooks. Games add their own entries in
   * load() (e.g. positions of things a test should steer toward).
   */
  readonly hooks: Record<string, unknown> = {};

  private installHooks() {
    const hooks = this.hooks;
    Object.assign(hooks, {
      stats: () => this.stats(),
      graphics: () => this.renderer.info(),
      project: (x: number, y: number, z: number) => this.project(x, y, z),
      reset: () => this.resetRound(),
      phase: () => this.phase,
      fps: () => this.fps,
      simSteps: () => this.simSteps,
      rounds: () => this.rounds,
      pauseOnBlur: () => this.pauseOnBlur,
      clock: () => this.clock,
      seed: this.seed,
      sim: this.sim,
      runtime: this,
    });
    Object.defineProperty(hooks, "autopilot", {
      get: () => this.autopilot,
      set: (fn: Autopilot | null) => (this.autopilot = fn),
      enumerable: true,
    });
    if (this.capture) {
      // Deterministic stepping: exactly `frames` frames of 1/60 s, resolved when the GPU is done.
      hooks.step = async (frames = 1) => {
        for (let i = 0; i < frames; i++) {
          this.virtualNow += 1000 / 60;
          this.frame(this.virtualNow);
        }
        await this.renderer.finished();
        return this.virtualNow;
      };
      // The render resolution caps (src/capture.ts): read them, or raise them for a high-resolution capture; the next step renders at the new size.
      hooks.pixelBudget = (change?: Partial<PixelBudget>) => ({ ...applyBudget(this.renderer, change), size: this.renderer.pixelSize });
    }
    (window as unknown as { __game: unknown }).__game = hooks;
  }

  start() {
    if (!this.capture) requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    if (this.stopped) return;
    requestAnimationFrame(this.tick);
    this.frame(now);
  };

  /**
   * Tell the camera how much of the view the HUD covers: elements marked
   * data-cover="top"/"bottom" that reach the middle half of the width.
   * Measured a few times a second (layout reads every frame cost more).
   */
  private measureCover() {
    this.coverAge = 0;
    const view = this.canvas.getBoundingClientRect();
    if (!view.height) return;
    let top = 0, bottom = 0;
    for (const el of document.querySelectorAll<HTMLElement>("[data-cover]")) {
      if (el.closest("[hidden]")) continue;
      const r = el.getBoundingClientRect();
      if (!r.height || r.right < view.left + view.width * 0.25 || r.left > view.right - view.width * 0.25) continue;
      if (el.dataset.cover === "top") top = Math.max(top, r.bottom - view.top);
      else bottom = Math.max(bottom, view.bottom - r.top);
    }
    this.camera.cover = [Math.min(1, top / view.height), Math.min(1, bottom / view.height)];
  }

  private frame(now: number) {
    if (this.stopped) return;
    try {
      this.frameInner(now);
    } catch (e) {
      // A wasm trap (unreachable) or a bug: stop cleanly with a visible card instead of throwing every frame.
      this.stop();
      fatal("Something went wrong", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }

  private frameInner(now: number) {
    const { sim, input, camera, game, renderer, canvas } = this;
    const realDt = this.capture ? 1 / 60 : Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.fpsAcc += realDt;
    this.fpsN++;
    if (this.fpsAcc >= 0.5) {
      this.fps = Math.round(this.fpsN / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsN = 0;
    }
    const dt = this._paused ? 0 : realDt;

    const polled = input.poll(realDt);
    const snap = this.inputSuspended ? neutralInput(polled) : polled;
    this.onFrame?.(realDt, snap);
    this.touchButtons?.update(this.phase === "playing" && !this._paused);

    if (this.phase === "playing" && !this._paused) {
      const bot = this.autopilot?.(realDt, this);
      if (bot) game.input({ ...snap, moveX: bot.moveX, moveY: bot.moveY, pointer: { ...snap.pointer, down: false } }, realDt);
      else game.input(snap, realDt);
    } else game.input(neutralInput(snap), realDt);
    if (!this._paused) this.simSteps += sim.x.sim_advance(realDt);

    // A copy: handlers may call into the sim, and memory growth would detach a live view.
    const ev = sim.f32("events").slice();
    for (let i = 0; i < ev.length; i += EVENT_FLOATS) {
      const kind = ev[i];
      game.event(kind, ev, i);
      this.onEvent?.(kind, ev, i);
    }

    this.clock += dt;
    const [fx, fz] = game.frame(dt, snap, this.phase);
    if ((this.coverAge += realDt) >= 0.25) this.measureCover();
    camera.shakeScale = this.shake;
    if (camera.mode === "first-person" && game.eye) camera.setEye(game.eye());
    camera.update(realDt, fx, fz, canvas.clientWidth / Math.max(1, canvas.clientHeight), game.bounds);

    for (const b of this.batches) b.reset();
    this.blobCount = 0;
    game.draw(dt);
    this.particles.update(dt);
    renderer.render(canvas, {
      camera,
      time: this.clock,
      dt,
      style: this.style,
      batches: this.batches,
      particles: this.particles.data,
      particleCount: this.particles.count,
      blobs: this.blobs,
      blobCount: this.blobCount,
    });
    if (this.frameCaptures.length) this.copyFrame();
    this.pops.update(dt, (p) => camera.project(p, canvas.clientWidth, canvas.clientHeight));
    sim.x.sim_clear_frame();
  }

  /** Add a blob contact shadow for this frame. */
  blob(x: number, z: number, radius: number, opacity: number) {
    if (this.blobCount >= MAX_BLOBS) return;
    this.blobs.set([x, z, radius, opacity], this.blobCount * 4);
    this.blobCount++;
  }
}
