// Direct WebGL 2 backend, with no scene framework or runtime shader translator.
import { Renderer, PARTICLE_FLOATS, type FrameData } from "../renderer";
import { FRAME_FLOATS, writeFrame, shadowFrame } from "../frame";
import { buildMeshes, INSTANCE_FLOATS } from "../meshes";
import { Resources, attribute, type Program } from "./resources";
import { WebGLModelDriver } from "./model";
import * as shader from "./shaders";

/** A colour texture with an optional depth texture (the scene's: the composite reads it for depth of field). */
type Target = { texture: WebGLTexture; framebuffer: WebGLFramebuffer; depth: WebGLTexture | null; w: number; h: number };
type Mesh = { vao: WebGLVertexArrayObject; count: number };
const MAX_INSTANCES = 4096, MAX_PARTICLES = 4096, MAX_BLOBS = 256;

export class WebGLRenderer extends Renderer {
  readonly backend = "webgl2" as const;
  readonly resources: Resources;
  readonly capabilities: { hdr: boolean; bloom: boolean };
  private frame = new Float32Array(FRAME_FLOATS);
  private sunFrame = new Float32Array(FRAME_FLOATS);
  private frameBuffer: WebGLBuffer;
  private sunBuffer: WebGLBuffer;
  private shadowTexture: WebGLTexture;
  private shadowDummy: WebGLTexture;
  private shadowFramebuffer: WebGLFramebuffer;
  private shadowSize: number;
  private inShadow = false;
  private models: WebGLModelDriver;
  private meshes: Mesh[] = [];
  private instances: WebGLBuffer;
  private particles: WebGLBuffer;
  private blobs: WebGLBuffer;
  private particleVAO: WebGLVertexArrayObject;
  private blobVAO: WebGLVertexArrayObject;
  private emptyVAO: WebGLVertexArrayObject;
  private black: WebGLTexture;
  private programs: Record<string, Program>;
  private targets: Target[] = [];
  private size: [number, number] = [0, 0];
  private sizeLimit: number;
  private lost = false;
  private disposed = false;

  static async create(canvas: HTMLCanvasElement): Promise<WebGLRenderer> {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("This browser could not create a WebGL 2 context.");
    const resources = new Resources(gl);
    try { return new WebGLRenderer(canvas, gl, resources); }
    catch (error) { resources.dispose(); gl.getExtension("WEBGL_lose_context")?.loseContext(); throw error; }
  }

  private constructor(canvas: HTMLCanvasElement, readonly gl: WebGL2RenderingContext, resources: Resources) {
    super(canvas);
    this.resources = resources;
    this.sizeLimit = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    const r = resources;
    let hdr = false;
    if (gl.getExtension("EXT_color_buffer_float")) {
      try { const probe = this.target(4, 4, true, true); this.deleteTarget(probe); hdr = true; } catch { /* use RGBA8 */ }
    }
    this.capabilities = { hdr, bloom: hdr };
    this.frameBuffer = r.buffer(gl.UNIFORM_BUFFER, FRAME_FLOATS * 4, gl.DYNAMIC_DRAW);
    this.sunBuffer = r.buffer(gl.UNIFORM_BUFFER, FRAME_FLOATS * 4, gl.DYNAMIC_DRAW);
    this.shadowSize = Math.min(matchMedia("(pointer: coarse)").matches ? 1024 : 2048, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const depthTexture = (size: number) => {
      const tex = r.texture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      return tex;
    };
    this.shadowTexture = depthTexture(this.shadowSize);
    this.shadowDummy = depthTexture(1);
    this.shadowFramebuffer = r.framebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTexture, 0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("WebGL shadow framebuffer is incomplete.");
    this.emptyVAO = r.vao();
    gl.bindVertexArray(this.emptyVAO);
    this.instances = r.buffer(gl.ARRAY_BUFFER, MAX_INSTANCES * INSTANCE_FLOATS * 4, gl.DYNAMIC_DRAW);
    for (const m of buildMeshes()) {
      const vao = r.vao(); gl.bindVertexArray(vao);
      r.buffer(gl.ARRAY_BUFFER, m.vertices); attribute(gl, 0, 3, 24, 0); attribute(gl, 1, 3, 24, 12);
      r.buffer(gl.ELEMENT_ARRAY_BUFFER, m.indices);
      this.meshes.push({ vao, count: m.indices.length });
    }
    this.particleVAO = r.vao(); gl.bindVertexArray(this.particleVAO);
    this.particles = r.buffer(gl.ARRAY_BUFFER, MAX_PARTICLES * PARTICLE_FLOATS * 4, gl.DYNAMIC_DRAW);
    for (let i = 0; i < 3; i++) attribute(gl, i, 4, PARTICLE_FLOATS * 4, i * 16, 1);
    this.blobVAO = r.vao(); gl.bindVertexArray(this.blobVAO);
    this.blobs = r.buffer(gl.ARRAY_BUFFER, MAX_BLOBS * 16, gl.DYNAMIC_DRAW); attribute(gl, 0, 4, 16, 0, 1);
    gl.bindVertexArray(this.emptyVAO);
    this.black = r.texture(); gl.bindTexture(gl.TEXTURE_2D, this.black);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    const program = (v: string, f: string, name: string) => r.program(v, f, name, hdr);
    this.programs = {
      mesh: program(shader.meshVertex, shader.meshFragment, "mesh"),
      shadow: program(shader.meshVertex, shader.depthFragment, "mesh-shadow"),
      ground: program(shader.groundVertex, shader.groundFragment, "ground"),
      blob: program(shader.blobVertex, shader.blobFragment, "blob"),
      sky: program(shader.skyVertex, shader.skyFragment, "sky"),
      particles: program(shader.particleVertex, shader.particleFragment, "particles"),
      post: program(shader.postVertex, shader.postFragment, "post"),
    };
    this.models = new WebGLModelDriver(this);
    this.ensureSize(canvas);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) { this.targets.forEach((t) => this.deleteTarget(t)); throw new Error(`WebGL initialization error 0x${error.toString(16)}`); }
    canvas.addEventListener("webglcontextlost", this.onContextLost);
  }

  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
    // A lost context invalidates all handles. Restart is explicit, never an endless retry.
    if (!this.disposed) this.onLost?.("The WebGL graphics context was lost");
  };

  private target(w: number, h: number, hdr: boolean, depth: boolean): Target {
    const gl = this.gl;
    const texture = gl.createTexture(), framebuffer = gl.createFramebuffer(), depthTexture = depth ? gl.createTexture() : null;
    const cleanup = () => { gl.deleteTexture(texture); gl.deleteFramebuffer(framebuffer); gl.deleteTexture(depthTexture); };
    if (!texture || !framebuffer || (depth && !depthTexture)) { cleanup(); throw new Error("WebGL render target allocation failed."); }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, hdr ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (depthTexture) {
      gl.bindTexture(gl.TEXTURE_2D, depthTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTexture, 0);
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER), error = gl.getError();
    if (status !== gl.FRAMEBUFFER_COMPLETE || error !== gl.NO_ERROR) { cleanup(); throw new Error(`WebGL render target unavailable (0x${status.toString(16)}, 0x${error.toString(16)}).`); }
    return { texture, framebuffer, depth: depthTexture, w, h };
  }
  private deleteTarget(t: Target) { this.gl.deleteFramebuffer(t.framebuffer); this.gl.deleteTexture(t.texture); this.gl.deleteTexture(t.depth); }
  private ensureSize(canvas: HTMLCanvasElement) {
    const dpr = Math.min(devicePixelRatio || 1, this.maxDpr);
    const limit = this.sizeLimit;
    let w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    const scale = Math.min(1, Math.sqrt(this.maxPixels / (w * h)), limit / w, limit / h);
    w = Math.max(1, Math.floor(w * scale)); h = Math.max(1, Math.floor(h * scale));
    if (w === this.size[0] && h === this.size[1]) return;
    this.targets.forEach((t) => this.deleteTarget(t)); this.targets = [];
    try {
      this.targets.push(this.target(w, h, this.capabilities.hdr, true));
      if (this.capabilities.bloom) {
        this.targets.push(this.target(Math.max(1, w >> 1), Math.max(1, h >> 1), true, false));
        this.targets.push(this.target(Math.max(1, w >> 1), Math.max(1, h >> 1), true, false));
      }
    } catch (e) { this.targets.forEach((t) => this.deleteTarget(t)); this.targets = []; throw e; }
    this.size = [w, h]; canvas.width = w; canvas.height = h;
  }
  get pixelSize(): [number, number] { return [...this.size]; }
  createModelDriver() { return this.models; }
  use(p: Program) {
    const gl = this.gl;
    gl.useProgram(p.handle);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.inShadow ? this.sunBuffer : this.frameBuffer);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.inShadow ? this.shadowDummy : this.shadowTexture);
  }

  render(canvas: HTMLCanvasElement, f: FrameData) {
    if (this.lost || this.disposed) return;
    this.ensureSize(canvas);
    const gl = this.gl, [w,h] = this.size;
    const style = writeFrame(this, f, w, h, this.shadowSize, this.frame);
    shadowFrame(this.frame, this.sunFrame);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameBuffer); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.frame);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.sunBuffer); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.sunFrame);
    const counts: number[] = [], offsets: number[] = [];
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    let used = 0;
    for (const b of f.batches) {
      const n = Math.max(0, Math.min(b.count, MAX_INSTANCES - used));
      counts.push(n); offsets.push(used * INSTANCE_FLOATS * 4);
      if (n) gl.bufferSubData(gl.ARRAY_BUFFER, used * INSTANCE_FLOATS * 4, b.data.subarray(0, n * INSTANCE_FLOATS));
      used += n;
    }
    const partN = Math.min(f.particleCount, MAX_PARTICLES), blobN = Math.min(f.blobCount, MAX_BLOBS);
    if (partN) { gl.bindBuffer(gl.ARRAY_BUFFER, this.particles); gl.bufferSubData(gl.ARRAY_BUFFER, 0, f.particles.subarray(0, partN * PARTICLE_FLOATS)); }
    if (blobN) { gl.bindBuffer(gl.ARRAY_BUFFER, this.blobs); gl.bufferSubData(gl.ARRAY_BUFFER, 0, f.blobs.subarray(0, blobN * 4)); }
    const meshes = (program: Program, ink: boolean) => {
      this.use(program); gl.uniform1i(program.uniform("inkPass"), Number(ink));
      counts.forEach((n, i) => {
        if (!n || !this.meshes[i]) return;
        const m = this.meshes[i]; gl.bindVertexArray(m.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
        for (let a = 0; a < 6; a++) attribute(gl, a + 2, 4, INSTANCE_FLOATS * 4, offsets[i] + a * 16, 1);
        gl.drawElementsInstanced(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0, n);
      });
    };
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    if (style.shadow > 0) {
      this.inShadow = true;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFramebuffer); gl.viewport(0,0,this.shadowSize,this.shadowSize);
      gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2.5, 2);
      meshes(this.programs.shadow, false);
      for (const hook of this.shadowHooks) hook();
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    this.inShadow = false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[0].framebuffer); gl.viewport(0,0,w,h);
    gl.depthMask(true); gl.depthFunc(gl.LESS); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    const scale = this.capabilities.hdr ? 1 : 0.25;
    gl.clearColor(this.background[0]*scale,this.background[1]*scale,this.background[2]*scale,1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.bindVertexArray(this.emptyVAO);
    if (this.ground.visible) { this.use(this.programs.ground); gl.drawArrays(gl.TRIANGLES,0,6); }
    gl.enable(gl.CULL_FACE);
    if (style.inkPx > 0) { gl.cullFace(gl.FRONT); meshes(this.programs.mesh, true); }
    gl.cullFace(gl.BACK); meshes(this.programs.mesh, false); gl.disable(gl.CULL_FACE);
    for (const hook of this.sceneHooks) hook();
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    if (blobN) { this.use(this.programs.blob); gl.bindVertexArray(this.blobVAO); gl.drawArraysInstanced(gl.TRIANGLES,0,6,blobN); }
    gl.disable(gl.BLEND); gl.bindVertexArray(this.emptyVAO);
    if (this.skyVisible) { this.use(this.programs.sky); gl.drawArrays(gl.TRIANGLES,0,3); }
    // Translucent surfaces over everything opaque and the sky (drivers set their own blend/depth state).
    if (this.translucentHooks.length) {
      for (const hook of this.translucentHooks) hook(f.camera.eye);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false); gl.disable(gl.CULL_FACE);
      gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA); gl.bindVertexArray(this.emptyVAO);
    }
    gl.enable(gl.BLEND);
    if (partN) { this.use(this.programs.particles); gl.bindVertexArray(this.particleVAO); gl.drawArraysInstanced(gl.TRIANGLES,0,6,partN); }
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.bindVertexArray(this.emptyVAO);
    const post = this.programs.post;
    this.use(post);
    const [scene, bloomA, bloomB] = this.targets;
    const pass = (target: Target | null, source: WebGLTexture, bloom: WebGLTexture, operation: number, dx = 0, dy = 0) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null); gl.viewport(0,0,target?.w ?? w,target?.h ?? h);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, source);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, bloom);
      // Unit 3 is the composite's scene depth (depth of field); every pass binds it, so nothing left there (a fresh render target) can feed back.
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, operation === 2 ? scene.depth : null);
      gl.uniform1i(post.uniform("operation"), operation); gl.uniform2f(post.uniform("blurDir"), dx, dy);
      gl.drawArrays(gl.TRIANGLES,0,3);
    };
    if (this.capabilities.bloom && style.bloom > 0) {
      pass(bloomA,scene.texture,this.black,0);
      for(let i=0;i<2;i++) { pass(bloomB,bloomA.texture,this.black,1,1/bloomA.w,0); pass(bloomA,bloomB.texture,this.black,1,0,1/bloomA.h); }
    }
    pass(null,scene.texture,this.capabilities.bloom && style.bloom > 0 ? bloomA.texture : this.black,2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.depthMask(true);
  }

  async finished() {
    const gl = this.gl;
    if (this.lost || this.disposed) throw new Error("WebGL context is unavailable.");
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) throw new Error("Could not create a WebGL completion fence.");
    gl.flush();
    const start = performance.now();
    try {
      for (;;) {
        const status = gl.clientWaitSync(sync, 0, 0);
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return;
        if (status === gl.WAIT_FAILED || gl.isContextLost() || performance.now() - start > 10000) throw new Error("WebGL frame completion failed.");
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally { gl.deleteSync(sync); }
  }
  dispose() {
    this.disposed = true; this.onLost = null;
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.targets.forEach((t) => this.deleteTarget(t)); this.targets = [];
    this.resources.dispose(); this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
