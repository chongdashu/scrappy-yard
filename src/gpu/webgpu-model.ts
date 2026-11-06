// WebGPU implementation of the shared model driver. Game code never sees these resources.
import modelSrc from "./shaders/model.wgsl?raw";
import commonSrc from "./shaders/common.wgsl?raw";
import type { WebGPURenderer } from "./webgpu-renderer";
import { alphaModeOf, ALPHA_MODE, type GpuModel, type GpuResourceCounts, type ModelGeometry, type ModelDriver, type TranslucentDraw } from "./model";
import { DEFAULT_GLTF_SAMPLER, type GltfSampler } from "../gltf/glb";
import { samplerKey, usesMipmaps, webgpuSampler } from "./sampler";
type Geometry = { vertexBuffer: GPUBuffer; indexBuffer: GPUBuffer; skinBuffer?: GPUBuffer; hullBuffer: GPUBuffer };
/** One uploaded image, shared by every material and model that uses it; `refs` counts the source models holding it. */
type SharedImage = { image: ImageBitmap; tex: GPUTexture; refs: number };
type Resources = {
  nodeBuffer: GPUBuffer; jointBuffer: GPUBuffer; matBuffer: GPUBuffer; drawBuffer: GPUBuffer; paramBuffer: GPUBuffer;
  bindGroup: GPUBindGroup; textures: (GPUTexture | null)[]; textureGroups: GPUBindGroup[];
  spares: Map<number, { tex: GPUTexture; group: GPUBindGroup }>;
  /** True for the model that uploaded the textures (an instance shares its source's). */
  ownsTextures: boolean;
  /** The shared images this source model holds one reference to each (empty for an instance). */
  held: SharedImage[];
};
export class WebGPUModelDriver implements ModelDriver {
  private models = new WeakMap<GpuModel, Resources>();
  private geometry = new WeakMap<ModelGeometry, Geometry>();
  /** Live buffers and textures this driver made and has not destroyed (leak checks: see release and resources). */
  private live = { buffers: 0, textures: 0, bytes: 0 };
  /** Uploaded images by ImageBitmap: an atlas used by many materials, or by several uploads of one doc, goes up once. */
  private images = new Map<ImageBitmap, SharedImage>();
  private get device() { return this.renderer.device; }
  private sized = new WeakMap<GPUBuffer, number>();
  private destroyBuffer(b: GPUBuffer) {
    b.destroy();
    this.live.buffers--;
    this.live.bytes -= this.sized.get(b) ?? 0;
  }
  private destroyTexture(t: GPUTexture) {
    t.destroy();
    this.live.textures--;
  }
  upload(model: GpuModel, source: GpuModel | null): void {
    const d = this.device;
    const buffer = (data: ArrayBufferView, usage: number) => {
      const size = Math.max(64, Math.ceil(data.byteLength / 4) * 4);
      const b = d.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST });
      if (data.byteLength) d.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
      this.live.buffers++;
      this.live.bytes += size;
      this.sized.set(b, size);
      return b;
    };
    for (const p of model.primitives) {
      const g = p.geometry;
      if (this.geometry.has(g)) continue;
      this.geometry.set(g, {
        vertexBuffer: buffer(g.vertices, GPUBufferUsage.VERTEX), indexBuffer: buffer(g.indices, GPUBufferUsage.INDEX),
        hullBuffer: buffer(g.hull, GPUBufferUsage.VERTEX), skinBuffer: g.skin ? buffer(g.skin, GPUBufferUsage.VERTEX) : undefined,
      });
    }
    const nodeBuffer = buffer(model.nodes, GPUBufferUsage.STORAGE);
    const jointBuffer = buffer(model.joints, GPUBufferUsage.STORAGE);
    const matBuffer = buffer(model.materials, GPUBufferUsage.STORAGE);
    const drawBuffer = buffer(model.draws, GPUBufferUsage.STORAGE);
    const paramBuffer = buffer(model.params, GPUBufferUsage.UNIFORM);
    const bindGroup = d.createBindGroup({ layout: this.layoutModel, entries: [nodeBuffer, matBuffer, drawBuffer, jointBuffer, paramBuffer].map((b, binding) => ({ binding, resource: { buffer: b } })) });
    // A source model takes one reference to each image its materials use (an instance shares its source's).
    const held: SharedImage[] = [];
    const textures = source ? this.models.get(source)!.textures : model.doc.materials.map((m) => {
      if (!m.texture) return null;
      let entry = this.images.get(m.texture);
      if (!entry) this.images.set(m.texture, (entry = { image: m.texture, tex: this.uploadTexture(m.texture), refs: 0 }));
      if (!held.includes(entry)) { held.push(entry); entry.refs++; }
      return entry.tex;
    });
    // Each material samples its texture its own way (glTF samplers), so the sampler lives in the material's bind group.
    const textureGroups = textures.map((t, i) => t ? this.textureGroup(t, model.doc.materials[i].sampler) : this.whiteGroup);
    textureGroups.push(this.whiteGroup);
    this.models.set(model, { nodeBuffer, jointBuffer, matBuffer, drawBuffer, paramBuffer, bindGroup, textures, textureGroups, spares: new Map(), ownsTextures: !source, held });
  }

  /**
   * Destroy models' buffers and textures: a source model's geometry goes with it, and each image texture once no other source model uses it (so release a
   * source only with its instances), an instance's own buffers go alone. Nothing is destroyed while a model is being retextured, only here, once, when a scene is left; commands already submitted finish first
   * (WebGPU keeps a destroyed resource alive for work in flight).
   */
  release(models: readonly GpuModel[]): void {
    for (const model of models) {
      const r = this.models.get(model);
      if (!r) continue;
      // (An instance shares its source's geometry and textures and owns only its own buffers: releasing instances alone leaves the source whole.)
      if (r.ownsTextures) {
        for (const p of model.primitives) {
          const g = this.geometry.get(p.geometry);
          if (!g) continue;
          for (const b of [g.vertexBuffer, g.indexBuffer, g.hullBuffer, g.skinBuffer]) if (b) this.destroyBuffer(b);
          this.geometry.delete(p.geometry);
        }
        // Shared images go with the last source model holding them.
        for (const entry of r.held) {
          if (--entry.refs > 0) continue;
          this.destroyTexture(entry.tex);
          this.images.delete(entry.image);
        }
      }
      for (const b of [r.nodeBuffer, r.jointBuffer, r.matBuffer, r.drawBuffer, r.paramBuffer]) this.destroyBuffer(b);
      for (const s of r.spares.values()) this.destroyTexture(s.tex);
      this.models.delete(model);
    }
  }

  resources(): GpuResourceCounts {
    return { ...this.live };
  }

  update(model: GpuModel): void {
    const r = this.models.get(model)!;
    const q = this.device.queue;
    for (const [buffer, data] of [[r.nodeBuffer, model.nodes], [r.jointBuffer, model.joints], [r.matBuffer, model.materials], [r.drawBuffer, model.draws], [r.paramBuffer, model.params]] as const) {
      if (data.byteLength) q.writeBuffer(buffer, 0, data);
    }
  }

  draw(models: readonly GpuModel[], outline: boolean, shadow: boolean) {
    const pass = this.renderer.pass;
    pass.setBindGroup(0, shadow ? this.renderer.shadowBindGroup : this.renderer.frameBindGroup);
    let draws = 0, triangles = 0;
    for (const ink of outline && !shadow ? [true, false] : [false]) {
      for (const model of models) {
        const r = this.models.get(model)!;
        pass.setBindGroup(1, r.bindGroup);
        model.primitives.forEach((p, i) => {
          if (model.hidden[p.node]) return;
          const mode = alphaModeOf(model, i);
          if (mode === ALPHA_MODE.BLEND) return; // the translucent pass draws it
          const g = this.geometry.get(p.geometry)!;
          // MASK casters cut out in the shadow map too, so they need the texture.
          const cutout = shadow && mode === ALPHA_MODE.MASK;
          const pipe = shadow ? (cutout ? (p.skinned ? this.depthPipes.skinMask : this.depthPipes.statMask) : (p.skinned ? this.depthPipes.skin : this.depthPipes.stat))
            : ink ? (p.skinned ? this.pipes.skinInk : this.pipes.staticInk) : (p.skinned ? this.pipes.skinFill : this.pipes.staticFill);
          pass.setPipeline(pipe);
          if (!shadow || cutout) pass.setBindGroup(2, r.textureGroups[p.material >= 0 ? p.material : model.doc.materials.length]);
          pass.setVertexBuffer(0, g.vertexBuffer);
          if (p.skinned) pass.setVertexBuffer(1, g.skinBuffer!);
          if (ink) pass.setVertexBuffer(p.skinned ? 2 : 1, g.hullBuffer);
          pass.setIndexBuffer(g.indexBuffer, "uint32");
          pass.drawIndexed(p.indexCount, 1, 0, 0, i);
          draws++; triangles += p.indexCount / 3;
        });
      }
    }
    return { draws, triangles };
  }

  /** BLEND primitives in the order given (back to front), premultiplied over the scene with depth test on and depth write off. */
  drawTranslucent(items: readonly TranslucentDraw[]) {
    const pass = this.renderer.pass;
    pass.setBindGroup(0, this.renderer.frameBindGroup);
    let draws = 0, triangles = 0, bound: GpuModel | null = null;
    for (const { model, primitive: i } of items) {
      const r = this.models.get(model);
      if (!r) continue;
      if (bound !== model) { pass.setBindGroup(1, r.bindGroup); bound = model; }
      const p = model.primitives[i];
      const g = this.geometry.get(p.geometry)!;
      pass.setPipeline(p.skinned ? this.pipes.skinBlend : this.pipes.staticBlend);
      pass.setBindGroup(2, r.textureGroups[p.material >= 0 ? p.material : model.doc.materials.length]);
      pass.setVertexBuffer(0, g.vertexBuffer);
      if (p.skinned) pass.setVertexBuffer(1, g.skinBuffer!);
      pass.setIndexBuffer(g.indexBuffer, "uint32");
      pass.drawIndexed(p.indexCount, 1, 0, 0, i);
      draws++; triangles += p.indexCount / 3;
    }
    return { draws, triangles };
  }
  private layoutModel: GPUBindGroupLayout;
  private layoutTex: GPUBindGroupLayout;
  private pipes: {
    staticFill: GPURenderPipeline; staticInk: GPURenderPipeline; skinFill: GPURenderPipeline; skinInk: GPURenderPipeline;
    staticBlend: GPURenderPipeline; skinBlend: GPURenderPipeline;
  };
  private depthPipes: { stat: GPURenderPipeline; skin: GPURenderPipeline; statMask: GPURenderPipeline; skinMask: GPURenderPipeline };
  private sampler: GPUSampler;
  /** One GPUSampler per distinct glTF sampler (samplerKey). */
  private samplers = new Map<string, GPUSampler>();
  private whiteGroup: GPUBindGroup;
  private mipPipe: GPURenderPipeline | null = null;
  constructor(private renderer: WebGPURenderer) {
    const d = renderer.device;
    const FRAG = GPUShaderStage.FRAGMENT;
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.layoutModel = d.createBindGroupLayout({
      label: "model",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: VF, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: VF, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: VF, buffer: { type: "uniform" } },
      ],
    });
    this.layoutTex = d.createBindGroupLayout({
      label: "model-texture",
      entries: [
        { binding: 0, visibility: FRAG, texture: { sampleType: "float" } },
        { binding: 1, visibility: FRAG, sampler: { type: "filtering" } },
      ],
    });
    // The default: linear, trilinear mipmaps, 4× anisotropy, repeat (what every texture used before glTF samplers were read).
    this.sampler = d.createSampler(webgpuSampler(DEFAULT_GLTF_SAMPLER));
    this.samplers.set(samplerKey(DEFAULT_GLTF_SAMPLER), this.sampler);
    const white = d.createTexture({ size: [1, 1], format: "rgba8unorm-srgb", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    this.whiteGroup = d.createBindGroup({ layout: this.layoutTex, entries: [{ binding: 0, resource: white.createView() }, { binding: 1, resource: this.sampler }] });

    const module = d.createShaderModule({ label: "model", code: commonSrc + "\n" + modelSrc });
    module.getCompilationInfo().then((info) => {
      for (const m of info.messages) if (m.type === "error") console.error(`[wgsl model] ${m.lineNum}:${m.linePos} ${m.message}`);
    });
    const layout = d.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout, this.layoutModel, this.layoutTex] });
    const base: GPUVertexBufferLayout = {
      arrayStride: 32,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x3" },
        { shaderLocation: 2, offset: 24, format: "float32x2" },
      ],
    };
    const skin: GPUVertexBufferLayout = {
      arrayStride: 24,
      attributes: [
        { shaderLocation: 3, offset: 0, format: "uint16x4" },
        { shaderLocation: 4, offset: 8, format: "float32x4" },
      ],
    };
    const hull: GPUVertexBufferLayout = { arrayStride: 12, attributes: [{ shaderLocation: 5, offset: 0, format: "float32x3" }] };
    const premul: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const make = (vs: string, fs: string, cull: GPUCullMode, skinned: boolean, ink = false, blend?: GPUBlendState) =>
      d.createRenderPipeline({
        label: `model-${vs}${blend ? "-blend" : ""}`,
        layout,
        vertex: { module, entryPoint: vs, buffers: [base, ...(skinned ? [skin] : []), ...(ink ? [hull] : [])] },
        fragment: { module, entryPoint: fs, targets: [{ format: renderer.hdrFormat, blend }] },
        primitive: { cullMode: cull },
        depthStencil: { format: renderer.depthFormat, depthWriteEnabled: !blend, depthCompare: "less" },
      });
    // Materials are exported double-sided, so the fill pass does not cull;
    // the ink pass culls front faces to leave the expanded back-face shell.
    this.pipes = {
      staticFill: make("vsStatic", "fs", "none", false),
      staticInk: make("vsStaticOutline", "fsOutline", "front", false, true),
      skinFill: make("vsSkinned", "fs", "none", true),
      skinInk: make("vsSkinnedOutline", "fsOutline", "front", true, true),
      staticBlend: make("vsStatic", "fsBlend", "none", false, false, premul),
      skinBlend: make("vsSkinned", "fsBlend", "none", true, false, premul),
    };
    // Depth-only casters for the sun shadow map (vertex stage only; groups 0–1).
    const depthLayout = d.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout, this.layoutModel] });
    const depth = (vs: string, skinned: boolean) =>
      d.createRenderPipeline({
        label: `model-shadow-${vs}`,
        layout: depthLayout,
        vertex: { module, entryPoint: vs, buffers: skinned ? [base, skin] : [base] },
        primitive: { cullMode: "none" },
        depthStencil: { format: renderer.shadowFormat, depthWriteEnabled: true, depthCompare: "less", ...renderer.shadowBias },
      });
    // MASK casters: the same with a fragment stage that discards cut-out texels (groups 0–2).
    const maskLayout = d.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout, this.layoutModel, this.layoutTex] });
    const depthMask = (vs: string, skinned: boolean) =>
      d.createRenderPipeline({
        label: `model-shadow-mask-${vs}`,
        layout: maskLayout,
        vertex: { module, entryPoint: vs, buffers: skinned ? [base, skin] : [base] },
        fragment: { module, entryPoint: "fsShadowMask", targets: [] },
        primitive: { cullMode: "none" },
        depthStencil: { format: renderer.shadowFormat, depthWriteEnabled: true, depthCompare: "less", ...renderer.shadowBias },
      });
    this.depthPipes = { stat: depth("vsStatic", false), skin: depth("vsSkinned", true), statMask: depthMask("vsStatic", false), skinMask: depthMask("vsSkinned", true) };
  }

  /** An sRGB texture with a mip chain from an image or canvas. */
  private uploadTexture(src: ImageBitmap | OffscreenCanvas): GPUTexture {
    const d = this.device;
    const mips = Math.floor(Math.log2(Math.max(src.width, src.height))) + 1;
    const tex = d.createTexture({
      size: [src.width, src.height],
      format: "rgba8unorm-srgb",
      mipLevelCount: mips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.live.textures++;
    try {
      d.queue.copyExternalImageToTexture({ source: src }, { texture: tex }, [src.width, src.height]);
    } catch (e) {
      // Headless SwiftShader can lose Chrome's GPU-backed image path after a while (every later
      // copyExternalImageToTexture throws "Failed to copy content from external image"). Fall back to a
      // CPU readback (willReadFrequently keeps the canvas off the GPU) and writeTexture.
      const c = new OffscreenCanvas(src.width, src.height);
      const g = c.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
      if (!g) throw e;
      g.drawImage(src, 0, 0);
      const px = g.getImageData(0, 0, src.width, src.height, { colorSpace: "srgb" }).data;
      d.queue.writeTexture({ texture: tex }, px, { bytesPerRow: src.width * 4, rowsPerImage: src.height }, [src.width, src.height]);
      console.info("[gpu] texture uploaded via CPU fallback", src.width, src.height);
    }
    this.generateMips(tex, mips);
    return tex;
  }

  /**
   * A material's texture and sampler. Textures always carry a mip chain; a glTF minification filter without mipmaps
   * (NEAREST, LINEAR) gets a view of the full-size level only, so it never reads a smaller one however far away.
   */
  private textureGroup(tex: GPUTexture, settings: GltfSampler = DEFAULT_GLTF_SAMPLER): GPUBindGroup {
    const key = samplerKey(settings);
    let sampler = this.samplers.get(key);
    if (!sampler) this.samplers.set(key, (sampler = this.device.createSampler(webgpuSampler(settings))));
    const view = usesMipmaps(settings) ? tex.createView() : tex.createView({ mipLevelCount: 1 });
    return this.device.createBindGroup({ layout: this.layoutTex, entries: [{ binding: 0, resource: view }, { binding: 1, resource: sampler }] });
  }

  /**
   * Show another base-colour image on a material (e.g. an outfit colour), or its own texture again
   * with null. The image goes into one spare texture per material, made on first use and rewritten
   * after that. Destroying the file's texture instead once stalled Chrome at about 1 fps, so
   * nothing here is destroyed.
   */
  retexture(model: GpuModel, material: number, src: ImageBitmap | OffscreenCanvas | null): void {
    const gpu = this.models.get(model)!;
    const own = gpu.textures[material];
    if (!own) return;
    const sampler = model.doc.materials[material].sampler; // a replacement image is sampled like the file's
    if (!src) {
      gpu.textureGroups[material] = this.textureGroup(own, sampler);
      return;
    }
    let spare = gpu.spares.get(material);
    if (!spare || spare.tex.width !== src.width || spare.tex.height !== src.height) {
      const tex = this.uploadTexture(src);
      spare = { tex, group: this.textureGroup(tex, sampler) };
      gpu.spares.set(material, spare);
    } else {
      this.device.queue.copyExternalImageToTexture({ source: src }, { texture: spare.tex }, [src.width, src.height]);
      this.generateMips(spare.tex, spare.tex.mipLevelCount);
    }
    gpu.textureGroups[material] = spare.group;
  }

  /** Box-filter mip chain by rendering each level from the previous one. */
  private generateMips(tex: GPUTexture, levels: number) {
    if (levels <= 1) return;
    const d = this.device;
    if (!this.mipPipe) {
      const m = d.createShaderModule({
        label: "mips",
        code: `
          @group(0) @binding(0) var src: texture_2d<f32>;
          @group(0) @binding(1) var smp: sampler;
          struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f };
          @vertex fn vs(@builtin(vertex_index) i: u32) -> V {
            var q = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
            var o: V; o.p = vec4f(q[i], 0, 1); o.uv = vec2f(q[i].x * 0.5 + 0.5, 0.5 - q[i].y * 0.5); return o;
          }
          @fragment fn fs(v: V) -> @location(0) vec4f { return textureSampleLevel(src, smp, v.uv, 0.0); }`,
      });
      this.mipPipe = d.createRenderPipeline({
        layout: "auto",
        vertex: { module: m, entryPoint: "vs" },
        fragment: { module: m, entryPoint: "fs", targets: [{ format: tex.format }] },
      });
    }
    const smp = d.createSampler({ minFilter: "linear", magFilter: "linear" });
    const enc = d.createCommandEncoder();
    for (let l = 1; l < levels; l++) {
      const bg = d.createBindGroup({
        layout: this.mipPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: tex.createView({ baseMipLevel: l - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: smp },
        ],
      });
      const p = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView({ baseMipLevel: l, mipLevelCount: 1 }), loadOp: "clear", clearValue: [0, 0, 0, 0], storeOp: "store" }] });
      p.setPipeline(this.mipPipe);
      p.setBindGroup(0, bg);
      p.draw(3);
      p.end();
    }
    d.queue.submit([enc.finish()]);
  }
}
