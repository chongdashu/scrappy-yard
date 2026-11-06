// World-anchored text pops ("+1", "BONUS!") positioned each frame through the
// rendered camera's projection. Timed on the presentation clock, so they
// freeze with the game and stay deterministic in `?capture` runs.

export type PopKind = "good" | "big" | "bad" | "info";

interface Pop {
  el: HTMLElement;
  x: number;
  y: number;
  z: number;
  born: number;
  life: number;
}

export class Pops {
  private pops: Pop[] = [];
  private clock = 0;

  constructor(private layer: HTMLElement) {}

  /** Show `text` above a world point for `life` seconds. */
  pop(x: number, y: number, z: number, text: string, kind: PopKind = "good", life = 1.1) {
    const el = document.createElement("div");
    el.className = `pop pop-${kind}`;
    el.textContent = text;
    el.style.setProperty("--tilt", `${(((this.pops.length * 7) % 9) - 4).toFixed(1)}deg`);
    this.layer.appendChild(el);
    this.pops.push({ el, x, y, z, born: this.clock, life });
  }

  clear() {
    for (const p of this.pops) p.el.remove();
    this.pops = [];
  }

  /** Advance by the presentation dt and re-anchor every pop. */
  update(dt: number, project: (p: [number, number, number]) => [number, number] | null) {
    this.clock += dt;
    this.pops = this.pops.filter((p) => {
      const age = (this.clock - p.born) / p.life;
      if (age >= 1) {
        p.el.remove();
        return false;
      }
      const s = project([p.x, p.y, p.z]);
      p.el.hidden = !s;
      if (s) {
        p.el.style.setProperty("--x", `${s[0].toFixed(1)}px`);
        p.el.style.setProperty("--y", `${(s[1] - age * 50).toFixed(1)}px`);
        p.el.style.setProperty("--a", age.toFixed(3));
      }
      return true;
    });
  }
}
