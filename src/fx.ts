// Presentation particles (sparkles, rings, confetti). Spawned from sim events
// on the TypeScript side; they never affect gameplay. Seeded so `?capture`
// runs are repeatable, and stepped with the presentation dt (0 while paused).
// A fixed-capacity ring: at capacity a new particle replaces the oldest in O(1).
import { PARTICLE_FLOATS } from "./gpu/renderer";

export const PARTICLE = { glow: 0, sparkle: 1, ring: 2, chip: 3, star: 4 } as const;

export interface ParticleSpec {
  kind: number;
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  size: number;
  life: number;
  /** Linear RGB. */
  color: [number, number, number];
  /** Extra brightness (blooms past ~1). */
  glow?: number;
  gravity?: number;
  /** Velocity damping (1/s). */
  drag?: number;
  spin?: number;
  alpha?: number;
}

interface Particle extends Required<ParticleSpec> {
  age: number;
  rot: number;
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Particles {
  readonly data: Float32Array;
  count = 0;
  /**
   * Drop new particles (set by the runtime while the round is paused). A paused frame has dt = 0, so nothing ages or expires; a game that
   * emits every frame would otherwise fill the pool and spend each paused frame evicting. Spawns resume when it turns false.
   */
  paused = false;
  /** A ring of live particles, oldest at `head`: evicting the oldest at capacity is O(1). */
  private ring: (Particle | undefined)[];
  private head = 0;
  private live = 0;
  random: () => number;

  constructor(readonly capacity = 2048, seed = 1) {
    this.data = new Float32Array(capacity * PARTICLE_FLOATS);
    this.ring = new Array(capacity);
    this.random = rng(seed);
  }

  /** Live particles (≤ capacity); `count` is how many were packed by the last update(). */
  get size() {
    return this.live;
  }

  clear() {
    this.ring.fill(undefined);
    this.head = 0;
    this.live = 0;
    this.count = 0;
  }

  spawn(p: ParticleSpec) {
    if (this.paused || this.capacity <= 0) return;
    const item: Particle = { vx: 0, vy: 0, vz: 0, glow: 0, gravity: 0, drag: 0, spin: 0, alpha: 1, ...p, age: 0, rot: this.random() * Math.PI * 2 };
    if (this.live >= this.capacity) {
      // Full: the oldest makes room (overwrite it and move the head on).
      this.ring[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
    } else {
      this.ring[(this.head + this.live) % this.capacity] = item;
      this.live++;
    }
  }

  /** A radial burst: `n` particles thrown outward and up from a point. */
  burst(n: number, base: Omit<ParticleSpec, "vx" | "vy" | "vz">, speed: [number, number], up: [number, number]) {
    const r = this.random;
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const s = speed[0] + (speed[1] - speed[0]) * r();
      this.spawn({
        ...base,
        vx: Math.sin(a) * s,
        vz: Math.cos(a) * s,
        vy: up[0] + (up[1] - up[0]) * r(),
        size: base.size * (0.7 + 0.6 * r()),
        life: base.life * (0.75 + 0.5 * r()),
        spin: (r() - 0.5) * 12,
      });
    }
  }

  /** Advance and pack into `data`, oldest first (call once per frame; dt = 0 freezes). */
  update(dt: number) {
    const cap = this.capacity, ring = this.ring;
    if (dt > 0) {
      // Age and move every particle, keeping the survivors in order (compacted toward the head).
      let w = 0;
      for (let i = 0; i < this.live; i++) {
        const slot = (this.head + i) % cap;
        const p = ring[slot]!;
        p.age += dt;
        if (p.age >= p.life) continue;
        p.vy -= p.gravity * dt;
        const k = Math.max(0, 1 - p.drag * dt);
        p.vx *= k;
        p.vy *= k;
        p.vz *= k;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        if (p.y < 0.02 && p.vy < 0) {
          p.y = 0.02;
          p.vy *= -0.35;
          p.vx *= 0.6;
          p.vz *= 0.6;
        }
        p.rot += p.spin * dt;
        ring[(this.head + w++) % cap] = p;
      }
      for (let i = w; i < this.live; i++) ring[(this.head + i) % cap] = undefined;
      this.live = w;
    }
    const d = this.data;
    this.count = this.live;
    for (let i = 0; i < this.count; i++) {
      const p = ring[(this.head + i) % cap]!;
      const o = i * PARTICLE_FLOATS;
      d[o] = p.x;
      d[o + 1] = p.y;
      d[o + 2] = p.z;
      d[o + 3] = p.size;
      d[o + 4] = p.kind;
      d[o + 5] = Math.min(1, p.age / p.life);
      d[o + 6] = p.rot;
      d[o + 7] = p.alpha;
      d[o + 8] = p.color[0];
      d[o + 9] = p.color[1];
      d[o + 10] = p.color[2];
      d[o + 11] = p.glow;
    }
  }
}
