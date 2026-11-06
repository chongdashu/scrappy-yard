// The gym's HUD: course progress with the finish flag, nut counter, mech distance, and the gym
// toggles (Bounds / Practice / Camera) — those show only with body.gym-tools (?gym / asset viewer).
// Lane radar cards are gone: track lamps + tick/beep pings carry the heads-up (owner, 2026-11-05).
// Presentation of sim stats only. Markup fills GameModule.hud; the look is in style.css.
import type { TouchStick } from "@engine/input";
import { TouchStickView } from "@engine/ui/stick";
import { icon } from "./icons";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** The top bar, before the engine's pause and mute buttons. */
export const HUD_TOP = `
  <div class="pill progress" aria-label="Course progress"><span class="bar"><i id="hud-progress"></i></span>${icon("flag", "flag")}</div>
  <div class="pill mech" aria-label="Mech distance">${icon("mech", "ico")}<b id="hud-mech">12 m</b></div>
  <div class="pill nuts" aria-label="Hex nuts"><span class="nut" aria-hidden="true"></span><b id="hud-nuts">0</b></div>`;

/** Below the bar: gym debug panel only (hidden unless body.gym-tools). */
export const HUD_OVERLAY = `
  <div id="gym-panel" class="gym-panel" data-cover="top">
    <b>Scrapyard run</b>
    <span id="gym-cam">Camera: mockup D</span>
    <span><button type="button" id="gym-bounds" class="gym-toggle">Bounds <i>off</i></button>
    <button type="button" id="gym-practice" class="gym-toggle">Practice <i>off</i></button>
    <button type="button" id="gym-camera" class="gym-toggle">Camera</button></span>
  </div>
`;

/** Help body (only used if GameModule.help is set; published build uses help: false). */
export const HELP = `
  <p class="help-lead">Scrapyard runner: you play the raccoon. Run toward the camera, stay ahead of the junk mech, reach the finish gate.</p>
  <ul class="help-list">
    <li>${icon("move", "ico")}<span><b>Move:</b> hold A/D or ←/→, the gamepad stick or d-pad, or drag the touch stick to slide freely across the track. Hazards sit in three lanes: whichever lane you are in (or both, on the line) is the one that counts.</span></li>
    <li>${icon("jump", "ico")}<span><b>Jump:</b> Space, W or ↑, gamepad A; on touch flick up or tap JUMP. Jump barrels and gaps; cars must be dodged.</span></li>
    <li>${icon("mech", "ico")}<span><b>Mech:</b> every barrel you hit slows you and lets it close in. Caught, fallen or crashed = run over.</span></li>
    <li>${icon("flag", "ico")}<span><b>Heads-up:</b> glowing lamps (orange barrels, red cars, pink gaps) and a tick/beep mark hazards in your lane — gold is hex nuts, not a lamp. The progress bar, mech gap and nut pills sit at the top.</span></li>
  </ul>`;

export class GymHud {
  private root = $("#hud");
  private progress = $("#hud-progress");
  private mech = $("#hud-mech");
  private nuts = $("#hud-nuts");
  private cam = $("#gym-cam");
  private stick = new TouchStickView();
  private last = { nuts: -1, mech: "", prog: "" };

  /** Buttons the game wires (they also work by key). Hidden unless body.gym-tools. */
  readonly buttons = { bounds: $("#gym-bounds"), practice: $("#gym-practice"), camera: $("#gym-camera") };

  show(on: boolean) {
    this.root.hidden = !on;
  }

  reset() {
    this.last = { nuts: -1, mech: "", prog: "" };
  }

  update(o: {
    progress: number; mechGap: number; nuts: number; touch: boolean; stick: TouchStick | null;
    camera: string; bounds: boolean; practice: boolean;
  }) {
    const prog = `${(Math.min(1, Math.max(0, o.progress)) * 100).toFixed(1)}%`;
    if (prog !== this.last.prog) this.progress.style.width = this.last.prog = prog;
    const mech = `${Math.max(0, o.mechGap).toFixed(1)} m`;
    if (mech !== this.last.mech) this.mech.textContent = this.last.mech = mech;
    this.mech.parentElement!.classList.toggle("danger", o.mechGap < 4);
    if (o.nuts !== this.last.nuts) {
      if (o.nuts > this.last.nuts && this.last.nuts >= 0) {
        this.nuts.classList.remove("bump");
        void this.nuts.offsetWidth;
        this.nuts.classList.add("bump");
      }
      this.nuts.textContent = String(o.nuts);
      this.last.nuts = o.nuts;
    }
    this.cam.textContent = `Camera: ${o.camera}`;
    this.buttons.bounds.querySelector("i")!.textContent = o.bounds ? "on" : "off";
    this.buttons.practice.querySelector("i")!.textContent = o.practice ? "on" : "off";
    document.body.classList.toggle("touch", o.touch);
    this.stick.update(o.stick);
  }
}
