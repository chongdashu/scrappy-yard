// One frame layout for WGSL and GLSL; keeps camera, lighting and grading identical.
import { mat4, type Vec3 } from "../math";
import { MAX_LIGHTS, DEFAULT_STYLE, type Renderer, type FrameData, type CameraLike } from "./renderer";
/** Floats before the local lights (offset of `lights` in common.wgsl `Frame`). */
const LIGHTS_AT = 132;
/** Offset of the look block after the lights: tint, zenith, horizon, bounce, dof, motion (one vec4 each). */
export const LOOK_AT = LIGHTS_AT + MAX_LIGHTS * 8;
export const FRAME_FLOATS = LOOK_AT + 24;
/**
 * A colour (sRGB 0..1) packed into one float for a spare Frame slot: 8 bits a channel, each stored as 255 minus its
 * value, so white packs to 0 and a slot left at zero means "as drawn". Integers below 2^24 are exact in a 32-bit float;
 * the shaders unpack it with integer shifts (`cloudTint()` in common.wgsl and common.glsl). Non-finite channels read as 1.
 */
export function packColor8(c: readonly number[]): number {
  const q = (v: number) => 255 - Math.round((Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1) * 255);
  return q(c[0]) * 65536 + q(c[1]) * 256 + q(c[2]);
}
function sunViewProj(renderer: Renderer, cam: CameraLike, shadowSize: number): Float32Array {
  const v = cam.view;
  const eye = cam.eye;
  const fwd: Vec3 = [-v[2], -v[6], -v[10]];
  let dist = renderer.shadowHalf;
  if (fwd[1] < -0.05) dist = Math.min(eye[1] / -fwd[1], renderer.shadowHalf * 1.5);
  const fx = cam.shadowFocus ? cam.shadowFocus[0] : eye[0] + fwd[0] * dist;
  const fz = cam.shadowFocus ? cam.shadowFocus[1] : eye[2] + fwd[2] * dist;
  const s = renderer.sunDir;
  const view = mat4.lookAt([s[0] * 100, s[1] * 100, s[2] * 100], [0, 0, 0], [0, 1, 0]);
  const half = renderer.shadowHalf;
  const texel = (2 * half) / shadowSize;
  const lx = Math.round((view[0] * fx + view[8] * fz) / texel) * texel;
  const ly = Math.round((view[1] * fx + view[9] * fz) / texel) * texel;
  const proj = mat4.ortho(lx - half, lx + half, ly - half, ly + half, 40, 170);
  return mat4.mul(proj, view);
}
export function writeFrame(renderer: Renderer, f: FrameData, w: number, h: number, shadowSize: number, u: Float32Array) {
  const cam = f.camera;
  const s = { ...DEFAULT_STYLE, ...f.style };
  const shadowsOn = s.shadow > 0;
  // Frame uniforms (layout: common.wgsl `Frame`).
  const v = cam.view;
  const sunVP = sunViewProj(renderer, cam, shadowSize);
  // tan(fovY / 2) from the projection (viewProj · view⁻¹), for screen-constant ink.
  const proj = mat4.mul(cam.viewProj, mat4.invert(cam.view));
  u.set(cam.viewProj, 0);
  u.set(cam.view, 16);
  u.set(mat4.invert(cam.viewProj), 32);
  u.set(sunVP, 48);
  u.set([cam.eye[0], cam.eye[1], cam.eye[2], f.time], 64);
  u.set([renderer.sunDir[0], renderer.sunDir[1], renderer.sunDir[2], 1.05], 68);
  u.set([v[0], v[4], v[8], f.dt], 72);
  u.set([v[1], v[5], v[9], w / h], 76);
  u.set([w, h, 1 / w, 1 / h], 80);
  u.set([s.toon, s.toonSoft, s.saturation, s.bloom], 84);
  u.set([s.exposure, s.vignette, s.rim, s.inkPx], 88);
  // ink.z and misc.w were spare: the clouds' transparency (so 0 is "as drawn") and their packed tint.
  u.set([1 / Math.max(1e-4, proj[5]), s.bloomThreshold, 1 - Math.min(1, Math.max(0, s.cloudOpacity)), s.grid], 92);
  u.set([s.shadow, s.shadowSoft, 1 / shadowSize, s.blobShadow], 96);
  u.set([s.keyLight, s.ambient, s.shadowLift, s.groundAO], 100);
  u.set([s.contrast, s.rolloff, s.splitTone, s.haze], 104);
  const nLights = Math.min(renderer.lights.length, MAX_LIGHTS);
  u.set([s.warmth, shadowsOn ? 1 : 0, nLights, packColor8(s.cloudTint)], 108);
  u.set([renderer.ground.color[0], renderer.ground.color[1], renderer.ground.color[2], renderer.ground.y], 112);
  const amb = renderer.ambient;
  u.set(amb ? [amb.sky[0], amb.sky[1], amb.sky[2], 1] : [0, 0, 0, 0], 116);
  u.set(amb ? [amb.ground[0], amb.ground[1], amb.ground[2], 0] : [0, 0, 0, 0], 120);
  const ao = renderer.roomAO;
  u.set(ao ? [ao.min[0], ao.min[1], ao.min[2], ao.strength] : [0, 0, 0, 0], 124);
  u.set(ao ? [ao.max[0], ao.max[1], ao.max[2], Math.max(0.05, ao.reach)] : [0, 0, 0, 1], 128);
  for (let i = 0; i < MAX_LIGHTS; i++) {
    const l = renderer.lights[i];
    u.set(l ? [l.at[0], l.at[1], l.at[2], Math.max(0.01, l.radius)] : [0, 0, 0, 0], LIGHTS_AT + i * 8);
    u.set(l ? [l.color[0] * l.intensity, l.color[1] * l.intensity, l.color[2] * l.intensity, 0] : [0, 0, 0, 0], LIGHTS_AT + 4 + i * 8);
  }
  // Look block (sRGB colours; the shaders linearise them). Distances are kept ordered so smoothsteps stay defined.
  const hazeStart = Math.max(0, s.hazeStart);
  const nearF = Math.max(0.01, s.dofNear);
  u.set([...s.shadowTint, Math.max(0, s.bumpHeight)], LOOK_AT);
  u.set([...s.skyZenith, hazeStart], LOOK_AT + 4);
  u.set([...s.skyHorizon, Math.max(hazeStart + 0.01, s.hazeEnd)], LOOK_AT + 8);
  u.set([...s.groundBounce, Math.max(0, s.groundBounceStrength)], LOOK_AT + 12);
  u.set([Math.max(0, s.dof), nearF, Math.max(nearF, s.dofFar), Math.max(0.01, s.groundBounceReach)], LOOK_AT + 16);
  u.set([Math.max(0, s.foliageSway), Math.max(0, s.foliageFreq), Math.max(0, s.liquidWave), s.liquidSpeed], LOOK_AT + 20);
  return s;
}
export function shadowFrame(frame: Float32Array, output: Float32Array) {
  output.set(frame); output.set(frame.subarray(48, 64), 0);
  output[109] = 0; output[91] = 0;
}
