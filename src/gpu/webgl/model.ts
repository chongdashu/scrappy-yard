import { alphaModeOf, ALPHA_MODE, MAT_FLOATS, type GpuModel, type GpuResourceCounts, type ModelDriver, type ModelGeometry, type TranslucentDraw } from "../model";
import type { WebGLRenderer } from "./renderer";
import { attribute, type Program } from "./resources";
import { modelVertex, modelFragment, depthFragment, depthMaskFragment } from "./shaders";
import { DEFAULT_GLTF_SAMPLER, type GltfSampler } from "../../gltf/glb";
import { anisotropyFor, samplerKey } from "../sampler";

type Texture = { handle: WebGLTexture; width: number; height: number };
/** One uploaded image + sampler (WebGL keeps sampling on the texture), shared by every material and model using that pair; `refs` counts source models. */
type SharedTexture = { image: ImageBitmap; key: string; tex: Texture; refs: number };
type ModelResources = {
  joints: WebGLTexture; textures: (Texture | null)[]; active: (Texture | null)[]; spares: Map<number, Texture>; ownsTextures: boolean;
  /** The shared textures this source model holds one reference to each (empty for an instance). */
  held: SharedTexture[];
};

export class WebGLModelDriver implements ModelDriver {
  private geometry = new WeakMap<ModelGeometry, WebGLVertexArrayObject>();
  /** The buffers behind each geometry's vertex array (freed with it by `release`). */
  private buffers = new WeakMap<ModelGeometry, { handle: WebGLBuffer; bytes: number }[]>();
  /** Live buffers and textures this driver made and has not deleted (leak checks: see release and resources). */
  private live = { buffers: 0, textures: 0, bytes: 0 };
  /** Uploaded textures by image, then by sampler: an atlas used by many materials, or by several uploads of one doc, goes up once per sampler. */
  private shared = new Map<ImageBitmap, Map<string, SharedTexture>>();
  private models = new WeakMap<GpuModel, ModelResources>();
  private fill: Program;
  private depth: Program;
  private depthMask: Program;
  private white: WebGLTexture;
  constructor(private renderer: WebGLRenderer) {
    const { gl, resources: r, capabilities } = renderer;
    this.fill = r.program(modelVertex, modelFragment, "model", capabilities.hdr);
    this.depth = r.program(modelVertex, depthFragment, "model-shadow", capabilities.hdr);
    this.depthMask = r.program(modelVertex, depthMaskFragment, "model-shadow-mask", capabilities.hdr);
    this.white = r.texture();
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255,255,255,255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }

  upload(model: GpuModel, source: GpuModel | null) {
    const { gl, resources: r } = this.renderer;
    for (const p of model.primitives) {
      const g = p.geometry;
      if (this.geometry.has(g)) continue;
      const vao = r.vao();
      gl.bindVertexArray(vao);
      const made: { handle: WebGLBuffer; bytes: number }[] = [];
      const buffer = (target: number, data: ArrayBufferView) => {
        made.push({ handle: r.buffer(target, data), bytes: data.byteLength });
      };
      buffer(gl.ARRAY_BUFFER, g.vertices);
      attribute(gl, 0, 3, 32, 0); attribute(gl, 1, 3, 32, 12); attribute(gl, 2, 2, 32, 24);
      buffer(gl.ARRAY_BUFFER, g.hull); attribute(gl, 5, 3, 12, 0);
      if (g.skin) {
        buffer(gl.ARRAY_BUFFER, g.skin);
        gl.enableVertexAttribArray(3); gl.vertexAttribIPointer(3, 4, gl.UNSIGNED_SHORT, 24, 0);
        attribute(gl, 4, 4, 24, 8);
      }
      buffer(gl.ELEMENT_ARRAY_BUFFER, g.indices);
      this.buffers.set(g, made);
      this.live.buffers += made.length;
      this.live.bytes += made.reduce((a, b) => a + b.bytes, 0);
      this.geometry.set(g, vao);
    }
    gl.bindVertexArray(null);
    const height = model.joints.length / 16;
    if (height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error(`Model has too many joints (${height}) for WebGL 2.`);
    const joints = r.texture();
    this.live.textures++;
    gl.bindTexture(gl.TEXTURE_2D, joints);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, height, 0, gl.RGBA, gl.FLOAT, model.joints);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // WebGL keeps filtering and wrapping on the texture object, so textures are shared per image and sampler. A source model takes one
    // reference to each it uses (an instance shares its source's).
    const held: SharedTexture[] = [];
    const textures = source ? this.models.get(source)!.textures : model.doc.materials.map((m) => {
      if (!m.texture) return null;
      const sampler = m.sampler ?? DEFAULT_GLTF_SAMPLER, key = samplerKey(sampler);
      let variants = this.shared.get(m.texture);
      if (!variants) this.shared.set(m.texture, (variants = new Map()));
      let entry = variants.get(key);
      if (!entry) variants.set(key, (entry = { image: m.texture, key, tex: this.texture(m.texture, sampler), refs: 0 }));
      if (!held.includes(entry)) { held.push(entry); entry.refs++; }
      return entry.tex;
    });
    this.models.set(model, { joints, textures, active: [...textures], spares: new Map(), ownsTextures: !source, held });
  }

  /**
   * Delete models' textures and buffers: a source model's geometry goes with it, and each image texture once no other source model uses it (so release a
   * source only with its instances), an instance's own joint texture goes alone (it shares the source's geometry and textures).
   */
  release(models: readonly GpuModel[]): void {
    const { gl, resources: r } = this.renderer;
    gl.bindVertexArray(null);
    for (const model of models) {
      const m = this.models.get(model);
      if (!m) continue;
      if (m.ownsTextures) {
        for (const p of model.primitives) {
          const vao = this.geometry.get(p.geometry);
          if (!vao) continue;
          r.release(vao);
          for (const b of this.buffers.get(p.geometry) ?? []) {
            r.release(b.handle);
            this.live.buffers--;
            this.live.bytes -= b.bytes;
          }
          this.buffers.delete(p.geometry);
          this.geometry.delete(p.geometry);
        }
        // Shared textures go with the last source model holding them.
        for (const entry of m.held) {
          if (--entry.refs > 0) continue;
          r.release(entry.tex.handle);
          this.live.textures--;
          const variants = this.shared.get(entry.image)!;
          variants.delete(entry.key);
          if (!variants.size) this.shared.delete(entry.image);
        }
      }
      r.release(m.joints);
      this.live.textures--;
      for (const t of m.spares.values()) { r.release(t.handle); this.live.textures--; }
      this.models.delete(model);
    }
  }

  resources(): GpuResourceCounts {
    return { ...this.live };
  }
  update(model: GpuModel) {
    const gl = this.renderer.gl;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.models.get(model)!.joints);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4, model.joints.length / 16, gl.RGBA, gl.FLOAT, model.joints);
  }
  private texture(image: ImageBitmap | OffscreenCanvas, sampler: GltfSampler = DEFAULT_GLTF_SAMPLER): Texture {
    const handle = this.renderer.resources.texture();
    this.live.textures++;
    this.writeTexture(handle, image, sampler);
    return { handle, width: image.width, height: image.height };
  }
  /** Upload an image with a mip chain and the sampler's filters and wraps (glTF uses WebGL's enums, so they apply as they are). */
  private writeTexture(handle: WebGLTexture, image: ImageBitmap | OffscreenCanvas, sampler: GltfSampler = DEFAULT_GLTF_SAMPLER) {
    const gl = this.renderer.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, handle);
    // glTF UVs/image rows match the WebGPU upload: do not flip or premultiply.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sampler.minFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sampler.magFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, sampler.wrapS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, sampler.wrapT);
    const ext = gl.getExtension("EXT_texture_filter_anisotropic");
    if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(anisotropyFor(sampler), gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }
  retexture(model: GpuModel, material: number, image: ImageBitmap | OffscreenCanvas | null) {
    const r = this.models.get(model)!;
    if (!r.textures[material]) return;
    if (!image) { r.active[material] = r.textures[material]; return; }
    let spare = r.spares.get(material);
    const sampler = model.doc.materials[material].sampler; // a replacement image is sampled like the file's
    if (!spare) { spare = this.texture(image, sampler); r.spares.set(material, spare); }
    else { this.writeTexture(spare.handle, image, sampler); spare.width = image.width; spare.height = image.height; }
    r.active[material] = spare;
  }
  /** Opaque and MASK primitives: ink then fill, or the shadow casters (plain, then MASK cut-outs with their texture). BLEND waits for drawTranslucent. */
  draw(models: readonly GpuModel[], outline: boolean, shadow: boolean) {
    const { gl } = this.renderer;
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
    const total = { draws: 0, triangles: 0 };
    const passes = shadow ? ["shadow", "shadowMask"] as const : outline ? ["ink", "fill"] as const : ["fill"] as const;
    for (const pass of passes) {
      const p = pass === "shadow" ? this.depth : pass === "shadowMask" ? this.depthMask : this.fill;
      this.renderer.use(p);
      if (pass === "ink") { gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT); } else gl.disable(gl.CULL_FACE);
      gl.uniform1i(p.uniform("inkPass"), Number(pass === "ink"));
      gl.uniform1i(p.uniform("blendPass"), 0);
      for (const model of models) {
        this.bindModel(p, model);
        model.primitives.forEach((primitive, i) => {
          if (model.hidden[primitive.node]) return;
          const mode = alphaModeOf(model, i);
          if (mode === ALPHA_MODE.BLEND || (pass === "shadow" && mode === ALPHA_MODE.MASK) || (pass === "shadowMask" && mode !== ALPHA_MODE.MASK)) return;
          this.drawPrimitive(p, model, i, pass !== "shadow", total);
        });
      }
    }
    gl.bindVertexArray(null); gl.disable(gl.CULL_FACE);
    return total;
  }

  /** BLEND primitives in the order given (back to front): premultiplied, depth test on, depth write off, both faces. */
  drawTranslucent(items: readonly TranslucentDraw[]) {
    const { gl } = this.renderer;
    const p = this.fill;
    this.renderer.use(p);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(false); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(p.uniform("inkPass"), 0);
    gl.uniform1i(p.uniform("blendPass"), 1);
    const total = { draws: 0, triangles: 0 };
    let bound: GpuModel | null = null;
    for (const { model, primitive } of items) {
      if (!this.models.has(model)) continue;
      if (bound !== model) { this.bindModel(p, model); bound = model; }
      this.drawPrimitive(p, model, primitive, true, total);
    }
    gl.uniform1i(p.uniform("blendPass"), 0);
    gl.disable(gl.BLEND); gl.depthMask(true); gl.bindVertexArray(null);
    return total;
  }

  private bindModel(p: Program, model: GpuModel) {
    const gl = this.renderer.gl;
    gl.uniform4fv(p.uniform("params"), model.params);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.models.get(model)!.joints);
  }

  private drawPrimitive(p: Program, model: GpuModel, i: number, material: boolean, total: { draws: number; triangles: number }) {
    const gl = this.renderer.gl;
    const primitive = model.primitives[i];
    const n = primitive.node;
    const m = model.draws[i * 4 + 1] * MAT_FLOATS;
    gl.bindVertexArray(this.geometry.get(primitive.geometry)!);
    // Disabled integer attributes require an integer generic value too.
    if (!primitive.geometry.skin) { gl.vertexAttribI4ui(3, 0, 0, 0, 0); gl.vertexAttrib4f(4, 1, 0, 0, 0); }
    gl.uniform1i(p.uniform("skinned"), Number(primitive.skinned));
    gl.uniformMatrix4fv(p.uniform("node"), false, model.world.subarray(n * 16, n * 16 + 16));
    gl.uniform1f(p.uniform("nodeFlash"), model.nodes[n * 20 + 16]);
    gl.uniform1f(p.uniform("kind"), model.materials[m + 9]); // vertex motion, in every pass
    if (material) {
      gl.uniform4fv(p.uniform("base"), model.materials.subarray(m, m + 4));
      gl.uniform4fv(p.uniform("emissive"), model.materials.subarray(m + 4, m + 8));
      gl.uniform1f(p.uniform("gloss"), model.materials[m + 8]);
      gl.uniform1f(p.uniform("alphaMode"), model.materials[m + 10]);
      gl.uniform1f(p.uniform("cutoff"), model.materials[m + 11]);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.models.get(model)!.active[primitive.material]?.handle ?? this.white);
    }
    gl.drawElements(gl.TRIANGLES, primitive.indexCount, gl.UNSIGNED_INT, 0);
    total.draws++; total.triangles += primitive.indexCount / 3;
  }
}
