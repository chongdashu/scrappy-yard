// This game's ABI mirror (src/sim-abi.ts) against its built module (public/wasm/sim.wasm,
// from `npm run wasm`), driven through the same exports the page uses. The Rust tests in
// crate/ cover the rules; these prove the page reads them right.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EVENT_FLOATS, Sim } from "@engine/wasm";
import { ABI, EV, MODE, NU, OB, OB_KIND, PARAM, PARAMS, PL, ST, STATE, STRIDES, lanesAt, type GameExports } from "../src/sim-abi";
import { CAMERAS, framing } from "../src/game";

const WASM = new URL("../public/wasm/sim.wasm", import.meta.url);

async function load(seed = 1): Promise<Sim<GameExports>> {
  const { instance } = await WebAssembly.instantiate(readFileSync(WASM), {});
  const sim = new Sim<GameExports>(instance, ABI);
  sim.x.sim_init(seed);
  sim.verifyAbi();
  return sim;
}

const run = (sim: Sim<GameExports>, seconds: number) => {
  for (let f = 0; f < Math.round(seconds * 60); f++) sim.x.sim_advance(1 / 60);
};

describe.skipIf(!existsSync(WASM))("this game's sim.wasm (run `npm run wasm` first)", () => {
  it("mirrors the params", async () => {
    const sim = await load();
    expect(sim.x.sim_param_count()).toBe(PARAMS.length);
    expect(sim.x.sim_param_get(PARAM.laneWidth)).toBeCloseTo(1.4);
  });

  it("starts a round on GO, runs forward along +Z and freezes while paused", async () => {
    const sim = await load();
    expect(sim.f32("stats")[ST.state]).toBe(STATE.ready);
    sim.x.sim_round_start();
    const ev = sim.f32("events");
    expect(ev.length).toBe(EVENT_FLOATS);
    expect(ev[0]).toBe(EV.roundStart);
    sim.x.sim_clear_frame();
    run(sim, 1);
    const st = sim.f32("stats");
    expect(st[ST.state]).toBe(STATE.playing);
    expect(st[ST.roundTime]).toBeCloseTo(1, 4);
    const z = sim.f32("player")[PL.z];
    expect(z).toBeGreaterThan(6);
    sim.x.sim_set_paused(1);
    run(sim, 1);
    expect(sim.f32("stats")[ST.roundTime]).toBeCloseTo(1, 4);
    expect(sim.f32("player")[PL.z]).toBe(z);
  });

  it("strafes freely with a held axis, stops where released, and reports the nearest lane", async () => {
    const sim = await load();
    const lw = sim.x.sim_param_get(PARAM.laneWidth);
    sim.x.sim_round_start();
    sim.x.sim_clear_frame();
    sim.x.sim_strafe(1);
    run(sim, 0.15);
    sim.x.sim_strafe(0);
    run(sim, 0.3);
    const x = sim.f32("player")[PL.x];
    expect(x).toBeGreaterThan(0.2);
    expect(x).toBeLessThan(lw - 0.2);
    run(sim, 0.3);
    expect(sim.f32("player")[PL.x]).toBe(x);
    expect(sim.f32("player")[PL.lane]).toBe(Math.round(x / lw));
    sim.x.sim_strafe(-1);
    run(sim, 1.5);
    const p = sim.f32("player");
    expect(p[PL.lane]).toBe(-1);
    expect(p[PL.x]).toBeCloseTo(-(lw + sim.x.sim_param_get(PARAM.strafeMargin)), 3);
  });

  it("lanesAt: the nearest lane, plus the neighbour while straddling", () => {
    expect(lanesAt(0, 1.4, 0.32)).toEqual([0]);
    expect(lanesAt(0.5, 1.4, 0.32)).toEqual([0]);
    expect(lanesAt(0.7, 1.4, 0.32)).toEqual([0, 1]);
    expect(lanesAt(-1.9, 1.4, 0.32)).toEqual([-1]);
    expect(lanesAt(1.0, 1.4, 0.32)).toEqual([1]);
  });

  it("nudges a lane and jumps through the exports", async () => {
    const sim = await load();
    sim.x.sim_round_start();
    sim.x.sim_lane(-1);
    run(sim, 0.4);
    let p = sim.f32("player");
    expect(p[PL.lane]).toBe(-1);
    expect(p[PL.x]).toBeCloseTo(-sim.x.sim_param_get(PARAM.laneWidth), 3);
    sim.x.sim_jump();
    run(sim, 0.2);
    p = sim.f32("player");
    expect(p[PL.y]).toBeGreaterThan(0.5);
    expect(p[PL.grounded]).toBe(0);
  });

  it("lays out a course: obstacles in lanes, gaps, nuts on the track", async () => {
    const sim = await load(7);
    const o = sim.f32("obstacles");
    expect(o.length % STRIDES.obstacles).toBe(0);
    const kinds = new Set<number>();
    for (let i = 0; i < o.length; i += STRIDES.obstacles) {
      kinds.add(o[i + OB.kind]);
      expect([-1, 0, 1]).toContain(o[i + OB.lane]);
      expect(o[i + OB.z]).toBeGreaterThan(25);
    }
    expect(kinds.has(OB_KIND.barrel)).toBe(true);
    const n = sim.f32("nuts");
    expect(n.length / STRIDES.nuts).toBe(sim.f32("stats")[ST.nutsTotal]);
    for (let i = 0; i < n.length; i += STRIDES.nuts) expect(Math.abs(n[i + NU.x])).toBeLessThan(1.5);
  });

  it("practice keeps the round going; viewer mode runs no rules", async () => {
    const sim = await load(3);
    sim.x.sim_param_set(PARAM.practice, 1);
    sim.x.sim_round_start();
    run(sim, 20); // no input: crashes into whatever comes
    expect(sim.f32("stats")[ST.state]).toBe(STATE.playing);
    expect(sim.f32("stats")[ST.practice]).toBe(1);

    const v = await load(3);
    v.x.sim_set_mode(MODE.viewer);
    v.x.sim_round_start();
    run(v, 2);
    expect(v.f32("stats")[ST.mode]).toBe(MODE.viewer);
    expect(v.f32("player")[PL.z]).toBe(0);
  });
});

describe("oncoming camera presets", () => {
  it("blend portrait → landscape by aspect", () => {
    const d = CAMERAS[0];
    expect(framing(d, 0.46)).toMatchObject(d.portrait);
    expect(framing(d, 16 / 9)).toMatchObject(d.landscape);
    const mid = framing(d, 0.945);
    expect(mid.fov).toBeGreaterThan(d.landscape.fov);
    expect(mid.fov).toBeLessThan(d.portrait.fov);
  });
});
