// Optional background music: decoded tracks looped with a crossfade (many
// generated tracks don't loop sample-accurately) or, for files that ARE
// seamless loops, with the browser's own sample-accurate loop (`native`);
// switching with a fade, a duck control and a low-pass "muffle". Lives on the
// audio context's music bus (src/audio.ts).
//
// The starter ships no music. A game declares tracks in its GameModule
// (`audio: { tracks }`, src/game.ts), which src/main.ts passes to AudioBus:
//   { menu: { url: "assets/audio/menu.mp3", loopStart: 0.2, loopEnd: 45.5, gain: 0.8 } }
// and calls audio.playMusic("menu"). A missing or failing file only logs a
// warning; loading never blocks Play. A track with `preload: false` loads on its first play.

export interface TrackDef {
  /** Relative to the page (nested hosting): no leading slash. */
  url: string;
  /** Loop window in seconds (skip a fade-in/out). */
  loopStart: number;
  loopEnd: number;
  gain: number;
  /**
   * Decode at boot (the default) or, with `false`, on the first `play`: for a track a player may never hear (a boss
   * theme, an online-only mode), so its decoded audio is not held from the start. That first play starts late by the
   * fetch and decode.
   */
  preload?: boolean;
  /**
   * Loop with AudioBufferSourceNode.loop (sample accurate, no timer) instead of the timer crossfade.
   * For files that are seamless loops between loopStart and loopEnd; the crossfade default suits
   * tracks that are not (its timer fires late by whatever the main thread is doing).
   */
  native?: boolean;
}

const XFADE = 2.5;
/** The muffle filter's open cutoff, and the share of it left at full muffle (20 kHz * 0.045 = 900 Hz). */
const OPEN_HZ = 20000;
const MUFFLED = 0.045;

export class Music {
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Map<string, Promise<AudioBuffer | null>>();
  private current: { name: string; src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private timer = 0;
  /** Counts play() and stop() calls: a play() that finished decoding after a newer call gives way to it. */
  private request = 0;
  private duck: GainNode;
  /** Low-pass between the bus and the duck, wide open until setMuffle closes it. */
  private filter: BiquadFilterNode;
  /** A game's own music layers connect here: they follow the music volume, the muffle and the duck. */
  readonly bus: GainNode;

  constructor(private ctx: AudioContext, out: AudioNode, private tracks: Record<string, TrackDef>) {
    this.bus = ctx.createGain();
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = OPEN_HZ;
    this.duck = ctx.createGain();
    this.bus.connect(this.filter).connect(this.duck).connect(out);
  }

  /** Fetch + decode (safe to call early; resolves null on failure or an unknown name). */
  load(name: string): Promise<AudioBuffer | null> {
    const have = this.loading.get(name);
    if (have) return have;
    const def = this.tracks[name];
    if (!def) return Promise.resolve(null);
    const p = fetch(new URL(def.url, document.baseURI).href)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => this.ctx.decodeAudioData(b))
      .then((buf) => {
        this.buffers.set(name, buf);
        return buf;
      })
      .catch((e) => {
        console.warn(`[music] ${name} failed to load`, e);
        return null;
      });
    this.loading.set(name, p);
    return p;
  }

  get playing(): string | null {
    return this.current?.name ?? null;
  }

  /** Switch to a track with a crossfade (no-op if already playing it). */
  async play(name: string, fade = 1.2) {
    const request = ++this.request;
    if (this.current?.name === name) return;
    const buf = this.buffers.get(name) ?? (await this.load(name));
    // A later play() or stop() while this one decoded wins: stop() stays silent and the newer track stays on.
    if (!buf || request !== this.request || this.ctx.state === "closed" || this.current?.name === name) return;
    this.stopCurrent(fade);
    this.startSource(name, buf, this.tracks[name].loopStart, fade);
  }

  stop(fade = 0.8) {
    this.request++;
    this.stopCurrent(fade);
    this.current = null;
  }

  /** 0..1 ducking amount, applied smoothly: the music is scaled by `1 - depth * amount` (0.35 is about -3.7 dB at full). */
  setDuck(amount: number, depth = 0.35) {
    this.duck.gain.setTargetAtTime(1 - depth * Math.min(1, Math.max(0, amount)), this.ctx.currentTime, 0.25);
  }

  /** 0..1 low-pass, applied smoothly: 0 leaves the music alone, 1 closes it to about 900 Hz (heard through a wall or under water). */
  setMuffle(amount: number) {
    const f = Math.min(1, Math.max(0, amount));
    this.filter.frequency.setTargetAtTime(OPEN_HZ * Math.pow(MUFFLED, f), this.ctx.currentTime, 0.12);
  }

  private startSource(name: string, buf: AudioBuffer, offset: number, fade: number) {
    const t = this.ctx.currentTime;
    const def = this.tracks[name];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(def.gain, t + fade);
    const loopEnd = Math.min(def.loopEnd, buf.duration);
    if (def.native) {
      src.loop = true;
      src.loopStart = def.loopStart;
      src.loopEnd = loopEnd;
    }
    src.connect(gain).connect(this.bus);
    src.start(t, offset);
    this.current = { name, src, gain };
    // A native loop needs no timer; otherwise schedule the next crossfaded loop just before the loop end.
    clearTimeout(this.timer);
    if (def.native) return;
    const untilXfade = Math.max(0.5, loopEnd - offset - XFADE);
    this.timer = window.setTimeout(() => {
      if (this.current?.src !== src) return;
      this.fadeOut(gain, src, XFADE);
      this.startSource(name, buf, def.loopStart, XFADE);
    }, untilXfade * 1000);
  }

  private stopCurrent(fade: number) {
    clearTimeout(this.timer);
    if (!this.current) return;
    this.fadeOut(this.current.gain, this.current.src, fade);
  }

  private fadeOut(gain: GainNode, src: AudioBufferSourceNode, fade: number) {
    const t = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + fade);
    src.stop(t + fade + 0.05);
  }
}
