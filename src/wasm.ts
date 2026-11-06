// Loads sim.wasm (plain C ABI, no bindgen, no imports) and exposes typed views of its output
// buffers. The engine's exports come from `export_engine_abi!` (crates/engine/src/abi.rs);
// each game adds its own and mirrors its layout in its sim-abi.ts (a `SimLayout`).

/** Must equal `vgd_engine::ENGINE_ABI_VERSION` (exported as `sim_engine_version()`). */
export const ENGINE_ABI_VERSION = 1;
/** Floats per event record, `[kind, a, b, c, d, e]` (`vgd_engine::events::EVENT_FLOATS`). */
export const EVENT_FLOATS = 6;

/** A game's ABI mirror: its `sim_abi_version()` and the stride of every output buffer it reads. */
export interface SimLayout {
  version: number;
  /** Buffer name → floats per record (`buf_<name>_stride()`). The engine adds `events`. */
  strides: Record<string, number>;
}

/**
 * The engine's exports. A game types its own on top: `interface MyExports extends SimExports
 * { sim_set_input(x: number, z: number): void }`, then `rt.sim.x as MyExports`.
 */
export interface SimExports {
  memory: WebAssembly.Memory;
  sim_engine_version(): number;
  sim_abi_version(): number;
  sim_init(seed: number): void;
  sim_reset(): void;
  sim_advance(dt: number): number;
  sim_set_paused(on: number): void;
  sim_clear_frame(): void;
  sim_round_start(): void;
  sim_param_count(): number;
  sim_param_get(id: number): number;
  sim_param_set(id: number, v: number): void;
  sim_param_default(id: number): number;
  [k: string]: unknown;
}

export class AbiMismatch extends Error {}

export class Sim<X extends SimExports = SimExports> {
  readonly x: X;
  /** Every buffer this page reads: the game's strides plus the engine's `events`. */
  readonly strides: Record<string, number>;

  constructor(instance: WebAssembly.Instance, readonly layout: SimLayout) {
    this.x = instance.exports as unknown as X;
    this.strides = { ...layout.strides, events: EVENT_FLOATS };
  }

  /** Fetch + instantiate. `url` should be resolved against document.baseURI (nested hosting). */
  static async load(url: string, layout: SimLayout): Promise<Sim> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`sim.wasm: HTTP ${res.status} for ${url}`);
    // Some dev servers answer a missing file with index.html.
    if ((res.headers.get("content-type") ?? "").includes("text/html")) throw new Error(`sim.wasm: not found (${url} returned HTML); run npm run wasm`);
    const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
    return new Sim(instance, layout);
  }

  /**
   * Refuse a module built from different Rust sources than this page expects (engine or game).
   * Throws AbiMismatch naming what differs.
   */
  verifyAbi(): void {
    const fn = (name: string) => this.x[name] as (() => number) | undefined;
    const engine = fn("sim_engine_version")?.();
    if (engine !== ENGINE_ABI_VERSION) {
      throw new AbiMismatch(`sim.wasm was built against engine ABI v${engine ?? "?"}, this page expects v${ENGINE_ABI_VERSION}.`);
    }
    const version = fn("sim_abi_version")?.();
    if (version !== this.layout.version) {
      throw new AbiMismatch(`sim.wasm reports game ABI v${version ?? "?"}, this page expects v${this.layout.version}.`);
    }
    for (const [name, stride] of Object.entries(this.strides)) {
      const got = fn(`buf_${name}_stride`)?.();
      if (got !== stride) throw new AbiMismatch(`buffer "${name}" has ${got ?? "no"} floats per record in sim.wasm, ${stride} in the page's ABI mirror.`);
    }
  }

  private stride(name: string): number {
    const s = this.strides[name];
    if (s === undefined) throw new Error(`No buffer "${name}" in this game's ABI mirror (sim-abi.ts strides).`);
    return s;
  }

  /**
   * A view of an output buffer. Always built from the current memory buffer:
   * memory growth detaches old views, so never cache the result across calls
   * into the sim.
   */
  f32(name: string): Float32Array {
    const stride = this.stride(name);
    const ptr = (this.x[`buf_${name}`] as () => number)();
    const count = (this.x[`buf_${name}_count`] as () => number)();
    return new Float32Array(this.x.memory.buffer, ptr, count * stride);
  }

  count(name: string): number {
    this.stride(name);
    return (this.x[`buf_${name}_count`] as () => number)();
  }

  /** A copy of a buffer as plain numbers (test hooks, logs). */
  read(name: string): number[] {
    return Array.from(this.f32(name));
  }
}
