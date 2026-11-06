// On-screen action buttons for touch: a game declares them (GameModule.buttons) and each one
// drives a named action exactly like a key would (held while a finger is on it, one `pressed`
// edge when it goes down). They live in their own layer above the play area, so a finger on a
// button never starts the move stick or the look drag. Shown only while the player uses touch
// controls (`Input.touchControls`: a coarse pointer, a touch so far, or the dev Mobile view) and only while the round is being played.
import type { Input } from "../input";

export interface TouchButtonDef {
  /** The action name this button holds (must exist in the game's `actions`). */
  action: string;
  label: string;
  /** "large" is the primary verb: a big thumb target. */
  size?: "large" | "normal";
  /** Accessible name; the label otherwise. */
  title?: string;
}

export class TouchButtons {
  private root: HTMLElement;
  private els = new Map<string, HTMLButtonElement>();
  /** The finger holding each button, while one is. */
  private holding = new Map<string, number>();

  constructor(private input: Input, defs: TouchButtonDef[], parent: HTMLElement = document.body) {
    this.root = Object.assign(document.createElement("div"), { className: "touch-btns", hidden: true });
    this.root.setAttribute("role", "group");
    this.root.setAttribute("aria-label", "Touch controls");
    for (const d of defs) {
      const b = Object.assign(document.createElement("button"), { className: `touch-btn touch-btn-${d.size ?? "normal"}`, type: "button" });
      b.dataset.action = d.action;
      b.setAttribute("aria-label", d.title ?? d.label);
      const face = Object.assign(document.createElement("span"), { textContent: d.label });
      b.append(face);
      const release = (e: PointerEvent) => {
        input.buttonUp(e.pointerId);
        b.classList.remove("down");
        if (this.holding.get(d.action) === e.pointerId) this.holding.delete(d.action);
      };
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        try {
          b.setPointerCapture(e.pointerId);
        } catch { /* a synthetic pointer: harmless */ }
        b.classList.add("down");
        this.holding.set(d.action, e.pointerId);
        input.buttonDown(e.pointerId, d.action);
      });
      b.addEventListener("pointerup", release);
      b.addEventListener("pointercancel", release);
      b.addEventListener("lostpointercapture", release);
      b.addEventListener("contextmenu", (e) => e.preventDefault());
      this.els.set(d.action, b);
      this.root.append(b);
    }
    parent.append(this.root);
  }

  /** Change a button's face (e.g. GRAB → SPIN). */
  setLabel(action: string, text: string) {
    const span = this.els.get(action)?.firstElementChild;
    if (span && span.textContent !== text) span.textContent = text;
  }

  /** Mark a button as the useful one right now (a CSS hook: `.ready`). */
  setReady(action: string, on: boolean) {
    this.els.get(action)?.classList.toggle("ready", on);
  }

  /**
   * Show or hide one button while the layer is up (a Brake button only while driving). Hiding a button a finger is
   * holding lets its action go at once, as lifting the finger would. Unknown actions are ignored.
   */
  setShown(action: string, on: boolean) {
    const b = this.els.get(action);
    if (!b || b.hidden === !on) return;
    b.hidden = !on;
    const finger = this.holding.get(action);
    if (!on && finger !== undefined) {
      this.holding.delete(action);
      this.input.buttonUp(finger);
      b.classList.remove("down");
    }
  }

  /** Called every frame: show with touch controls (`Input.touchControls`) while `active` (a round is being played). */
  update(active: boolean) {
    const show = active && this.input.touchControls;
    if (this.root.hidden === show) this.root.hidden = !show;
  }
}
