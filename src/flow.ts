// Round flow and screens: title → menu → countdown → playing ⇄ paused →
// ending → results → replay/menu (a game may skip the countdown per start,
// Game.skipCountdown: menu → playing at once). Game-agnostic: rules, shots and
// results content come from the Game; screens from index.html.
//
// Ownership (see docs/starter.md): the sim owns the round clock and outcome;
// this module owns which screen is up, when input reaches the game, and the
// pause state; the Frontend owns popups and focus; the Game owns presentation.
import type { Shot } from "./camera";
import { lerpAngle } from "./camera";
import type { Frontend } from "./ui/frontend";
import { motion, tween } from "./ui/tween";
import type { GameRuntime } from "./runtime";
import type { Game, Phase } from "./game";
import type { InputSnapshot } from "./input";
import { platform } from "./platform";
import { clamp, damp, lerp } from "./math";
import { FocusPolicy, type PauseOnBlur } from "./focus";
import { MENU_ENTRY_ID, extraPopupId } from "./ui/menu-extra";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Seconds per countdown number, and the pause before results. */
const BEAT = 0.75;
const ENDING = 1.5;

export interface FlowHooks {
  /** The player toggled mute (M or the HUD button): flip, apply and save. */
  toggleMute(): void;
  /** Settings popup opened (repaint its controls). */
  settingsOpened?(): void;
}

export interface FlowOptions {
  /** What losing window focus does to a round (src/focus.ts). Default: the runtime's (`GameModule.pauseOnBlur`, or a `setPauseOnBlur` from `load()`). */
  pauseOnBlur?: PauseOnBlur;
  /** GameModule.playTransition: "wipe" covers Play's menu → round swap with the screen wipe. Default "fade". */
  playTransition?: "fade" | "wipe";
}

export class Flow {
  /** GameModule.playTransition "wipe". */
  private playWipe = false;
  private menuT = 0;
  private countT = 0;
  private lastCount = -1;
  private endT = 0;
  private shotWant: Shot | null = null;
  private shotCur: Shot = { target: [0, 0.8, 0], pitch: 0.3, yaw: 0, distance: 5 };
  private pausePop = $("#pause-pop");
  private resultsPop = $("#results-pop");
  private settingsPop = $("#settings-pop");
  private helpPop = $("#help-pop");
  private countdownEl = $("#countdown");
  /** Popups opened from the pause card return to it. */
  private fromPause = false;
  /** The flow itself is closing the pause card (Settings/Help, Restart, Quit): that is not a resume. */
  private leavingPause = false;
  /** Menu → countdown (or straight to play) in progress (blocks double activation while the menu animates out). */
  private leaving = false;
  /** One of the game's own popups (GameModule.menu.extra) was opened over the results card: closing it returns to the card. */
  private fromResults = false;
  /** The game took over the countdown phase with an intro of its own (Game.beginIntro): the numbers and the swoop wait for it. */
  private introHeld = false;
  /** toMenu's wipe is running: a second leave would reset the round twice. */
  private toMenuBusy = false;

  /** What blur, hidden tabs and a lost mouse capture do (GameModule.pauseOnBlur). */
  readonly focus: FocusPolicy;

  constructor(private rt: GameRuntime, private game: Game, private ui: Frontend, private hooks: FlowHooks, opts: FlowOptions = {}) {
    this.playWipe = opts.playTransition === "wipe";
    rt.onFrame = (dt, snap) => this.frame(dt, snap);
    rt.openPopup = (id, opener) => this.openExtra(id, opener);
    rt.returnToMenu = () => this.returnToMenu();
    // The title opens on the menu's framing: it shows through a translucent ready screen, and a cut start carries it into the menu.
    this.snapShot(game.menuShot(0));
    ui.onAction = (act) => this.action(act);
    ui.onPopupClosed = (el) => this.popupClosed(el);
    $("#btn-pause").addEventListener("click", () => this.pause());
    $("#btn-mute").addEventListener("click", () => hooks.toggleMute());
    const press = (sel: string, fn: () => void) => $(sel).addEventListener("click", fn);
    press("#pause-resume", () => this.ui.closePopup());
    press("#pause-restart", () => this.restart());
    press("#pause-settings", () => this.openFromPause(this.settingsPop));
    press("#pause-help", () => this.openFromPause(this.helpPop));
    press("#pause-quit", () => void this.toMenu());
    // The game's own entries on the pause card (GameModule.menu.extra with `pause`): open like Settings does, and come back here.
    this.pausePop.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-extra]");
      const pop = b && this.extraPop(b.dataset.extra ?? "");
      if (b && pop && this.phase === "paused" && this.ui.currentPopup === this.pausePop) this.openFromPause(pop, b);
    });
    press("#results-again", () => this.replay());
    press("#results-menu", () => void this.toMenu());
    // P resumes too (Escape and gamepad B close the pause card through the Frontend).
    addEventListener("keydown", (e) => {
      if (e.defaultPrevented || e.repeat) return;
      if (e.code === "KeyP" && this.phase === "paused" && this.ui.currentPopup === this.pausePop) {
        e.preventDefault();
        this.ui.closePopup();
      }
    });
    // Losing focus mid-round pauses instead of letting the clock run (by default; a game may keep it running with
    // its input withheld, or ignore focus: GameModule.pauseOnBlur, rt.setPauseOnBlur). Losing the mouse capture mid-round (Esc, alt-tab)
    // pauses too: the pointer-lock release eats that Esc keypress.
    this.focus = new FocusPolicy(opts.pauseOnBlur ?? rt.pauseOnBlur, {
      pause: () => this.pause(),
      suspendInput: (on) => {
        rt.inputSuspended = on;
        if (on) rt.input.clear();
      },
    });
    rt.attachFocusPolicy(this.focus); // game code changes the mode through rt.setPauseOnBlur
    rt.input.onUnlock = () => this.focus.unlocked();
  }

  get phase(): Phase {
    return this.rt.phase;
  }

  private set phase(p: Phase) {
    document.body.dataset.phase = p; // (first: GameRuntime.onPhase listeners see the page as it now is)
    this.rt.phase = p;
  }

  // ---------------------------------------------------------------- transitions

  /**
   * The menu over the live scene. `carry` (the first press with GameModule.startTransition "cut"): the title's camera and
   * menu clock keep going and the menu is there at once, since no wipe hides a jump. Otherwise the menu shot starts
   * again from t = 0 and the menu fades in.
   */
  enterMenu(carry = false) {
    this.phase = "menu";
    this.game.showHud(false);
    this.rt.input.gameplay = false;
    if (!carry) {
      this.menuT = 0;
      this.snapShot(this.game.menuShot(0));
    }
    this.ui.showMenu(!carry);
  }

  /** Leave for the menu: the round is reset under the wipe, or at once with `wipe` false (GameRuntime.returnToMenu). */
  async toMenu(wipe = true) {
    if (this.toMenuBusy) return;
    if (this.ui.popupOpen) this.closeQuietly();
    const leaving = this.phase;
    this.rt.paused = false;
    this.rt.input.gameplay = false;
    this.rt.input.clear();
    this.countdownEl.hidden = true;
    if (leaving === "playing" || leaving === "paused" || leaving === "countdown") platform.gameplayStop();
    if (!wipe) {
      this.rt.resetRound();
      this.enterMenu();
      return;
    }
    this.toMenuBusy = true;
    try {
      await this.ui.transition(innerWidth / 2, innerHeight / 2, () => {
        this.rt.resetRound();
        this.enterMenu();
      });
    } finally {
      this.toMenuBusy = false;
    }
  }

  /** GameRuntime.returnToMenu: to the menu at once from anywhere past the menu; false where there is nothing to leave. */
  private returnToMenu(): boolean {
    if (this.phase === "boot" || this.phase === "title" || this.phase === "menu" || this.toMenuBusy) return false;
    void this.toMenu(false);
    return true;
  }

  /** Menu → countdown. The phase changes only once the menu is gone, so nothing runs on stale state. */
  async play() {
    if (this.phase !== "menu" || this.leaving) return;
    this.leaving = true;
    this.rt.input.clear(true);
    // The Play click is the one moment the browser lets the page capture the mouse: take it now and keep it through the menu's exit, the intro and the
    // countdown, so the first mouse move at GO already looks around. (Asking at GO is too late: the click has gone stale by then.)
    this.rt.input.requestLook();
    if (this.playWipe) {
      // Under the wipe: the menu goes at once and the round starts, so the wipe opens on the run.
      try {
        await this.ui.transition(innerWidth / 2, innerHeight / 2, () => {
          this.ui.menuOpen = false;
          $("#menu").hidden = true;
          if (this.phase === "menu") this.startCountdown();
        });
      } finally {
        this.leaving = false;
      }
      return;
    }
    await this.ui.hideMenu();
    this.leaving = false;
    if (this.phase === "menu") this.startCountdown();
  }

  /**
   * Straight into a round (`?autostart`): no menu, and nothing awaits a
   * real-time UI animation, so `?capture&autostart` stays frame-deterministic.
   */
  autostart() {
    this.ui.menuOpen = false;
    $("#menu").hidden = true;
    this.startCountdown();
  }

  /**
   * A new round: the countdown (or the game's intro), or straight into play when the game skips the
   * countdown for this start (Game.skipCountdown: inspection and viewer scenes with no timed round).
   */
  private startCountdown() {
    this.rt.resetRound();
    const skip = this.game.skipCountdown?.() ?? false;
    this.phase = skip ? "playing" : "countdown"; // (before heroShot: a game may frame it by phase)
    this.countT = 0;
    this.lastCount = -1;
    this.introHeld = false;
    this.game.showHud(true);
    this.rt.canvas.focus({ preventScroll: true });
    this.snapShot(this.game.heroShot());
    this.rt.camera.shotBlend = 1;
    if (skip) {
      // No numbers, no "GO!", no swoop, no intro and no countdown() call (so no GO sound): the round starts now, from the gameplay view.
      this.countdownEl.hidden = true;
      this.countT = BEAT * 3 + 1; // (past the point where "playing" hides a leftover "GO!")
      this.go(true);
      return;
    }
    // A game with an intro of its own (a cinematic level intro) plays it here, in place of the swoop and the numbers.
    this.introHeld = this.game.beginIntro?.() ?? false;
    if (this.introHeld) this.holdForIntro();
  }

  /** The GO beat: the sim's round starts and control passes to the player. A skipped countdown has no beat to sound. */
  private go(skipped = false) {
    const cam = this.rt.camera;
    if (!skipped) this.game.countdown(0);
    this.game.startRound();
    if (this.phase !== "playing") this.phase = "playing";
    cam.shot = null;
    cam.shotBlend = 0;
    this.rt.input.gameplay = true;
    this.rt.input.requestLook(); // best effort for autostart; ordinary Play already captured inside its click
    platform.gameplayStart();
  }

  /** The game's intro drives the camera through its eye: no orbit shot blended over it. */
  private holdForIntro() {
    this.rt.camera.shot = null;
    this.rt.camera.shotBlend = 0;
  }

  private replay() {
    if (this.phase !== "results") return;
    this.rt.input.requestLook(); // (the "again" click: capture for the next round, as Play does)
    this.closeQuietly();
    platform.gameplayStop();
    this.startCountdown();
  }

  private restart() {
    this.rt.input.requestLook(); // (the "restart" click)
    this.closeQuietly();
    this.rt.paused = false;
    platform.gameplayStop();
    this.startCountdown();
  }

  pause() {
    if (this.phase !== "playing") return;
    this.phase = "paused";
    this.rt.paused = true;
    this.rt.input.clear();
    this.rt.input.gameplay = false;
    platform.gameplayStop();
    this.fromPause = false;
    this.ui.openPopupEl(this.pausePop);
  }

  private resume() {
    if (this.phase !== "paused") return;
    this.phase = "playing";
    this.rt.paused = false;
    this.rt.input.clear();
    this.rt.input.gameplay = true;
    this.rt.input.requestLook(); // works when the Resume click is a fresh activation; otherwise the next click on the canvas captures
    platform.gameplayStart();
    this.rt.canvas.focus({ preventScroll: true });
  }

  /** Close the open popup without the player's meaning (a closed pause card would resume). */
  private closeQuietly() {
    this.leavingPause = true;
    try {
      this.ui.closePopup(true);
    } finally {
      this.leavingPause = false;
    }
  }

  private openFromPause(el: HTMLElement, opener: HTMLElement = $(el === this.settingsPop ? "#pause-settings" : "#pause-help")) {
    this.fromPause = true;
    this.closeQuietly();
    if (el === this.settingsPop) this.hooks.settingsOpened?.();
    this.ui.openPopupEl(el, opener);
  }

  /**
   * GameRuntime.openPopup: one of the game's own popups, from wherever the game is. In play it pauses first and opens over the
   * pause card; over the pause card or the results card it returns to that card when closed; on the menu it opens like a menu entry.
   */
  private openExtra(id: string, opener?: HTMLElement | null): boolean {
    const pop = this.extraPop(id);
    if (!pop) return false;
    if (this.ui.currentPopup === pop) return true;
    const from = opener ?? (document.activeElement as HTMLElement | null);
    if (this.phase === "playing") this.pause();
    if (this.phase === "paused" && this.ui.currentPopup === this.pausePop) this.openFromPause(pop, from ?? $("#pause-resume"));
    else if (this.phase === "results" && this.ui.currentPopup === this.resultsPop) {
      this.fromResults = true;
      this.closeQuietly();
      this.ui.openPopupEl(pop, from);
    } else if (!this.ui.popupOpen && this.phase === "menu") this.ui.openPopupEl(pop, from);
    else return false; // another popup is up, or the round is between screens (countdown, ending)
    return true;
  }

  /** The popup of one of the game's own menu entries (GameModule.menu.extra), or null. */
  private extraPop(id: string): HTMLElement | null {
    return MENU_ENTRY_ID.test(id) ? document.getElementById(extraPopupId(id)) : null;
  }

  private popupClosed(el: HTMLElement) {
    const extra = el.classList.contains("extra-pop");
    if (extra && this.fromResults) {
      // Back to the results card it was opened from (not a dismissal of the results).
      this.fromResults = false;
      if (this.phase === "results") this.ui.openPopupEl(this.resultsPop, null);
      return;
    }
    if (el === this.resultsPop) {
      // The player closed the end card with Escape, Backspace or gamepad B instead of pressing a button: the round would be left on "results" with nothing on screen and nothing
      // to press. It leaves the way the card's last button does (the Menu button, which a game may name "Next job"). Replay and Menu close it quietly, so they do not come here.
      if (!this.leavingPause && this.phase === "results") void this.toMenu();
      return;
    }
    if (el === this.pausePop) {
      // The player closed the card (Resume, Escape, P, gamepad B): resume. The flow closing it
      // to open Settings/Help (fromPause stays set for their return), restart or quit: don't.
      if (!this.leavingPause && this.phase === "paused") this.resume();
      return;
    }
    if ((el === this.settingsPop || el === this.helpPop || extra) && this.fromPause && this.phase === "paused") {
      // Back to the pause card: closing Settings inside Pause must not resume the round.
      this.fromPause = false;
      this.ui.openPopupEl(this.pausePop, $("#pause-resume"));
      return;
    }
    this.fromPause = false;
  }

  private action(act: string) {
    if (act === "play") void this.play();
    else if (act === "settings") {
      this.hooks.settingsOpened?.();
      this.ui.openPopupEl(this.settingsPop);
    } else if (act === "help") {
      if (document.body.dataset.help !== "off") this.ui.openPopupEl(this.helpPop); // GameModule.help === false takes it out
    } else if (act.startsWith("extra:")) {
      const pop = this.extraPop(act.slice(6));
      if (pop) this.ui.openPopupEl(pop);
    } else if (act === "preview") location.href = "preview.html";
  }

  private showResults() {
    this.phase = "results";
    this.game.showHud(false); // the card carries the numbers; keep the player's close-up clear
    const s = this.game.summary();
    $("#results-ribbon").textContent = s.ribbon;
    $("#results-title").textContent = s.title;
    this.resultsPop.classList.toggle("won", s.won);
    this.resultsPop.classList.toggle("lost", !s.won);
    const rows = $("#results-rows");
    rows.replaceChildren(
      ...s.rows.map(([k, v]) => {
        const row = document.createElement("div");
        row.append(Object.assign(document.createElement("span"), { textContent: k }), Object.assign(document.createElement("b"), { textContent: v }));
        return row;
      }),
    );
    const note = $("#results-note");
    note.textContent = s.note;
    note.hidden = !s.note;
    const extra = $("#results-extra");
    extra.replaceChildren(...(s.extra ? [s.extra] : []));
    extra.hidden = !s.extra;
    const custom = $("#results-custom");
    custom.replaceChildren(...(s.custom ? [s.custom] : []));
    custom.hidden = !s.custom;
    this.resultsPop.classList.toggle("custom", !!s.custom);
    // The buttons: the game may rename them or drop "Play again" (a win that leads on to something else has one button).
    const again = $("#results-again");
    const menu = $("#results-menu");
    again.hidden = s.buttons?.again === false;
    again.textContent = typeof s.buttons?.again === "string" ? s.buttons.again : "Play again";
    menu.textContent = s.buttons?.menu ?? "Menu";
    menu.classList.toggle("primary", again.hidden);
    again.toggleAttribute("data-autofocus", !again.hidden);
    menu.toggleAttribute("data-autofocus", again.hidden);
    this.ui.openPopupEl(this.resultsPop, null);
  }

  // ---------------------------------------------------------------- per frame

  private frame(dt: number, snap: InputSnapshot) {
    const { rt, game } = this;
    if (snap.pressed.has("mute")) this.hooks.toggleMute();
    switch (this.phase) {
      case "title":
      case "menu":
        this.menuT += dt;
        this.shotWant = game.menuShot(this.menuT);
        rt.camera.shot = this.shotCur;
        rt.camera.shotBlend = 1;
        break;
      case "countdown":
        this.countdown(dt);
        break;
      case "playing": {
        // "GO!" leaves on the frame clock (not the animation's real-time end) so ?capture runs match.
        this.countT += dt;
        if (this.countT > BEAT * 3 + 0.8) this.countdownEl.hidden = true;
        if (snap.pressed.has("pause")) {
          this.pause();
          break;
        }
        const r = game.round();
        if (r === "won" || r === "lost") {
          this.phase = "ending";
          this.endT = ENDING;
          rt.input.gameplay = false;
          rt.input.clear();
          platform.gameplayStop();
          if (r === "won") platform.celebrate();
          this.shotWant = game.heroShot();
          this.shotCur = { ...this.shotCur, ...this.currentGameplayShot() };
          rt.camera.shot = this.shotCur;
          rt.camera.shotBlend = 0;
        }
        break;
      }
      case "ending":
        this.endT -= dt;
        this.shotWant = game.heroShot();
        rt.camera.shotBlend = Math.min(1, rt.camera.shotBlend + dt * 1.2);
        if (this.endT <= 0) this.showResults();
        break;
      case "results":
        this.shotWant = game.heroShot();
        break;
      default:
        break;
    }
    this.updateShot(dt);
  }

  private countdown(dt: number) {
    const cam = this.rt.camera;
    if (this.introHeld) {
      if (this.game.introActive?.()) {
        this.holdForIntro();
        return;
      }
      // The intro is over: straight to GO (no numbers after a cinematic), from the first-person eye it ended on.
      this.introHeld = false;
      this.countT = BEAT * 3;
    }
    this.countT += dt;
    // Hold the hero angle a beat, then swoop into the gameplay view.
    const hold = 0.3, swoop = BEAT * 3 - 0.2;
    cam.shotBlend = motion.reduced ? (this.countT < BEAT * 3 ? 1 : 0) : 1 - easeInOutCubic(clamp((this.countT - hold) / swoop, 0, 1));
    const n = Math.max(0, 3 - Math.floor(this.countT / BEAT));
    if (n === this.lastCount) return;
    this.lastCount = n;
    const el = this.countdownEl;
    el.hidden = false;
    el.textContent = n > 0 ? `${n}` : "GO!";
    tween(el, [
      { transform: "scale(0.5)", opacity: 0 },
      { transform: "scale(1.12)", opacity: 1, offset: 0.2 },
      { transform: "scale(1)", opacity: 1, offset: 0.75 },
      { transform: "scale(1.2)", opacity: 0 },
    ], { duration: n > 0 ? BEAT * 1000 : 800, easing: "ease-out" });
    if (n === 0) this.go();
    else this.game.countdown(n);
  }

  /** The current gameplay framing as a Shot (so the ending can blend from it). */
  private currentGameplayShot(): Shot {
    return this.rt.camera.gameplayShot();
  }

  private snapShot(s: Shot) {
    this.shotCur = { target: [...s.target], pitch: s.pitch, yaw: s.yaw, distance: s.distance };
    this.shotWant = s;
    this.rt.camera.shot = this.shotCur;
  }

  /** Glide the live shot toward the wanted one (reduced motion: jump). */
  private updateShot(dt: number) {
    const w = this.shotWant;
    if (!w) return;
    const c = this.shotCur;
    const k = motion.reduced ? 1 : 1 - Math.exp(-dt * 3.5);
    for (let i = 0; i < 3; i++) c.target[i] = lerp(c.target[i], w.target[i], k);
    c.pitch = damp(c.pitch, w.pitch, 3.5, motion.reduced ? 1e3 : dt);
    c.yaw = lerpAngle(c.yaw, w.yaw, k);
    c.distance = lerp(c.distance, w.distance, k);
  }
}

