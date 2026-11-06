import { describe, expect, it } from "vitest";
import { Camera } from "../src/camera";
import { FRAME_FLOATS, LOOK_AT, packColor8, writeFrame } from "../src/gpu/frame";
import { DEFAULT_STYLE, MAX_LIGHTS, type FrameData, type Renderer } from "../src/gpu/renderer";

function fixture(style = DEFAULT_STYLE) {
  const camera = new Camera({}, "first-person");
  camera.setEye({ x: 0, y: 1.65, z: 4, yaw: Math.PI, pitch: 0 });
  camera.update(1 / 60, 0, 0, 16 / 9, [-10, -10, 10, 10]);
  const renderer = {
    sunDir: [-0.5, 0.8, 0.3], shadowHalf: 11, ground: { color: [0.3, 0.3, 0.3], y: -0.02 },
    lights: [], ambient: null, roomAO: null,
  } as unknown as Renderer;
  const frame: FrameData = {
    camera, style, time: 0, dt: 1 / 60, batches: [],
    particles: new Float32Array(), particleCount: 0, blobs: new Float32Array(), blobCount: 0,
  };
  const u = new Float32Array(FRAME_FLOATS);
  const write = () => writeFrame(renderer, frame, 1280, 720, 2048, u);
  return { renderer, camera, u, write };
}

describe("shared indoor frame data", () => {
  it("packs bounded local lights and clears indoor state when changing scenes", () => {
    const { renderer, u, write } = fixture();
    renderer.ambient = { sky: [1, 0.5, 0.25], ground: [0.25, 0.5, 1] };
    renderer.roomAO = { min: [-5, 0, -6], max: [5, 3, 6], strength: 0.5, reach: 2 };
    renderer.lights = Array.from({ length: MAX_LIGHTS + 1 }, () => ({ at: [1, 2, 3], radius: 4, color: [0.5, 1, 0.25], intensity: 2 }));
    write();
    expect(u[110]).toBe(MAX_LIGHTS);
    expect([...u.slice(116, 132)]).toEqual([1, 0.5, 0.25, 1, 0.25, 0.5, 1, 0, -5, 0, -6, 0.5, 5, 3, 6, 2]);
    expect([...u.slice(132, 140)]).toEqual([1, 2, 3, 4, 1, 2, 0.5, 0]);
    renderer.lights = []; renderer.ambient = null; renderer.roomAO = null;
    write();
    expect(u[110]).toBe(0);
    expect([...u.slice(116, 131), ...u.slice(132, LOOK_AT)].every((n) => n === 0)).toBe(true);
  });

  it("keeps the shadow map on the game's explicit focus as the eye moves", () => {
    const { camera, u, write } = fixture();
    camera.shadowFocus = [2, -3];
    write();
    const shadow = u.slice(48, 64);
    camera.eye = [7, 2, 1];
    write();
    expect(u.slice(48, 64)).toEqual(shadow);
    camera.shadowFocus = [-4, 5];
    write();
    expect(u.slice(48, 64)).not.toEqual(shadow);
  });

  it("packs the look block after the lights with the template's constants by default", () => {
    const { u, write } = fixture();
    write();
    expect(FRAME_FLOATS).toBe(LOOK_AT + 24);
    const at = (o: number, n = 4) => [...u.slice(LOOK_AT + o, LOOK_AT + o + n)];
    const f = (v: number[]) => v.map((x) => Math.fround(x));
    expect(at(0)).toEqual(f([0.36, 0.44, 0.7, 0.12])); // w: Style.bumpHeight
    expect(at(4)).toEqual(f([0.34, 0.6, 0.92, 40]));
    expect(at(8)).toEqual(f([0.8, 0.88, 0.96, 150]));
    expect(at(12)).toEqual(f([0.58, 0.54, 0.46, 0]));
    expect(at(16)).toEqual(f([0, 1.5, 30, 2.5]));
    expect(at(20)).toEqual(f([0, 0.35, 0, 1]));
    // The clouds' spare slots stay zero by default: opacity 1 and a white tint, the sky as before.
    expect([u[94], u[111]]).toEqual([0, 0]);
  });

  it("keeps haze and focus ranges ordered whatever the style says", () => {
    const { u, write } = fixture({ ...DEFAULT_STYLE, hazeStart: 80, hazeEnd: 20, dofNear: 0, dofFar: -1, dof: -2 });
    write();
    expect(u[LOOK_AT + 11]).toBeGreaterThan(u[LOOK_AT + 7]);
    expect(u[LOOK_AT + 16]).toBe(0);
    expect(u[LOOK_AT + 17]).toBeGreaterThan(0);
    expect(u[LOOK_AT + 18]).toBeGreaterThanOrEqual(u[LOOK_AT + 17]);
  });

  it("packs the cloud tint and opacity into spare slots: ink.z is 1 − opacity, misc.w the tint", () => {
    const { u, write } = fixture({ ...DEFAULT_STYLE, cloudTint: [0.16, 0.2, 0.31], cloudOpacity: 0.7 });
    write();
    expect(u[94]).toBeCloseTo(0.3, 6);
    expect(u[111]).toBe(packColor8([0.16, 0.2, 0.31]));
    // What cloudTint() in common.wgsl/common.glsl reads back, by integer shifts: each channel within half a step of 1/255.
    const p = u[111];
    const back = [(p >> 16) & 255, (p >> 8) & 255, p & 255].map((v) => 1 - v / 255);
    back.forEach((v, i) => expect(Math.abs(v - [0.16, 0.2, 0.31][i])).toBeLessThanOrEqual(0.5 / 255));
    expect(Number.isInteger(p) && p < 2 ** 24).toBe(true); // exact in a 32-bit float
    expect(packColor8([1, 1, 1])).toBe(0);
    expect(packColor8([0, 0, 0])).toBe(0xffffff);
    expect(packColor8([2, -1, Number.NaN])).toBe(packColor8([1, 0, 1]));
    for (const [opacity, slot] of [[2, 0], [-1, 1]]) {
      const c = fixture({ ...DEFAULT_STYLE, cloudOpacity: opacity });
      c.write();
      expect(c.u[94]).toBe(slot);
    }
  });

  it("packs the bump relief into the shadow tint's spare w, never below 0", () => {
    const { u, write } = fixture({ ...DEFAULT_STYLE, bumpHeight: 0.3 });
    write();
    expect(u[LOOK_AT + 3]).toBe(Math.fround(0.3));
    const off = fixture({ ...DEFAULT_STYLE, bumpHeight: -1 });
    off.write();
    expect(off.u[LOOK_AT + 3]).toBe(0);
  });
});
