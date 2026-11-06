// The engine's side of the C ABI against the ACTIVE game's built module
// (<gameDir>/public/wasm/sim.wasm from `npm run wasm`) and its ABI mirror (`@game`'s abi):
// whichever game is active, its wasm must import nothing, carry the engine and game ABI
// versions this page expects, and run the engine lifecycle. Game rules are the game's own
// tests (<gameDir>/tests/).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import game from "@game";
import { AbiMismatch, ENGINE_ABI_VERSION, EVENT_FLOATS, Sim } from "../src/wasm";
import { loadActiveGame } from "../scripts/lib/active-game.mjs";

const active = loadActiveGame();
const built = existsSync(active.wasmPath);

async function load(seed = 1): Promise<Sim> {
  const { instance } = await WebAssembly.instantiate(readFileSync(active.wasmPath), {});
  const sim = new Sim(instance, game.abi);
  sim.x.sim_init(seed);
  return sim;
}

describe("Sim.verifyAbi", () => {
  const layout = { version: 3, strides: { thing: 4 } };
  const fake = (engine: number, version: number, strides: Record<string, number> = {}) =>
    new Sim({ exports: { sim_engine_version: () => engine, sim_abi_version: () => version, ...Object.fromEntries(Object.entries({ thing: 4, events: EVENT_FLOATS, ...strides }).map(([k, v]) => [`buf_${k}_stride`, () => v])) } } as unknown as WebAssembly.Instance, layout);
  it("refuses a module from different engine or game sources (a stale sim.wasm)", () => {
    expect(() => fake(ENGINE_ABI_VERSION, 3).verifyAbi()).not.toThrow();
    expect(() => fake(ENGINE_ABI_VERSION + 1, 3).verifyAbi()).toThrow(/engine ABI/);
    expect(() => fake(ENGINE_ABI_VERSION, 4).verifyAbi()).toThrow(AbiMismatch);
    expect(() => fake(ENGINE_ABI_VERSION, 3, { thing: 5 }).verifyAbi()).toThrow(/thing/);
    expect(() => fake(ENGINE_ABI_VERSION, 3, { events: 7 }).verifyAbi()).toThrow(/events/);
  });
  it("names a buffer missing from the mirror instead of reading garbage", () => {
    expect(() => fake(ENGINE_ABI_VERSION, 3).f32("nope")).toThrow(/No buffer "nope"/);
  });
});

describe.skipIf(!built)(`the active game's sim.wasm (${active.dir}; run \`npm run wasm\` first)`, () => {
  it("imports nothing and matches the page's engine and game ABI", async () => {
    const mod = new WebAssembly.Module(readFileSync(active.wasmPath));
    expect(WebAssembly.Module.imports(mod)).toEqual([]);
    const sim = await load();
    expect(sim.x.sim_engine_version()).toBe(ENGINE_ABI_VERSION);
    expect(sim.x.sim_abi_version()).toBe(game.abi.version);
    expect(() => sim.verifyAbi()).not.toThrow();
  });

  it("has the tuning table the game declares, with defaults inside the slider ranges", async () => {
    const sim = await load();
    const params = game.params ?? [];
    expect(sim.x.sim_param_count()).toBe(params.length);
    params.forEach(([id, label, min, max], i) => {
      expect(id).toBe(i);
      const d = sim.x.sim_param_default(id);
      expect(d, label).toBeGreaterThanOrEqual(min);
      expect(d, label).toBeLessThanOrEqual(max);
    });
  });

  it("runs the engine lifecycle: fixed steps, pause, events cleared per frame", async () => {
    const sim = await load(7);
    let steps = 0;
    for (let f = 0; f < 60; f++) steps += sim.x.sim_advance(1 / 60);
    expect(steps).toBe(120);
    sim.x.sim_set_paused(1);
    expect(sim.x.sim_advance(0.05)).toBe(0);
    sim.x.sim_set_paused(0);
    expect(sim.x.sim_advance(0.05)).toBeGreaterThan(0);
    sim.x.sim_clear_frame();
    expect(sim.count("events")).toBe(0);
    sim.x.sim_reset();
    expect(sim.count("events")).toBe(0);
  });
});
