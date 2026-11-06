// The floating touch stick drawn under the thumb (Input.touchStick is the state; this is the
// view). A game that steers with the stick creates one and updates it every frame.
import { STICK_RADIUS, type TouchStick } from "../input";

export class TouchStickView {
  private root: HTMLElement;
  private knob: HTMLElement;

  constructor(parent: HTMLElement = document.body) {
    this.root = Object.assign(document.createElement("div"), { className: "touch-stick", hidden: true });
    this.root.setAttribute("aria-hidden", "true");
    this.knob = Object.assign(document.createElement("div"), { className: "touch-knob" });
    this.root.append(this.knob);
    parent.append(this.root);
  }

  /** Show the stick at its origin with the knob toward the thumb (clamped to the radius), or hide it. */
  update(stick: TouchStick | null) {
    if (!stick) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    this.root.style.transform = `translate(${stick.ox}px, ${stick.oy}px)`;
    let dx = stick.x - stick.ox, dy = stick.y - stick.oy;
    const d = Math.hypot(dx, dy);
    if (d > STICK_RADIUS) {
      dx *= STICK_RADIUS / d;
      dy *= STICK_RADIUS / d;
    }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }
}
