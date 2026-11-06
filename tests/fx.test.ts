import { describe, expect, it } from "vitest";
import { PARTICLE, Particles } from "../src/fx";
import { PARTICLE_FLOATS } from "../src/gpu/renderer";

const burst = (p: Particles) => p.burst(10, { kind: PARTICLE.chip, x: 0, y: 1, z: 0, size: 0.1, life: 1, color: [1, 0, 0], gravity: 9 }, [1, 2], [2, 3]);

describe("Particles", () => {
  it("is repeatable for a seed", () => {
    const a = new Particles(64, 5), b = new Particles(64, 5);
    burst(a);
    burst(b);
    for (let i = 0; i < 20; i++) {
      a.update(1 / 60);
      b.update(1 / 60);
    }
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
  it("freezes at dt = 0 and expires at the end of life", () => {
    const p = new Particles(64, 1);
    burst(p);
    p.update(0.1);
    const snap = Array.from(p.data.subarray(0, p.count * PARTICLE_FLOATS));
    p.update(0);
    expect(Array.from(p.data.subarray(0, p.count * PARTICLE_FLOATS))).toEqual(snap);
    for (let i = 0; i < 120; i++) p.update(1 / 60);
    expect(p.count).toBe(0);
  });
  it("recycles the oldest when full", () => {
    const p = new Particles(4, 1);
    for (let i = 0; i < 10; i++) p.spawn({ kind: 0, x: i, y: 1, z: 0, size: 1, life: 5, color: [1, 1, 1] });
    p.update(0);
    expect(p.count).toBe(4);
    expect(p.data[0]).toBe(6);
  });
  it("keeps the newest in order when it wraps more than once, and expiry keeps the order", () => {
    const p = new Particles(4, 1);
    const at = (x: number, life = 5) => p.spawn({ kind: 0, x, y: 1, z: 0, size: 1, life, color: [1, 1, 1] });
    for (let i = 0; i < 11; i++) at(i);
    p.update(0);
    expect([0, 1, 2, 3].map((i) => p.data[i * PARTICLE_FLOATS])).toEqual([7, 8, 9, 10]);
    // Expire the middle two and add one: the survivors stay oldest-first, the new one goes last.
    p.clear();
    at(0, 5); at(1, 0.05); at(2, 0.05); at(3, 5);
    p.update(0.1);
    at(4);
    p.update(0);
    expect(p.count).toBe(3);
    expect([0, 1, 2].map((i) => p.data[i * PARTICLE_FLOATS])).toEqual([0, 3, 4]);
  });
  it("keeps the newest full pool through many wraps at the runtime's capacity", () => {
    const p = new Particles(2048, 1);
    const spec = { kind: 0, x: 0, y: 1, z: 0, size: 1, life: 5, color: [1, 1, 1] as [number, number, number] };
    for (let i = 0; i < 2048; i++) p.spawn(spec);
    for (let i = 0; i < 200_000; i++) p.spawn({ ...spec, x: i });
    p.update(0);
    expect(p.count).toBe(2048);
    expect(p.data[2047 * PARTICLE_FLOATS]).toBe(199_999);
    expect(p.data[0]).toBe(199_999 - 2047);
  });
  it("drops emits while paused and accepts them again after", () => {
    const p = new Particles(64, 1);
    burst(p);
    p.update(1 / 60);
    const n = p.count;
    p.paused = true;
    burst(p);
    p.spawn({ kind: 0, x: 0, y: 1, z: 0, size: 1, life: 5, color: [1, 1, 1] });
    p.update(0);
    expect(p.count).toBe(n);
    expect(p.size).toBe(n);
    p.paused = false;
    burst(p);
    p.update(0);
    expect(p.count).toBe(n + 10);
  });
});
