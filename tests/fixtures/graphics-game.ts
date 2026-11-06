// Browser-only rendering fixture for `npm run test:graphics` (materials scenario). Uses the active
// game's ABI and sim, but draws its own scene from an in-memory GLB that goes through the real loader:
// an opaque subject, two overlapping BLEND cards (blue in front of green), a MASK card that is
// transparent on its left half, a striped far wall (depth-of-field target), a liquid pool, a
// foliage post and a "bump" card (relief from a smooth grey pattern). A fixed first-person eye keeps
// every capture comparable. Never shipped.
// `?fixture=textures` draws the texture scene instead (textureScene below): glTF samplers and shared uploads.
import base from '@fixture-base-game';
import type { GameModule, Game } from '../../src/game';
import { ModelRenderer, type GpuModel, type GpuResourceCounts } from '../../src/gpu/model';
import { parseGlb } from '../../src/gltf/glb';
import { buildGlb, box, quad, type GlbMesh } from './glb';

/** Where things are (the harness projects these to find its probe pixels). */
export const PROBES = {
  subject: [0, 0.6, 0],
  blendOverlap: [0.35, 0.95, 1.4],
  blueOverWall: [0.6, 1.62, 1.6],
  maskCut: [-1.85, 0.9, 1.0],
  maskSolid: [-1.15, 0.9, 1.0],
  wall: [0, 3, -40],
  relief: [2.3, 1.55, 1.0],
} as const;

/**
 * The texture scene (`?fixture=textures`). Near cards: one 4 × 1 image of dark and light texels, magnified about 75×,
 * sampled NEAREST on the left and LINEAR on the right (rows from u 0.1 to 0.9). Far cards: a 64 × 64 one-texel checker
 * drawn about 2.7 texels per pixel, minified NEAREST without mipmaps on the left (as Retro Diffusion exports) and
 * NEAREST_MIPMAP_NEAREST on the right (as Blender exports "Closest"); squares at their centres.
 */
export const TEXTURE_PROBES = {
  nearest: [[-1.0, 1.45, 3], [-0.2, 1.45, 3]],
  linear: [[0.2, 1.45, 3], [1.0, 1.45, 3]],
  noMip: [[-1.0, 4, -20]],
  mip: [[1.0, 4, -20]],
} as const;

/** Live model-driver resources at each step of the texture scene's upload/instance/retexture/release sequence. */
export type TextureReport = Record<'before' | 'uploaded' | 'second' | 'instanced' | 'retextured' | 'restored' | 'instanceReleased' | 'firstReleased', GpuResourceCounts>;

async function png(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number]): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set(paint(x, y), (y * w + x) * 4);
  ctx.putImageData(img, 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

function plane(w: number, d: number, material: number): GlbMesh {
  const x = w / 2, z = d / 2;
  return {
    positions: [-x, 0, z, x, 0, z, x, 0, -z, -x, 0, -z],
    normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    uvs: [0, 1, 1, 1, 1, 0, 0, 0],
    indices: [0, 1, 2, 0, 2, 3],
    material,
  };
}

/**
 * Uploads the texture scene twice (two sources sharing every image), instances and retextures the second, then
 * releases the instance and the first source, recording live resources after each step. Returns the second source,
 * which the scene draws: had releasing the first freed a shared texture, it would draw wrong or raise GPU errors.
 */
async function textureScene(models: ModelRenderer): Promise<{ scene: GpuModel; report: TextureReport }> {
  const stripes = await png(4, 1, (x) => (x % 2 ? [150, 150, 150, 255] : [30, 30, 30, 255]));
  const checker = await png(64, 64, (x, y) => ((x + y) % 2 ? [220, 220, 220, 255] : [20, 20, 20, 255]));
  const clamp = { wrapS: 33071, wrapT: 33071 };
  const card = (name: string, texture: number) => ({ name, pbrMetallicRoughness: { baseColorTexture: { index: texture }, roughnessFactor: 1 } });
  const doc = await parseGlb(buildGlb({
    images: [stripes, checker],
    samplers: [{ magFilter: 9728, minFilter: 9728, ...clamp }, { magFilter: 9729, minFilter: 9987, ...clamp }, { magFilter: 9728, minFilter: 9984, ...clamp }],
    textures: [{ source: 0, sampler: 0 }, { source: 0, sampler: 1 }, { source: 1, sampler: 0 }, { source: 1, sampler: 2 }],
    materials: [card('mat_near_nearest', 0), card('mat_near_linear', 1), card('mat_far_nomip', 2), card('mat_far_mip', 3)],
    meshes: [quad(1, 0.6, 0), quad(1, 0.6, 1), quad(0.6, 0.6, 2), quad(0.6, 0.6, 3)],
    nodes: [
      { name: 'near_nearest', mesh: 0, translation: [-0.6, 1.45, 3] },
      { name: 'near_linear', mesh: 1, translation: [0.6, 1.45, 3] },
      { name: 'far_nomip', mesh: 2, translation: [-1, 4, -20] },
      { name: 'far_mip', mesh: 3, translation: [1, 4, -20] },
    ],
  }), 'textures-fixture.glb');
  const at = () => ({ ...models.resources()! });
  const before = at();
  const first = models.upload(doc);
  const uploaded = at();
  const scene = models.upload(doc);
  const second = at();
  const copy = models.instance(scene);
  const instanced = at();
  const patch = new OffscreenCanvas(4, 1);
  patch.getContext('2d')!.fillRect(0, 0, 4, 1);
  models.retexture(copy, 0, patch);
  const retextured = at();
  models.retexture(copy, 0, patch);
  models.retexture(copy, 0, null);
  const restored = at();
  models.release([copy]);
  const instanceReleased = at();
  models.release([first]);
  const firstReleased = at();
  return { scene, report: { before, uploaded, second, instanced, retextured, restored, instanceReleased, firstReleased } };
}

const fixture: GameModule = {
  ...base,
  camera: 'first-person',
  look: false,
  // Liquid waves and foliage sway on, so the captures show them (they do not move the probe points).
  style: { ...base.style, liquidWave: 0.03, liquidSpeed: 1, foliageSway: 0.06, foliageFreq: 0.5 },
  create() {
    const game: Game = base.create();
    const load = game.load.bind(game), start = game.startRound.bind(game), stats = game.stats.bind(game);
    let models: ModelRenderer | null = null, scene: GpuModel | null = null, began = false;
    game.load = async (rt, progress) => {
      await load(rt, progress);
      models = new ModelRenderer(rt.renderer);
      rt.renderer.sceneHooks.push(() => models!.draw());
      if (new URLSearchParams(location.search).get('fixture') === 'textures') {
        const textures = await textureScene(models);
        scene = textures.scene;
        // The harness reads the report, then releases the scene and expects every count back at `before`.
        (window as unknown as { __textures: unknown }).__textures = {
          report: textures.report,
          release: () => { models!.release([scene!]); scene = null; return models!.resources(); },
        };
        (window as unknown as { __probes: typeof TEXTURE_PROBES }).__probes = TEXTURE_PROBES;
        return;
      }
      // 16 px: left half fully transparent. 64 × 4 px: black and white stripes.
      const cutout = await png(16, 16, (x) => (x < 8 ? [255, 255, 255, 0] : [255, 255, 255, 255]));
      const stripes = await png(64, 4, (x) => (x % 2 ? [240, 240, 240, 255] : [20, 20, 20, 255]));
      // Smooth grey bumps, four across: a height field with slopes in every direction.
      const bumps = await png(64, 64, (x, y) => {
        const v = Math.round(255 * (0.5 + 0.4 * Math.sin((2 * Math.PI * x) / 16) * Math.sin((2 * Math.PI * y) / 16)));
        return [v, v, v, 255];
      });
      const doc = await parseGlb(buildGlb({
        images: [cutout, stripes, bumps],
        materials: [
          { name: 'mat_subject', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.08, 0.05, 1], roughnessFactor: 0.7 } },
          { name: 'mat_glass_blue', alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [0.05, 0.12, 1, 0.55], roughnessFactor: 0.9 } },
          { name: 'mat_glass_green', alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [0.06, 1, 0.1, 0.55], roughnessFactor: 0.9 } },
          { name: 'mat_cutout', alphaMode: 'MASK', alphaCutoff: 0.5, pbrMetallicRoughness: { baseColorFactor: [1, 0.85, 0.1, 1], baseColorTexture: { index: 0 }, roughnessFactor: 0.9 } },
          { name: 'mat_stripes', pbrMetallicRoughness: { baseColorTexture: { index: 1 }, roughnessFactor: 1 } },
          { name: 'mat_water', alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.35, 0.55, 0.6], roughnessFactor: 0.05 }, extras: { vgd_kind: 'liquid' } },
          { name: 'mat_leaves', pbrMetallicRoughness: { baseColorFactor: [0.2, 0.55, 0.15, 1], roughnessFactor: 0.9 }, extras: { vgd: { kind: 'foliage' } } },
          { name: 'mat_relief', pbrMetallicRoughness: { baseColorTexture: { index: 2 }, roughnessFactor: 1 }, extras: { vgd_kind: 'bump' } },
        ],
        meshes: [box(1.2, 1.2, 1.2, 0), quad(1.2, 1.2, 1), quad(1.2, 1.2, 2), quad(1.2, 1.2, 3), quad(24, 8, 4), plane(3, 2, 5), box(0.3, 2.2, 0.3, 6), quad(1.2, 0.9, 7)],
        nodes: [
          { name: 'subject', mesh: 0, translation: [0, 0.6, 0] },
          { name: 'glass_blue', mesh: 1, translation: [0.5, 1.1, 1.6] },
          { name: 'glass_green', mesh: 2, translation: [0.1, 0.8, 1.2] },
          { name: 'cutout', mesh: 3, translation: [-1.5, 0.9, 1.0] },
          { name: 'wall', mesh: 4, translation: [0, 4, -40] },
          { name: 'pool', mesh: 5, translation: [2.4, 0.05, 0.5] },
          { name: 'shrub', mesh: 6, translation: [-3, 1.1, -1] },
          { name: 'relief', mesh: 7, translation: [2.3, 1.55, 1.0] },
        ],
      }), 'materials-fixture.glb');
      scene = models.upload(doc);
      (window as unknown as { __probes: typeof PROBES }).__probes = PROBES;
    };
    game.startRound = () => { began = true; start(); };
    // The scene, not the round, is under test: the round never ends.
    game.round = () => (began ? 'playing' : 'ready');
    game.eye = () => ({ x: 0, y: 1.7, z: 6.5, yaw: Math.PI, pitch: -0.08 });
    game.draw = () => { if (models && scene) models.prepareStatic(scene); };
    game.stats = () => ({ ...stats(), modelDraws: models?.stats.draws ?? 0, translucentDraws: models?.stats.translucent ?? 0 });
    return game;
  },
};
export default fixture;
