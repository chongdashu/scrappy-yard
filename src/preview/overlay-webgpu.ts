import commonSrc from "../gpu/shaders/common.wgsl?raw";
import type { WebGPURenderer } from "../gpu/webgpu-renderer";
const SHADER = /* wgsl */ `
struct Ground {
  shadow: vec4f,  // xz centre, radius, opacity
  params: vec4f,  // x grid visible, y ground half-size, z travel offset, w ground height
};
@group(1) @binding(0) var<uniform> G: Ground;

struct GOut { @builtin(position) pos: vec4f, @location(0) world: vec3f };

@vertex fn vsGround(@builtin(vertex_index) vi: u32) -> GOut {
  var c = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let p = c[vi] * G.params.y;
  var o: GOut;
  o.world = vec3f(p.x + G.shadow.x, G.params.w - 0.002, p.y + G.shadow.y);
  o.pos = F.viewProj * vec4f(o.world, 1.0);
  return o;
}

fn gridLine(x: f32, w: f32) -> f32 {
  let f = abs(fract(x + 0.5) - 0.5);
  let aa = fwidth(x) * 1.2;
  return 1.0 - smoothstep(w - aa, w + aa, f);
}

@fragment fn fsGround(in: GOut) -> @location(0) vec4f {
  let p = in.world.xz;
  var col = srgb(vec3f(0.78, 0.8, 0.84));
  // Soft falloff to the backdrop.
  let d = length(p - G.shadow.xy) / G.params.y;
  col = mix(col, srgb(vec3f(0.62, 0.66, 0.74)), smoothstep(0.35, 1.0, d));
  if (G.params.x > 0.5) {
    let q = p + vec2f(0.0, G.params.z);
    let minor = max(gridLine(q.x * 4.0, 0.02), gridLine(q.y * 4.0, 0.02)) * 0.25;
    let major = max(gridLine(q.x, 0.012), gridLine(q.y, 0.012));
    col = mix(col, srgb(vec3f(0.42, 0.46, 0.56)), max(minor, major) * (1.0 - smoothstep(0.5, 1.0, d)));
    // Axis lines: +X red, +Z blue (front of assets faces +Z).
    let ax = 1.0 - smoothstep(0.01, 0.02, abs(p.y));
    let az = 1.0 - smoothstep(0.01, 0.02, abs(p.x));
    col = mix(col, srgb(vec3f(0.9, 0.25, 0.25)), ax * step(0.0, p.x) * 0.8);
    col = mix(col, srgb(vec3f(0.25, 0.45, 0.95)), az * step(0.0, p.y) * 0.8);
  }
  let sd = length(p - G.shadow.xy) / max(G.shadow.z, 0.01);
  col *= 1.0 - (1.0 - smoothstep(0.2, 1.0, sd)) * G.shadow.w;
  let n = vec3f(0.0, 1.0, 0.0);
  let l = normalize(F.sun.xyz);
  col *= hemi(n) * 0.5 + vec3f(1.0, 0.95, 0.86) * F.sun.w * 0.62 * diffuseRamp(dot(n, l));
  return vec4f(col, 1.0);
}

struct BOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vsBack(@builtin(vertex_index) vi: u32) -> BOut {
  var q = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: BOut;
  o.pos = vec4f(q[vi], 0.99999, 1.0);
  o.uv = q[vi] * 0.5 + 0.5;
  return o;
}
@fragment fn fsBack(in: BOut) -> @location(0) vec4f {
  let top = srgb(vec3f(0.55, 0.66, 0.84));
  let bottom = srgb(vec3f(0.86, 0.87, 0.9));
  return vec4f(mix(bottom, top, clamp(in.uv.y, 0.0, 1.0)) * 1.05, 1.0);
}

struct LIn { @location(0) pos: vec3f, @location(1) color: vec4f };
struct LOut { @builtin(position) pos: vec4f, @location(0) color: vec4f };
@vertex fn vsLine(v: LIn) -> LOut {
  var o: LOut;
  o.pos = F.viewProj * vec4f(v.pos, 1.0);
  o.color = v.color;
  return o;
}
@fragment fn fsLine(in: LOut) -> @location(0) vec4f {
  return vec4f(in.color.rgb * 2.0, 1.0);
}
`;

export class WebGPUOverlay {
  private ground: GPURenderPipeline;
  private back: GPURenderPipeline;
  private lineTop: GPURenderPipeline;
  private groundBuf: GPUBuffer;
  private groundGroup: GPUBindGroup;
  private lineBuf: GPUBuffer;
  private lineCount = 0;
  constructor(private renderer: WebGPURenderer) {
    const d = renderer.device;
    const module = d.createShaderModule({ label: "preview-overlay", code: commonSrc + "\n" + SHADER });
    module.getCompilationInfo().then((info) => {
      for (const m of info.messages) if (m.type === "error") console.error(`[wgsl overlay] ${m.lineNum}:${m.linePos} ${m.message}`);
    });
    const groundLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }] });
    this.groundBuf = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.groundGroup = d.createBindGroup({ layout: groundLayout, entries: [{ binding: 0, resource: { buffer: this.groundBuf } }] });
    const target = [{ format: renderer.hdrFormat }];
    this.ground = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout, groundLayout] }),
      vertex: { module, entryPoint: "vsGround" },
      fragment: { module, entryPoint: "fsGround", targets: target },
      depthStencil: { format: renderer.depthFormat, depthWriteEnabled: true, depthCompare: "less" },
    });
    const layout0 = d.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout] });
    this.back = d.createRenderPipeline({
      layout: layout0,
      vertex: { module, entryPoint: "vsBack" },
      fragment: { module, entryPoint: "fsBack", targets: target },
      depthStencil: { format: renderer.depthFormat, depthWriteEnabled: false, depthCompare: "less" },
    });
    this.lineTop = d.createRenderPipeline({
      layout: layout0,
      vertex: {
        module,
        entryPoint: "vsLine",
        buffers: [{ arrayStride: 28, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x4" }] }],
      },
      fragment: { module, entryPoint: "fsLine", targets: target },
      primitive: { topology: "line-list" },
      depthStencil: { format: renderer.depthFormat, depthWriteEnabled: false, depthCompare: "always" },
    });
    this.lineBuf = d.createBuffer({ size: 8192 * 7 * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  }

  upload(ground: Float32Array, lines: Float32Array, count: number) {
    this.lineCount = count;
    this.renderer.device.queue.writeBuffer(this.groundBuf, 0, ground);
    if (count) this.renderer.device.queue.writeBuffer(this.lineBuf, 0, lines, 0, count * 7);
  }
  drawGround() {
    const pass = this.renderer.pass;
    pass.setBindGroup(0, this.renderer.frameBindGroup);
    pass.setPipeline(this.ground);
    pass.setBindGroup(1, this.groundGroup);
    pass.draw(6);
  }

  drawBackground() {
    const pass = this.renderer.pass;
    pass.setBindGroup(0, this.renderer.frameBindGroup);
    pass.setPipeline(this.back);
    pass.draw(3);
  }

  drawLines() {
    const pass = this.renderer.pass;
    pass.setBindGroup(0, this.renderer.frameBindGroup);
    if (!this.lineCount) return;
    pass.setPipeline(this.lineTop);
    pass.setVertexBuffer(0, this.lineBuf);
    pass.draw(this.lineCount);
  }
}
