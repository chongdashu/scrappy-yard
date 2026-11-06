// WebGPU renderer. Passes per frame:
//   1. sun shadow map (depth only): instanced meshes + shadow hooks (GLB models)
//   2. HDR scene (rgba16float): ground plane, instanced meshes with ink
//      outlines, scene hooks (GLB models), blob shadows, sky, translucent
//      hooks (BLEND materials, back to front), particles
//   3. bloom: prefilter to half resolution + two separable blur iterations
//   4. composite + grade to the canvas (optional depth of field from the
//      scene depth, hue-preserving highlight roll-off)
// Everything game-specific arrives as data in FrameData or through hooks.
import commonSrc from "./shaders/common.wgsl?raw";
import groundSrc from "./shaders/ground.wgsl?raw";
import meshSrc from "./shaders/mesh.wgsl?raw";
import particleSrc from "./shaders/particles.wgsl?raw";
import postSrc from "./shaders/post.wgsl?raw";
import skySrc from "./shaders/sky.wgsl?raw";
import { buildMeshes, INSTANCE_FLOATS } from "./meshes";
import { Renderer, PARTICLE_FLOATS, type FrameData } from "./renderer";
import { WebGPUModelDriver } from "./webgpu-model";
import { StartupFailure, withTimeout } from "./selection";

import { FRAME_FLOATS, writeFrame, shadowFrame } from "./frame";
const HDR = "rgba16float" as const;
const DEPTH = "depth24plus" as const;
const SHADOW = "depth32float" as const;
const MAX_INSTANCES = 4096;
const MAX_PARTICLES = 4096;
const MAX_BLOBS = 256;


const premul: GPUBlendState = {
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};

export class WebGPURenderer extends Renderer {
  readonly backend = "webgpu" as const;
  readonly capabilities = { hdr: true, bloom: true };
  private models!: WebGPUModelDriver;
  pass!: GPURenderPassEncoder; // available only while executing a scene/shadow hook

  private format: GPUTextureFormat;
  private frameBuf: GPUBuffer;
  private frameData = new Float32Array(FRAME_FLOATS);
  private shadowFrameData = new Float32Array(FRAME_FLOATS);
  private shadowFrameBuf: GPUBuffer;
  private shadowTex: GPUTexture;
  private shadowSize: number;
  private bgShadowPass: GPUBindGroup;
  private bg0: GPUBindGroup;
  private l0: GPUBindGroupLayout;
  private lPost: GPUBindGroupLayout;
  private lDepth: GPUBindGroupLayout;
  private bgDepth!: GPUBindGroup;
  private pipes!: Record<string, GPURenderPipeline>;
  private meshes: { vb: GPUBuffer; ib: GPUBuffer; count: number }[] = [];
  private instBuf: GPUBuffer;
  private partBuf: GPUBuffer;
  private blobBuf: GPUBuffer;
  private linear: GPUSampler;
  private blurH: GPUBuffer;
  private blurV: GPUBuffer;
  private hdr!: GPUTexture;
  private depth!: GPUTexture;
  private bloomA!: GPUTexture;
  private bloomB!: GPUTexture;
  private bgPrefilter!: GPUBindGroup;
  private bgBlurH!: GPUBindGroup;
  private bgBlurV!: GPUBindGroup;
  private bgComposite!: GPUBindGroup;
  private size = [0, 0];
  /** Shared layout/format facts for modules that build their own pipelines. */
  get frameLayout(): GPUBindGroupLayout { return this.l0; }
  get frameBindGroup(): GPUBindGroup { return this.bg0; }
  get shadowBindGroup(): GPUBindGroup { return this.bgShadowPass; }
  get hdrFormat(): GPUTextureFormat { return HDR; }
  get depthFormat(): GPUTextureFormat { return DEPTH; }
  get shadowFormat(): GPUTextureFormat { return SHADOW; }
  /** Depth bias for shadow casters (pipelines built by other modules should match). */
  readonly shadowBias = { depthBias: 2, depthBiasSlopeScale: 2.5, depthBiasClamp: 0.01 };

  static async create(canvas: HTMLCanvasElement): Promise<WebGPURenderer> {
    if (!navigator.gpu) throw new StartupFailure("api-unavailable", "WebGPU is not exposed by this browser.");
    let stage = "adapter";
    let device: GPUDevice | undefined;
    let ctx: GPUCanvasContext | null = null;
    try {
      const adapter = await withTimeout(navigator.gpu.requestAdapter({ powerPreference: "high-performance" }), "adapter");
      if (!adapter) throw new StartupFailure("adapter-unavailable", "No WebGPU adapter is available.");
      stage = "device";
      device = await withTimeout(adapter.requestDevice(), "device", (late) => late.destroy());
      stage = "initialization";
      device.pushErrorScope("validation");
      device.pushErrorScope("out-of-memory");
      device.pushErrorScope("internal");
      ctx = canvas.getContext("webgpu");
      if (!ctx) throw new Error("Could not create a WebGPU canvas context.");
      const renderer = new WebGPURenderer(canvas, device, ctx);
      renderer.ensureSize(canvas);
      const errors = await withTimeout(Promise.all([device.popErrorScope(), device.popErrorScope(), device.popErrorScope()]), "initialization");
      const error = errors.find(Boolean);
      if (error) throw new Error(error.message);
      await withTimeout(device.queue.onSubmittedWorkDone(), "initialization");
      return renderer;
    } catch (e) {
      ctx?.unconfigure();
      device?.destroy();
      if (e instanceof StartupFailure) throw e;
      throw new StartupFailure(stage, e instanceof Error ? e.message : String(e));
    }
  }

  private constructor(canvas: HTMLCanvasElement, readonly device: GPUDevice, private ctx: GPUCanvasContext) {
    super(canvas);
    this.format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format: this.format, alphaMode: "opaque" });
    device.lost.then((info) => {
      // "destroyed" is our own teardown; anything else is a real loss.
      if (info.reason !== "destroyed") this.onLost?.(`${info.reason || "unknown"}: ${info.message}`);
    });
    device.addEventListener("uncapturederror", (e) => {
      const error = (e as GPUUncapturedErrorEvent).error;
      console.error("[gpu]", error.message);
      this.onError?.(error);
    });

    const d = device;
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.l0 = d.createBindGroupLayout({
      label: "frame",
      entries: [
        { binding: 0, visibility: VF, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
      ],
    });
    this.lPost = d.createBindGroupLayout({
      label: "post",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });

    // The composite reads the scene depth for depth of field (group 2).
    this.lDepth = d.createBindGroupLayout({
      label: "scene-depth",
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } }],
    });

    this.frameBuf = d.createBuffer({ size: this.frameData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.shadowFrameBuf = d.createBuffer({ size: this.shadowFrameData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // Sun shadow map: 2048² with a fine pointer, 1024² on touch devices.
    this.shadowSize = matchMedia("(pointer: coarse)").matches ? 1024 : 2048;
    this.shadowTex = d.createTexture({ size: [this.shadowSize, this.shadowSize], format: SHADOW, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const cmp = d.createSampler({ compare: "less-equal", magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    // The shadow pass can't sample the map it renders, so it binds a 1×1 stand-in.
    const dummy = d.createTexture({ size: [1, 1], format: SHADOW, usage: GPUTextureUsage.TEXTURE_BINDING });
    const group = (buf: GPUBuffer, shadow: GPUTextureView) =>
      d.createBindGroup({
        layout: this.l0,
        entries: [
          { binding: 0, resource: { buffer: buf } },
          { binding: 1, resource: shadow },
          { binding: 2, resource: cmp },
        ],
      });
    this.bg0 = group(this.frameBuf, this.shadowTex.createView());
    this.bgShadowPass = group(this.shadowFrameBuf, dummy.createView());
    const vbuf = (bytes: number) => d.createBuffer({ size: bytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.instBuf = vbuf(MAX_INSTANCES * INSTANCE_FLOATS * 4);
    this.partBuf = vbuf(MAX_PARTICLES * PARTICLE_FLOATS * 4);
    this.blobBuf = vbuf(MAX_BLOBS * 16);
    this.linear = d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    this.blurH = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.blurV = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    for (const m of buildMeshes()) {
      const vb = d.createBuffer({ size: m.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(vb, 0, m.vertices);
      const ibSize = Math.ceil(m.indices.byteLength / 4) * 4;
      const ib = d.createBuffer({ size: ibSize, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      const padded = new Uint16Array(ibSize / 2);
      padded.set(m.indices);
      d.queue.writeBuffer(ib, 0, padded);
      this.meshes.push({ vb, ib, count: m.indices.length });
    }
    this.buildPipelines();
    this.models = new WebGPUModelDriver(this);
  }

  /** A shader module with the shared frame header; compile errors are logged with line numbers. */
  module(src: string, label: string): GPUShaderModule {
    const m = this.device.createShaderModule({ code: commonSrc + "\n" + src, label });
    m.getCompilationInfo().then((info) => {
      for (const msg of info.messages) if (msg.type === "error") console.error(`[wgsl ${label}] ${msg.lineNum}:${msg.linePos} ${msg.message}`);
    });
    return m;
  }

  private buildPipelines() {
    const d = this.device;
    const ground = this.module(groundSrc, "ground");
    const mesh = this.module(meshSrc, "mesh");
    const part = this.module(particleSrc, "particles");
    const post = this.module(postSrc, "post");
    const sky = this.module(skySrc, "sky");
    const layout0 = d.createPipelineLayout({ bindGroupLayouts: [this.l0] });
    const layoutPost = d.createPipelineLayout({ bindGroupLayouts: [this.l0, this.lPost] });
    const layoutComposite = d.createPipelineLayout({ bindGroupLayouts: [this.l0, this.lPost, this.lDepth] });
    const depthOn: GPUDepthStencilState = { format: DEPTH, depthWriteEnabled: true, depthCompare: "less" };
    const depthRead: GPUDepthStencilState = { format: DEPTH, depthWriteEnabled: false, depthCompare: "less-equal" };
    const f4 = (loc: number, off: number): GPUVertexAttribute => ({ shaderLocation: loc, offset: off, format: "float32x4" });
    const meshBuffers: GPUVertexBufferLayout[] = [
      { arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" }] },
      { arrayStride: INSTANCE_FLOATS * 4, stepMode: "instance", attributes: [f4(2, 0), f4(3, 16), f4(4, 32), f4(5, 48), f4(6, 64), f4(7, 80)] },
    ];
    const hdrTarget = (blend?: GPUBlendState): GPUColorTargetState => ({ format: HDR, blend });

    this.pipes = {
      shadowMesh: d.createRenderPipeline({
        label: "shadow-mesh",
        layout: layout0,
        vertex: { module: mesh, entryPoint: "vs", buffers: meshBuffers },
        primitive: { cullMode: "none" },
        depthStencil: { format: SHADOW, depthWriteEnabled: true, depthCompare: "less", ...this.shadowBias },
      }),
      sky: d.createRenderPipeline({
        label: "sky",
        layout: layout0,
        vertex: { module: sky, entryPoint: "vs" },
        fragment: { module: sky, entryPoint: "fs", targets: [hdrTarget()] },
        depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: "less-equal" },
      }),
      ground: d.createRenderPipeline({
        label: "ground",
        layout: layout0,
        vertex: { module: ground, entryPoint: "vsGround" },
        fragment: { module: ground, entryPoint: "fsGround", targets: [hdrTarget()] },
        depthStencil: depthOn,
      }),
      blob: d.createRenderPipeline({
        label: "blob-shadow",
        layout: layout0,
        vertex: { module: ground, entryPoint: "vsBlob", buffers: [{ arrayStride: 16, stepMode: "instance", attributes: [f4(0, 0)] }] },
        fragment: { module: ground, entryPoint: "fsBlob", targets: [hdrTarget(premul)] },
        depthStencil: depthRead,
      }),
      outline: d.createRenderPipeline({
        label: "mesh-ink",
        layout: layout0,
        vertex: { module: mesh, entryPoint: "vsOutline", buffers: meshBuffers },
        fragment: { module: mesh, entryPoint: "fsOutline", targets: [hdrTarget()] },
        primitive: { cullMode: "front" },
        depthStencil: depthOn,
      }),
      mesh: d.createRenderPipeline({
        label: "mesh",
        layout: layout0,
        vertex: { module: mesh, entryPoint: "vs", buffers: meshBuffers },
        fragment: { module: mesh, entryPoint: "fs", targets: [hdrTarget()] },
        primitive: { cullMode: "back" },
        depthStencil: depthOn,
      }),
      particles: d.createRenderPipeline({
        label: "particles",
        layout: layout0,
        vertex: { module: part, entryPoint: "vs", buffers: [{ arrayStride: PARTICLE_FLOATS * 4, stepMode: "instance", attributes: [f4(0, 0), f4(1, 16), f4(2, 32)] }] },
        fragment: { module: part, entryPoint: "fs", targets: [hdrTarget(premul)] },
        depthStencil: depthRead,
      }),
      prefilter: d.createRenderPipeline({
        label: "bloom-prefilter",
        layout: layoutPost,
        vertex: { module: post, entryPoint: "vsFull" },
        fragment: { module: post, entryPoint: "fsPrefilter", targets: [{ format: HDR }] },
      }),
      blur: d.createRenderPipeline({
        label: "bloom-blur",
        layout: layoutPost,
        vertex: { module: post, entryPoint: "vsFull" },
        fragment: { module: post, entryPoint: "fsBlur", targets: [{ format: HDR }] },
      }),
      composite: d.createRenderPipeline({
        label: "composite",
        layout: layoutComposite,
        vertex: { module: post, entryPoint: "vsFull" },
        fragment: { module: post, entryPoint: "fsComposite", targets: [{ format: this.format }] },
      }),
    };
  }

  private ensureSize(canvas: HTMLCanvasElement) {
    const dpr = Math.min(devicePixelRatio || 1, this.maxDpr);
    let w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    let h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (w * h > this.maxPixels) {
      const s = Math.sqrt(this.maxPixels / (w * h));
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    if (w === this.size[0] && h === this.size[1]) return;
    this.size = [w, h];
    canvas.width = w;
    canvas.height = h;
    const d = this.device;
    for (const t of [this.hdr, this.depth, this.bloomA, this.bloomB]) t?.destroy();
    const RA = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.hdr = d.createTexture({ size: [w, h], format: HDR, usage: RA });
    this.depth = d.createTexture({ size: [w, h], format: DEPTH, usage: RA });
    this.bgDepth = d.createBindGroup({ layout: this.lDepth, entries: [{ binding: 0, resource: this.depth.createView() }] });
    const bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
    this.bloomA = d.createTexture({ size: [bw, bh], format: HDR, usage: RA });
    this.bloomB = d.createTexture({ size: [bw, bh], format: HDR, usage: RA });
    d.queue.writeBuffer(this.blurH, 0, new Float32Array([1 / bw, 0, 0, 0]));
    d.queue.writeBuffer(this.blurV, 0, new Float32Array([0, 1 / bh, 0, 0]));
    const pg = (src: GPUTexture, bloom: GPUTexture, u: GPUBuffer) =>
      d.createBindGroup({
        layout: this.lPost,
        entries: [
          { binding: 0, resource: src.createView() },
          { binding: 1, resource: this.linear },
          { binding: 2, resource: bloom.createView() },
          { binding: 3, resource: { buffer: u } },
        ],
      });
    this.bgPrefilter = pg(this.hdr, this.bloomB, this.blurH);
    this.bgBlurH = pg(this.bloomA, this.hdr, this.blurH);
    this.bgBlurV = pg(this.bloomB, this.hdr, this.blurV);
    this.bgComposite = pg(this.hdr, this.bloomA, this.blurH);
  }

  /** Render target size in device pixels. */
  get pixelSize(): [number, number] {
    return [this.size[0], this.size[1]];
  }


  render(canvas: HTMLCanvasElement, f: FrameData) {
    this.ensureSize(canvas);
    const d = this.device;
    const [w, h] = this.size;
    const u = this.frameData;
    const s = writeFrame(this, f, w, h, this.shadowSize, u);
    const shadowsOn = s.shadow > 0;
    d.queue.writeBuffer(this.frameBuf, 0, u);
    shadowFrame(u, this.shadowFrameData);
    d.queue.writeBuffer(this.shadowFrameBuf, 0, this.shadowFrameData);

    // Dynamic vertex data.
    const offsets: number[] = [];
    const counts: number[] = [];
    let used = 0;
    for (const b of f.batches) {
      const n = Math.max(0, Math.min(b.count, MAX_INSTANCES - used));
      offsets.push(used * INSTANCE_FLOATS * 4);
      counts.push(n);
      if (n > 0) d.queue.writeBuffer(this.instBuf, used * INSTANCE_FLOATS * 4, b.data, 0, n * INSTANCE_FLOATS);
      used += n;
    }
    const partN = Math.min(f.particleCount, MAX_PARTICLES);
    if (partN) d.queue.writeBuffer(this.partBuf, 0, f.particles, 0, partN * PARTICLE_FLOATS);
    const blobN = Math.min(f.blobCount, MAX_BLOBS);
    if (blobN) d.queue.writeBuffer(this.blobBuf, 0, f.blobs, 0, blobN * 4);

    const enc = d.createCommandEncoder();
    const drawMeshes = (pass: GPURenderPassEncoder) => {
      counts.forEach((n, i) => {
        if (n <= 0 || !this.meshes[i]) return;
        const m = this.meshes[i];
        pass.setVertexBuffer(0, m.vb);
        pass.setIndexBuffer(m.ib, "uint16");
        pass.setVertexBuffer(1, this.instBuf, offsets[i]);
        pass.drawIndexed(m.count, n);
      });
    };

    // 1. Sun shadow map.
    if (shadowsOn) {
      const shp = enc.beginRenderPass({
        label: "sun-shadow",
        colorAttachments: [],
        depthStencilAttachment: { view: this.shadowTex.createView(), depthLoadOp: "clear", depthClearValue: 1, depthStoreOp: "store" },
      });
      shp.setBindGroup(0, this.bgShadowPass);
      shp.setPipeline(this.pipes.shadowMesh);
      drawMeshes(shp);
      for (const hook of this.shadowHooks) {
        this.pass = shp;
        hook();
        shp.setBindGroup(0, this.bgShadowPass);
      }
      shp.end();
    }

    // 2. Scene into HDR.
    const sp = enc.beginRenderPass({
      label: "scene",
      colorAttachments: [{ view: this.hdr.createView(), loadOp: "clear", clearValue: [...this.background, 1], storeOp: "store" }],
      depthStencilAttachment: { view: this.depth.createView(), depthLoadOp: "clear", depthClearValue: 1, depthStoreOp: "store" },
    });
    sp.setBindGroup(0, this.bg0);
    if (this.ground.visible) {
      sp.setPipeline(this.pipes.ground);
      sp.draw(6);
    }
    if (s.inkPx > 0) {
      sp.setPipeline(this.pipes.outline);
      drawMeshes(sp);
    }
    sp.setPipeline(this.pipes.mesh);
    drawMeshes(sp);
    for (const hook of this.sceneHooks) {
      this.pass = sp;
      hook();
      sp.setBindGroup(0, this.bg0);
    }
    // Contact shadows after opaque geometry so they darken level floors too.
    if (blobN) {
      sp.setPipeline(this.pipes.blob);
      sp.setVertexBuffer(0, this.blobBuf);
      sp.draw(6, blobN);
    }
    // Sky fills whatever the opaque geometry left at the far plane.
    if (this.skyVisible) {
      sp.setPipeline(this.pipes.sky);
      sp.draw(3);
    }
    // Translucent surfaces over everything opaque and the sky; they don't write depth.
    for (const hook of this.translucentHooks) {
      this.pass = sp;
      hook(f.camera.eye);
      sp.setBindGroup(0, this.bg0);
    }
    if (partN) {
      sp.setPipeline(this.pipes.particles);
      sp.setVertexBuffer(0, this.partBuf);
      sp.draw(6, partN);
    }
    sp.end();

    // 3. Bloom.
    const postPass = (target: GPUTexture, pipe: GPURenderPipeline, bg: GPUBindGroup) => {
      const p = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", clearValue: [0, 0, 0, 1], storeOp: "store" }] });
      p.setPipeline(pipe);
      p.setBindGroup(0, this.bg0);
      p.setBindGroup(1, bg);
      p.draw(3);
      p.end();
    };
    postPass(this.bloomA, this.pipes.prefilter, this.bgPrefilter);
    for (let i = 0; i < 2; i++) {
      postPass(this.bloomB, this.pipes.blur, this.bgBlurH);
      postPass(this.bloomA, this.pipes.blur, this.bgBlurV);
    }
    // 4. Composite + grade to the canvas.
    const out = this.ctx.getCurrentTexture();
    const cp = enc.beginRenderPass({ label: "composite", colorAttachments: [{ view: out.createView(), loadOp: "clear", clearValue: [0, 0, 0, 1], storeOp: "store" }] });
    cp.setPipeline(this.pipes.composite);
    cp.setBindGroup(0, this.bg0);
    cp.setBindGroup(1, this.bgComposite);
    cp.setBindGroup(2, this.bgDepth);
    cp.draw(3);
    cp.end();
    d.queue.submit([enc.finish()]);
  }
  createModelDriver() { return this.models; }
  finished() { return this.device.queue.onSubmittedWorkDone(); }
  dispose() { this.onLost = null; this.ctx.unconfigure(); this.device.destroy(); }

}
