// Audio bus: sfx + music → master → limiter → speakers.
//
// - The context is created early (suspended) and unlocked by the first user
//   activation; "press to start" doubles as that gesture. On touch screens
//   only the end of a tap (pointerup/touchend/click) counts as activation.
//   Sound-on preference is not proof the browser plays audio: check `unlocked`.
// - Hidden tabs suspend the context; returning resumes it.
// - Mute layers: the player's own toggle, the host's mute (platform) and an
//   ad in progress. Any of them silences the master without changing the others.
// - Synthesis primitives (tone, noise burst) for placeholder SFX; UI sounds
//   live here, game sounds in the game's own module on this bus (`rt.audio`).
//   A game with recorded sounds connects its own nodes at `sfxIn` (master mute
//   and the limiter still apply) and can replace the four UI sounds via `ui`.
import { Music, type TrackDef } from "./music";

export interface Volumes {
  master: number;
  sfx: number;
  music: number;
}

export class AudioBus {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private noiseBuf!: AudioBuffer;
  music: Music | null = null;
  private tracks: Record<string, TrackDef>;
  private muted = false;
  private hostMute = false;
  private adMute = false;
  private vol: Volumes = { master: 0.55, sfx: 1, music: 0.7 };
  private wantTrack: string | null = null;
  /** Creating the context failed once; don't retry on every tap. */
  private noAudio = false;
  /**
   * Optional replacements for the four UI sounds (the menu and the settings panel call `hover`, `press`,
   * `back` and `whoosh` below). Return true when the sound was handled; false runs the built-in synthesis.
   */
  ui: Partial<Record<"hover" | "press" | "back" | "whoosh", () => boolean>> = {};

  constructor(tracks: Record<string, TrackDef> = {}) {
    this.tracks = tracks;
    // Resume on any user activation. For touch, pointerdown does NOT count as
    // activation (only pointerup/touchend/click do), so listen to those too.
    const unlock = () => this.unlock();
    for (const type of ["pointerdown", "pointerup", "touchend", "click", "keydown"]) addEventListener(type, unlock, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend().catch(() => { /* already closed */ });
      else this.wake();
    });
  }

  /** Resume the context. Browsers reject this when no audio device can start; play on silently. */
  private wake() {
    this.ctx?.resume().catch((e) => console.warn("[audio] could not start the audio device; playing silently", e));
  }

  get unlocked() {
    return this.ctx?.state === "running";
  }

  /**
   * Create/resume the context. Call from a user gesture. iOS leaves the context "interrupted" (not
   * "suspended") after a call or an app switch, and only a gesture's resume() brings it back.
   */
  unlock() {
    this.ensure();
    const state: string | undefined = this.ctx?.state;
    if ((state === "suspended" || state === "interrupted") && !document.hidden) this.wake();
  }

  /** Create the (suspended) context during loading and start decoding the music tracks that preload (all but `preload: false`). Never blocks Play. */
  prepare() {
    this.ensure();
    for (const [name, track] of Object.entries(this.tracks)) if (track.preload !== false) void this.music?.load(name);
  }

  setVolumes(v: Partial<Volumes>) {
    this.vol = { ...this.vol, ...v };
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.sfxBus.gain.setTargetAtTime(this.vol.sfx, t, 0.05);
    this.music?.bus.gain.setTargetAtTime(this.vol.music, t, 0.05);
    this.applyMute();
  }

  /** Background music by name (a registered track), or null to stop. Unknown names are ignored. */
  playMusic(name: string | null) {
    this.wantTrack = name;
    if (!this.music) return;
    if (name && this.tracks[name]) void this.music.play(name);
    else this.music.stop();
  }

  get isMuted() {
    return this.muted;
  }

  setMuted(on: boolean) {
    this.muted = on;
    this.applyMute();
  }

  /** The host's mute wins over the player's toggle without changing it. */
  setHostMuted(on: boolean) {
    this.hostMute = on;
    this.applyMute();
  }

  /** Silence everything while an ad plays. */
  setAdMuted(on: boolean) {
    this.adMute = on;
    this.applyMute();
  }

  get silent() {
    return this.muted || this.hostMute || this.adMute;
  }

  private applyMute() {
    if (this.ctx) this.master.gain.setTargetAtTime(this.silent ? 0 : this.vol.master, this.ctx.currentTime, 0.03);
  }

  private ensure() {
    if (this.ctx || this.noAudio) return;
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch (e) {
      this.noAudio = true;
      console.warn("[audio] no audio context; playing silently", e);
      return;
    }
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.silent ? 0 : this.vol.master;
    // Limiter: a fast, high-ratio compressor so stacked one-shots don't clip.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
    this.master.connect(limiter).connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.vol.sfx;
    this.sfxBus.connect(this.master);
    this.music = new Music(ctx, this.master, this.tracks);
    this.music.bus.gain.value = this.vol.music;
    if (this.wantTrack) this.playMusic(this.wantTrack);
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  /**
   * Where a game connects its own nodes (decoded samples): the SFX bus, so the SFX volume, the mute layers
   * and the limiter apply. Null until the context exists.
   */
  get sfxIn(): AudioNode | null {
    return this.ctx ? this.sfxBus : null;
  }

  /** Audio clock time when sound can play now, else -1 (locked, suspended or no device). */
  get now(): number {
    return this.ctx && this.ctx.state === "running" ? this.ctx.currentTime : -1;
  }

  /** An oscillator sweep f0 → f1 with a quick attack and exponential decay. */
  tone(type: OscillatorType, f0: number, f1: number, start: number, dur: number, vol: number) {
    const ctx = this.ctx;
    if (!ctx || start < 0) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, start);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), start + dur);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(this.sfxBus);
    o.start(start);
    o.stop(start + dur + 0.02);
  }

  /** A filtered noise burst (hits, whooshes, thuds). */
  noise(start: number, dur: number, freq: number, vol: number, type: BiquadFilterType = "bandpass", q = 1) {
    const ctx = this.ctx;
    if (!ctx || start < 0) return;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    s.connect(f).connect(g).connect(this.sfxBus);
    s.start(start, Math.random() * 0.5);
    s.stop(start + dur + 0.02);
  }

  // ---------------------------------------------------------------- UI sounds

  /** Soft tick when the menu cursor moves. */
  hover() {
    if (this.ui.hover?.()) return;
    this.tone("sine", 1180, 1320, this.now, 0.05, 0.05);
  }

  /** Pop for presses. */
  press() {
    if (this.ui.press?.()) return;
    const t = this.now;
    this.tone("sine", 420, 980, t, 0.09, 0.18);
    this.tone("triangle", 1500, 1900, t + 0.03, 0.06, 0.04);
  }

  back() {
    if (this.ui.back?.()) return;
    this.tone("sine", 900, 420, this.now, 0.12, 0.13);
  }

  /** Screen transition. */
  whoosh() {
    if (this.ui.whoosh?.()) return;
    const t = this.now;
    const ctx = this.ctx;
    if (!ctx || t < 0) return;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(2400, t + 0.3);
    f.frequency.exponentialRampToValueAtTime(900, t + 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
    s.connect(f).connect(g).connect(this.sfxBus);
    s.start(t);
    s.stop(t + 0.7);
  }
}
