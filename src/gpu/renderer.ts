// Shared rendering contract. Backend modules are loaded only when selected.
import type { InstanceBatch } from "./meshes";
import type { Vec3 } from "../math";
import type { ModelDriver } from "./model";
import { selectRenderer, type RendererPreference } from "./selection";
export { GraphicsUnavailable } from "./selection";

/** What the renderer needs from a camera (the game camera, or a preview orbit camera). */
export interface CameraLike {
  viewProj: Float32Array;
  view: Float32Array;
  eye: [number, number, number];
  /** Ground point (x, z) the sun shadow map centres on. */
  shadowFocus?: [number, number] | null;
}

/** Backend-neutral draws; model drivers bind to the current render pass internally. */
export type SceneHook = () => void;
export type ShadowHook = () => void;
/** Translucent draws, after the opaque scene and the sky (depth test on, depth write off); `eye` is for back-to-front sorting. */
export type TranslucentHook = (eye: readonly [number, number, number]) => void;

/** An sRGB-encoded colour, 0..1 per channel (the same numbers a colour picker shows). */
export type StyleColor = [number, number, number];

/**
 * The look: every value is live-tunable (the DEV tuning panel builds sliders from STYLE_RANGES and
 * colour pickers from STYLE_COLORS). Defaults reproduce the template's look; the effects added in
 * v2.2 (depth of field, foliage sway, liquid waves, near-ground bounce) default to off.
 */
export interface Style {
  /** Diffuse ramp: 0 smooth wrapped Lambert … 1 banded toon. */
  toon: number;
  /** Width of the toon band edges. */
  toonSoft: number;
  /** Ink outline width in pixels at 720p (screen-constant); 0 turns outlines off. */
  inkPx: number;
  rim: number;
  saturation: number;
  bloom: number;
  /** HDR level where bloom starts (diffuse surfaces stay below it). */
  bloomThreshold: number;
  exposure: number;
  vignette: number;
  /** Sun cast shadows 0..1 (0 skips the shadow pass). */
  shadow: number;
  /** PCF filter radius in shadow texels. */
  shadowSoft: number;
  /** Blob contact shadows under actors. */
  blobShadow: number;
  keyLight: number;
  ambient: number;
  /** 0 = deep cast shadows, 1 = shadows as light as the ramp's dark band. */
  shadowLift: number;
  /** Darkening where things meet the ground. */
  groundAO: number;
  /** Warm key (1) or neutral key (0). */
  warmth: number;
  /** Display-space contrast (1 = none). */
  contrast: number;
  /** Highlights: 0 per-channel filmic (bright creams bleach), 1 hue-preserving roll-off. */
  rolloff: number;
  splitTone: number;
  /** Distance haze toward the horizon. */
  haze: number;
  /** Metre grid on the ground plane (a blockout aid). */
  grid: number;
  /** Cool fill added where sun shadows fall (sRGB). */
  shadowTint: StyleColor;
  /** Sky straight up (sRGB): the top of the procedural sky gradient. */
  skyZenith: StyleColor;
  /** Sky at the horizon and the distance-haze colour (sRGB); the band just below the horizon follows it. */
  skyHorizon: StyleColor;
  /** Multiplies the procedural sky's clouds (sRGB; white leaves them as drawn, a dark blue makes night clouds). */
  cloudTint: StyleColor;
  /** How much the clouds cover the sky: 1 as drawn, 0 none (the sky then skips them). */
  cloudOpacity: number;
  /** Metres from the eye where distance haze starts, and where it is full. */
  hazeStart: number;
  hazeEnd: number;
  /** Light bounced up from the ground (sRGB): the daylight ambient from below. */
  groundBounce: StyleColor;
  /** Extra bounce of that colour on down- and side-facing surfaces near the ground (0 = none). */
  groundBounceStrength: number;
  /** Metres above the ground plane over which that extra bounce fades out. */
  groundBounceReach: number;
  /** Depth of field: 0 off, 1 = full blur (about 8 px at 720p) outside the focus range. */
  dof: number;
  /** Focus range in metres from the eye: sharp between near and far; blur grows below near (full at 0.4 × near) and beyond far (full at 2 × far). */
  dofNear: number;
  dofFar: number;
  /** Wind sway of "foliage" materials: metres at full height (1.5 m above the object's origin); 0 off. */
  foliageSway: number;
  /** Sway cycles per second. */
  foliageFreq: number;
  /** Wave height of "liquid" materials in metres (up-facing surfaces only); 0 off. */
  liquidWave: number;
  /** Wave speed multiplier (1 ≈ 0.5 m/s crests). */
  liquidSpeed: number;
  /** Relief of "bump" materials: metres between their darkest and brightest base colour (shading only); 0 off. */
  bumpHeight: number;
}

export const DEFAULT_STYLE: Style = {
  toon: 0.55,
  toonSoft: 0.08,
  inkPx: 1.3,
  rim: 0.8,
  saturation: 1.06,
  bloom: 0.55,
  bloomThreshold: 1.2,
  exposure: 1.0,
  vignette: 0.6,
  shadow: 1,
  shadowSoft: 1.1,
  blobShadow: 0.6,
  keyLight: 0.95,
  ambient: 0.48,
  shadowLift: 0.5,
  groundAO: 0.16,
  warmth: 0.4,
  contrast: 1.05,
  rolloff: 0.6,
  splitTone: 0.4,
  haze: 1,
  grid: 0.35,
  shadowTint: [0.36, 0.44, 0.7],
  skyZenith: [0.34, 0.6, 0.92],
  skyHorizon: [0.8, 0.88, 0.96],
  cloudTint: [1, 1, 1],
  cloudOpacity: 1,
  hazeStart: 40,
  hazeEnd: 150,
  groundBounce: [0.58, 0.54, 0.46],
  groundBounceStrength: 0,
  groundBounceReach: 2.5,
  dof: 0,
  dofNear: 1.5,
  dofFar: 30,
  foliageSway: 0,
  foliageFreq: 0.35,
  liquidWave: 0,
  liquidSpeed: 1,
  bumpHeight: 0.12,
};

/** Style keys that hold a number (the sliders). */
export type StyleNumberKey = { [K in keyof Style]: Style[K] extends number ? K : never }[keyof Style];
/** Style keys that hold a colour (the colour pickers). */
export type StyleColorKey = { [K in keyof Style]: Style[K] extends StyleColor ? K : never }[keyof Style];

/** [key, label, min, max, step] for tuning UIs. */
export const STYLE_RANGES: [StyleNumberKey, string, number, number, number][] = [
  ["toon", "Toon ramp (0 smooth)", 0, 1, 0.05],
  ["toonSoft", "Toon softness", 0.005, 0.4, 0.005],
  ["inkPx", "Ink outline (px @720p)", 0, 4, 0.05],
  ["rim", "Rim light", 0, 3, 0.05],
  ["saturation", "Saturation", 0.5, 1.8, 0.01],
  ["bloom", "Bloom", 0, 2, 0.02],
  ["bloomThreshold", "Bloom threshold", 0.6, 2.5, 0.05],
  ["exposure", "Exposure", 0.5, 2, 0.01],
  ["vignette", "Vignette", 0, 1.5, 0.05],
  ["shadow", "Sun shadows", 0, 1, 0.05],
  ["shadowSoft", "Shadow softness (texels)", 0.3, 3, 0.1],
  ["shadowLift", "Shadow lift", 0, 1, 0.05],
  ["blobShadow", "Contact shadows", 0, 1.5, 0.05],
  ["keyLight", "Key light", 0.4, 1.6, 0.02],
  ["ambient", "Sky ambient", 0.1, 1, 0.02],
  ["warmth", "Key warmth", 0, 1, 0.05],
  ["groundAO", "Ground contact AO", 0, 0.5, 0.01],
  ["rolloff", "Highlight roll-off", 0, 1, 0.05],
  ["contrast", "Contrast", 0.8, 1.4, 0.01],
  ["splitTone", "Split tone", 0, 1.5, 0.05],
  ["haze", "Distance haze", 0, 1.5, 0.05],
  ["hazeStart", "Haze start (m)", 0, 200, 1],
  ["hazeEnd", "Haze full (m)", 1, 400, 1],
  ["cloudOpacity", "Cloud opacity", 0, 1, 0.01],
  ["groundBounceStrength", "Near-ground bounce", 0, 1, 0.02],
  ["groundBounceReach", "Bounce reach (m)", 0.2, 8, 0.1],
  ["dof", "Depth of field (0 off)", 0, 1, 0.02],
  ["dofNear", "Focus near (m)", 0.1, 20, 0.1],
  ["dofFar", "Focus far (m)", 1, 200, 0.5],
  ["foliageSway", "Foliage sway (m)", 0, 0.3, 0.005],
  ["foliageFreq", "Foliage sway (Hz)", 0.05, 2, 0.05],
  ["liquidWave", "Liquid waves (m)", 0, 0.2, 0.002],
  ["liquidSpeed", "Liquid wave speed", 0, 4, 0.05],
  ["bumpHeight", "Bump relief (m)", 0, 0.5, 0.005],
  ["grid", "Ground grid", 0, 1, 0.05],
];

/** [key, label] for colour pickers. */
export const STYLE_COLORS: [StyleColorKey, string][] = [
  ["shadowTint", "Shadow tint"],
  ["skyZenith", "Sky zenith"],
  ["skyHorizon", "Sky horizon / haze"],
  ["cloudTint", "Cloud tint"],
  ["groundBounce", "Ground bounce"],
];

/** A local light: a warm bulb, a neon sign, a screen. Not shadow-casting; fades smoothly to nothing at `radius`. */
export interface PointLight {
  /** World position (m). */
  at: Vec3;
  /** Linear RGB. */
  color: Vec3;
  /** Metres the light reaches. */
  radius: number;
  /** Multiplies the colour (1 = a light that adds about as much as the key light does close up). */
  intensity: number;
}

export interface FrameData {
  camera: CameraLike;
  /** Presentation clock (s): drives cloud drift and shader animation. */
  time: number;
  /** Presentation dt (0 while paused). */
  dt: number;
  style: Style;
  /** One batch per procedural mesh (MESH ids in meshes.ts). */
  batches: InstanceBatch[];
  /** PARTICLE_FLOATS per particle (see ParticleSystem). */
  particles: Float32Array;
  particleCount: number;
  /** Blob shadows: x, z, radius, opacity per entry. */
  blobs: Float32Array;
  blobCount: number;
}

/** Floats per particle instance: x y z size | kind life01 rot alpha | r g b emissive. */
export const PARTICLE_FLOATS = 12;

/** Local lights a scene may set (`Renderer.lights`). */
export const MAX_LIGHTS = 8;

export abstract class Renderer {
  abstract readonly backend: "webgpu" | "webgl2";
  abstract readonly capabilities: { hdr: boolean; bloom: boolean };
  fallbackReason: string | null = null;
  onLost: ((reason: string) => void) | null = null;
  onError: ((error: { message: string }) => void) | null = null;
  sceneHooks: SceneHook[] = [];
  shadowHooks: ShadowHook[] = [];
  /** Run after the opaque scene, blob shadows and sky, before particles (`ModelRenderer` registers its BLEND materials here). */
  translucentHooks: TranslucentHook[] = [];
  /** Direction toward the sun (normalised). */
  sunDir: Vec3 = normalize([-0.55, 0.72, 0.42]);
  /** Local lights for the scene (at most MAX_LIGHTS are used); none by default. */
  lights: PointLight[] = [];
  /** Ambient fill colours (linear RGB) from above and from below, instead of the daylight sky and ground bounce; null for the daylight ones. */
  ambient: { sky: Vec3; ground: Vec3 } | null = null;
  /**
   * Room occlusion for an indoor scene: surfaces darken toward the faces of this axis-aligned box, and much more in its corners and along its edges,
   * over `reach` metres. `strength` 0..1; null for none.
   */
  roomAO: { min: Vec3; max: Vec3; strength: number; reach: number } | null = null;
  /** Half-size (m) of the sun shadow footprint around the camera's ground focus. */
  shadowHalf = 14;
  /** Ground plane: linear colour and height (a little below y = 0 so level floors win). */
  ground = { color: [0.3, 0.36, 0.3] as Vec3, y: -0.02, visible: true };
  /** Draw the procedural sky behind everything (tools with their own backdrop turn it off). */
  skyVisible = true;
  /** What the scene pass clears to (linear RGB): shows wherever nothing is drawn and the sky is off. */
  background: Vec3 = [0.5, 0.6, 0.7];
  /** Canvas pixel budget (device pixels); phones with 3× screens stay fast. */
  maxPixels = 2_600_000;
  /** Largest devicePixelRatio used. */
  maxDpr = 2;


  constructor(readonly canvas: HTMLCanvasElement) {}
  abstract get pixelSize(): [number, number];
  abstract render(canvas: HTMLCanvasElement, frame: FrameData): void;
  abstract createModelDriver(): ModelDriver;
  abstract finished(): Promise<void>;
  abstract dispose(): void;

  info() {
    return { backend: this.backend, fallbackReason: this.fallbackReason, ...this.capabilities };
  }

  static async create(canvas: HTMLCanvasElement, preference?: RendererPreference): Promise<Renderer> {
    return selectRenderer(canvas, preference ?? new URLSearchParams(location.search).get("renderer"), {
      webgpu: async (c) => (await import("./webgpu-renderer")).WebGPURenderer.create(c),
      webgl2: async (c) => (await import("./webgl/renderer")).WebGLRenderer.create(c),
    });
  }
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
