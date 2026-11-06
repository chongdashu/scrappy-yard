// Recorded SFX (ElevenLabs, docs/audio/manifest.md) on the engine bus (rt.audio.sfxIn): fetched and
// decoded in the background; any clip that fails to load or play is skipped (callers fall back to
// synthesis). Never blocks the sim.
import type { AudioBus } from "@engine/audio";

export const SFX = ["ui_hover", "ui_click", "ui_back", "ui_start", "jump", "land", "pickup", "strafe", "hit", "fall",
  "gameover", "danger", "stomp", "win", "retry"] as const;
export type SfxName = (typeof SFX)[number];

export class Sfx {
  private bufs = new Map<SfxName, AudioBuffer>();
  private started = false;
  constructor(private bus: AudioBus, private base = "assets/audio/") {}

  /** Start loading once the context exists (call any time; cheap after the first). */
  load() {
    const ctx = this.bus.ctx;
    if (this.started || !ctx) return;
    this.started = true;
    for (const n of SFX) {
      fetch(`${this.base}sfx_${n}.mp3`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
        .then((b) => ctx.decodeAudioData(b))
        .then((buf) => this.bufs.set(n, buf))
        .catch((e) => console.warn(`[sfx] ${n} unavailable`, e));
    }
  }

  /** Play a clip; true when it played (false: not loaded / locked, so the caller may synthesise). */
  play(n: SfxName, vol = 1, rate = 1): boolean {
    this.load();
    const ctx = this.bus.ctx, out = this.bus.sfxIn, buf = this.bufs.get(n), t = this.bus.now;
    if (!ctx || !out || !buf || t < 0) return false;
    try {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = vol;
      s.connect(g).connect(out);
      s.start(t);
      return true;
    } catch {
      return false;
    }
  }
}
