import type { Renderer } from "./renderer";

export type RendererPreference = "auto" | "webgpu" | "webgl2";
export class StartupFailure extends Error {
  constructor(readonly stage: string, message: string) { super(message); }
}
export class GraphicsUnavailable extends Error {}

/** Bound startup waits; dispose a device that arrives after we have fallen back. */
export async function withTimeout<T>(promise: Promise<T>, stage: string, late?: (value: T) => void, ms = 10000): Promise<T> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise.then((value) => { if (expired) late?.(value); return value; }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new StartupFailure(`${stage}-timeout`, `Graphics ${stage} timed out.`)); }, ms); }),
    ]);
  } finally { clearTimeout(timer!); }
}

type Factories = Record<"webgpu" | "webgl2", (canvas: HTMLCanvasElement) => Promise<Renderer>>;

export async function selectRenderer(canvas: HTMLCanvasElement, preference: string | null, factories: Factories): Promise<Renderer> {
  const mode = preference === "webgpu" || preference === "webgl2" ? preference : "auto";
  let failure: string | null = null;
  if (mode !== "webgl2") {
    try { return await factories.webgpu(canvas); }
    catch (e) {
      if (mode === "webgpu") throw new GraphicsUnavailable(`WebGPU could not start: ${String(e)}`);
      failure = e instanceof StartupFailure ? e.stage : "initialization";
      // A canvas cannot change context types, even after WebGPU is unconfigured.
      // Boot precedes input binding; callers must use the returned renderer.canvas.
      const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
      canvas.replaceWith(fresh);
      canvas = fresh;
    }
  }
  try {
    const renderer = await factories.webgl2(canvas);
    renderer.fallbackReason = failure;
    return renderer;
  } catch (e) {
    throw new GraphicsUnavailable(`WebGL 2 could not start${failure ? ` (WebGPU: ${failure})` : ""}: ${String(e)}`);
  }
}
