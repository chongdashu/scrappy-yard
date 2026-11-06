import { afterEach, describe, expect, it, vi } from "vitest";
import { selectRenderer, StartupFailure, withTimeout } from "../src/gpu/selection";
import type { Renderer } from "../src/gpu/renderer";

function canvas() {
  const replacement = { replaceWith: vi.fn() };
  return { cloneNode: vi.fn(() => replacement), replaceWith: vi.fn() } as unknown as HTMLCanvasElement;
}
const result = (backend: string, c: HTMLCanvasElement) => ({ backend, canvas: c, fallbackReason: null }) as unknown as Renderer;
afterEach(() => vi.useRealTimers());

describe("renderer selection", () => {
  it("prefers WebGPU and does not create an unused WebGL context", async () => {
    const c = canvas(), webgpu = vi.fn(async () => result("webgpu", c)), webgl2 = vi.fn();
    expect((await selectRenderer(c, "auto", { webgpu, webgl2 })).backend).toBe("webgpu");
    expect(webgl2).not.toHaveBeenCalled(); expect(c.cloneNode).not.toHaveBeenCalled();
  });
  it.each(["api-unavailable", "adapter-unavailable", "device", "initialization"])("recovers %s on a fresh canvas and keeps the failure stage", async (stage) => {
    const c = canvas(), webgpu = vi.fn(async () => { throw new StartupFailure(stage, "failure"); });
    const webgl2 = vi.fn(async (c: HTMLCanvasElement) => result("webgl2", c));
    const r = await selectRenderer(c, "auto", { webgpu, webgl2 });
    expect(r.backend).toBe("webgl2"); expect(r.fallbackReason).toBe(stage);
    expect(r.canvas).not.toBe(c); expect(c.replaceWith).toHaveBeenCalledWith(r.canvas);
    expect(webgl2).toHaveBeenCalledTimes(1);
  });
  it("forced WebGL works without touching the WebGPU API", async () => {
    const c = canvas(), webgpu = vi.fn(), webgl2 = vi.fn(async () => result("webgl2", c));
    const r = await selectRenderer(c, "webgl2", { webgpu, webgl2 });
    expect(r.canvas).toBe(c); expect(r.fallbackReason).toBeNull(); expect(webgpu).not.toHaveBeenCalled();
  });
  it("forced WebGPU reports its error, so regression tests cannot silently use WebGL", async () => {
    const webgpu = vi.fn(async () => { throw new Error("missing"); }), webgl2 = vi.fn();
    await expect(selectRenderer(canvas(), "webgpu", { webgpu, webgl2 })).rejects.toThrow("WebGPU could not start");
    expect(webgl2).not.toHaveBeenCalled();
  });
  it("fails once with both backend causes when neither backend starts", async () => {
    const webgpu = vi.fn(async () => { throw new StartupFailure("adapter-unavailable", "missing"); });
    const webgl2 = vi.fn(async () => { throw new Error("context refused"); });
    await expect(selectRenderer(canvas(), "auto", { webgpu, webgl2 })).rejects.toThrow(/WebGL 2.*adapter-unavailable.*context refused/);
    expect(webgpu).toHaveBeenCalledTimes(1); expect(webgl2).toHaveBeenCalledTimes(1);
  });
  it("times out stalled startup and destroys a device that arrives after fallback", async () => {
    vi.useFakeTimers();
    let complete!: (value: { destroy: () => void }) => void;
    const destroy = vi.fn();
    const pending = new Promise<{ destroy: () => void }>((resolve) => { complete = resolve; });
    const timeout = withTimeout(pending, "device", (device) => device.destroy(), 100);
    const rejection = expect(timeout).rejects.toMatchObject({ stage: "device-timeout" });
    await vi.advanceTimersByTimeAsync(100); await rejection;
    complete({ destroy }); await Promise.resolve();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
