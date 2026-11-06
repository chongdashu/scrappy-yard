// The engine's audio bus and music on a stub Web Audio context: a game's own UI sounds and SFX input, native
// (sample-accurate) music loops, and the music's duck depth and low-pass muffle.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioBus } from "../src/audio";
import { Music, type TrackDef } from "../src/music";

class Param {
  value = 1;
  calls: [string, number, number, number?][] = [];
  setValueAtTime(v: number, t: number) {
    this.value = v;
    this.calls.push(["set", v, t]);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(["ramp", v, t]);
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.calls.push(["exp", v, t]);
  }
  setTargetAtTime(v: number, t: number, tc: number) {
    this.calls.push(["target", v, t, tc]);
  }
  cancelScheduledValues() {}
  get last() {
    return this.calls.at(-1);
  }
}
class Node {
  out: Node[] = [];
  connect(n: Node) {
    this.out.push(n);
    return n;
  }
}
class Gain extends Node {
  gain = new Param();
}
class Filter extends Node {
  type = "";
  frequency = new Param();
  Q = new Param();
}
class Source extends Node {
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  playbackRate = new Param();
  started: [number, number | undefined][] = [];
  stopped: number[] = [];
  start(t: number, o?: number) {
    this.started.push([t, o]);
  }
  stop(t: number) {
    this.stopped.push(t);
  }
}
class Ctx {
  currentTime = 0;
  state = "running";
  destination = new Node();
  sources: Source[] = [];
  gains: Gain[] = [];
  filters: Filter[] = [];
  createGain() {
    const g = new Gain();
    this.gains.push(g);
    return g;
  }
  createBiquadFilter() {
    const f = new Filter();
    this.filters.push(f);
    return f;
  }
  createDynamicsCompressor() {
    return Object.assign(new Node(), { threshold: new Param(), knee: new Param(), ratio: new Param(), attack: new Param(), release: new Param() });
  }
  createBufferSource() {
    const s = new Source();
    this.sources.push(s);
    return s;
  }
  createOscillator() {
    return Object.assign(new Node(), { type: "", frequency: new Param(), start() {}, stop() {} });
  }
  createBuffer(_c: number, n: number) {
    const d = new Float32Array(n);
    return { getChannelData: () => d, length: n, duration: 1 };
  }
  get sampleRate() {
    return 8;
  }
  suspend() {
    this.state = "suspended";
    return Promise.resolve();
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  decodeAudioData(b: ArrayBuffer) {
    return Promise.resolve({ duration: 62.55, name: new TextDecoder().decode(b) });
  }
}

const TRACKS: Record<string, TrackDef> = {
  loop: { url: "assets/audio/loop.mp3", loopStart: 0.05, loopEnd: 60.05, gain: 0.9, native: true },
  fade: { url: "assets/audio/fade.mp3", loopStart: 0.2, loopEnd: 45.5, gain: 0.8 },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { baseURI: "http://localhost/", hidden: false, addEventListener: () => {} });
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("AudioContext", Ctx);
  vi.stubGlobal("fetch", (url: string) => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new TextEncoder().encode(url).buffer) }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Music", () => {
  const make = () => {
    const ctx = new Ctx();
    const out = new Node();
    const music = new Music(ctx as unknown as AudioContext, out as unknown as AudioNode, TRACKS);
    return { ctx, out, music };
  };

  it("loops a native track in the browser: loop points set, no crossfade timer", async () => {
    const { ctx, music } = make();
    await music.play("loop");
    expect(ctx.sources).toHaveLength(1);
    const s = ctx.sources[0];
    expect(s.loop).toBe(true);
    expect(s.loopStart).toBeCloseTo(0.05, 9);
    expect(s.loopEnd).toBeCloseTo(60.05, 9);
    expect(s.started).toEqual([[0, 0.05]]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(ctx.sources).toHaveLength(1);
  });

  it("does not start a track that was stopped while it decoded", async () => {
    const { ctx, music } = make();
    let finish!: (r: { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }) => void;
    vi.stubGlobal("fetch", () => new Promise((resolve) => (finish = resolve)));
    const pending = music.play("fade");
    music.stop();
    finish({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    await pending;
    expect(music.playing).toBeNull();
    expect(ctx.sources).toHaveLength(0);
  });

  it("keeps the current track when a newer play() supersedes a switch still decoding", async () => {
    const { ctx, music } = make();
    await music.play("loop");
    let finish!: (r: { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }) => void;
    vi.stubGlobal("fetch", () => new Promise((resolve) => (finish = resolve)));
    const pending = music.play("fade");
    await music.play("loop");
    finish({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    await pending;
    expect(music.playing).toBe("loop");
    expect(ctx.sources).toHaveLength(1);
  });

  it("never loops past the end of a shorter file", async () => {
    const { ctx, music } = make();
    (TRACKS.loop as TrackDef).loopEnd = 999;
    try {
      await music.play("loop");
      expect(ctx.sources[0].loopEnd).toBeCloseTo(62.55, 9);
    } finally {
      TRACKS.loop.loopEnd = 60.05;
    }
  });

  it("keeps crossfading a track that is not native, on a timer, as before", async () => {
    const { ctx, music } = make();
    await music.play("fade");
    expect(ctx.sources[0].loop).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(ctx.sources.length).toBeGreaterThan(1);
  });

  it("switches from a native loop to another track with a fade", async () => {
    const { ctx, music } = make();
    await music.play("loop");
    await music.play("fade");
    expect(ctx.sources[0].stopped).toHaveLength(1);
    expect(music.playing).toBe("fade");
  });

  it("ducks by 0.35 of the amount unless told a depth", () => {
    const { ctx, music } = make();
    void ctx;
    const duck = ctx.gains[1].gain; // bus, then duck
    music.setDuck(1);
    expect(duck.last).toEqual(["target", 0.65, 0, 0.25]);
    music.setDuck(1, 0.6);
    expect(duck.last![1]).toBeCloseTo(0.4, 9);
    music.setDuck(0.5, 1);
    expect(duck.last![1]).toBeCloseTo(0.5, 9);
    music.setDuck(9, 0.5); // (the amount is clamped)
    expect(duck.last![1]).toBeCloseTo(0.5, 9);
    music.setDuck(0);
    expect(duck.last![1]).toBe(1);
  });

  it("muffles through a low-pass between the bus and the duck: open at 20 kHz, 900 Hz at full", () => {
    const { ctx, music } = make();
    const [bus, duck] = ctx.gains;
    const lp = ctx.filters[0];
    expect(lp.type).toBe("lowpass");
    expect(lp.frequency.value).toBe(20000);
    expect(bus.out).toEqual([lp]);
    expect(lp.out).toEqual([duck]);
    music.setMuffle(1);
    expect(lp.frequency.last![1]).toBeCloseTo(900, 6);
    music.setMuffle(0.5);
    expect(lp.frequency.last![1]).toBeCloseTo(20000 * Math.sqrt(0.045), 6);
    music.setMuffle(0);
    expect(lp.frequency.last![1]).toBe(20000);
    music.setMuffle(7);
    expect(lp.frequency.last![1]).toBeCloseTo(900, 6);
  });

  it("offers its bus to a game's own music layers", () => {
    const { music } = make();
    expect(music.bus).toBeTruthy();
  });
});

describe("AudioBus", () => {
  it("builds with the game's tracks and decodes them in the background", async () => {
    const audio = new AudioBus(TRACKS);
    audio.prepare();
    await vi.advanceTimersByTimeAsync(0);
    expect(await audio.music!.load("loop")).toBeTruthy();
    audio.playMusic("loop");
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.music!.playing).toBe("loop");
  });

  it("leaves a preload: false track alone at boot and fetches it on its first play", async () => {
    const fetches = vi.fn((url: string) => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new TextEncoder().encode(url).buffer) }));
    vi.stubGlobal("fetch", fetches);
    const audio = new AudioBus({ eager: TRACKS.loop, later: { ...TRACKS.fade, preload: false } });
    audio.prepare();
    await vi.advanceTimersByTimeAsync(0);
    const urls = () => fetches.mock.calls.map(([url]) => url);
    expect(urls()).toEqual(["http://localhost/assets/audio/loop.mp3"]);
    audio.playMusic("later");
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual(["http://localhost/assets/audio/loop.mp3", "http://localhost/assets/audio/fade.mp3"]);
    expect(audio.music!.playing).toBe("later");
  });

  it("resumes a context iOS left interrupted (a call, an app switch) on the next gesture", () => {
    const audio = new AudioBus();
    audio.prepare();
    (audio.ctx as unknown as { state: string }).state = "interrupted";
    audio.unlock();
    expect(audio.ctx!.state).toBe("running");
  });

  it("exposes the SFX bus for a game's own nodes only once the context exists", () => {
    const audio = new AudioBus();
    expect(audio.sfxIn).toBeNull();
    audio.prepare();
    expect(audio.sfxIn).toBeTruthy();
    // The SFX bus reaches the limiter and the speakers through the master gain.
    let reaches = false;
    const seen = new Set<unknown>();
    const walk = (n: Node) => {
      if (seen.has(n)) return;
      seen.add(n);
      if (n === (audio.ctx!.destination as unknown as Node)) reaches = true;
      n.out.forEach(walk);
    };
    walk(audio.sfxIn as unknown as Node);
    expect(reaches).toBe(true);
  });

  it("lets a game replace each UI sound, and runs the built-in one when it declines", () => {
    const audio = new AudioBus();
    audio.prepare();
    audio.ctx!.resume();
    const tones = vi.spyOn(audio, "tone");
    const handled: string[] = [];
    // No override: the synthesised sounds play.
    audio.hover();
    audio.press();
    audio.back();
    audio.whoosh();
    expect(tones).toHaveBeenCalled();
    tones.mockClear();
    for (const name of ["hover", "press", "back", "whoosh"] as const) audio.ui[name] = () => (handled.push(name), true);
    audio.hover();
    audio.press();
    audio.back();
    audio.whoosh();
    expect(handled).toEqual(["hover", "press", "back", "whoosh"]);
    expect(tones).not.toHaveBeenCalled();
    // An override that declines hands back to the built-in sound.
    audio.ui.press = () => false;
    audio.press();
    expect(tones).toHaveBeenCalled();
  });
});
