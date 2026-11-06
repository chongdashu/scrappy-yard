import common from "./common.glsl?raw";

export class Program {
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  constructor(readonly gl: WebGL2RenderingContext, readonly handle: WebGLProgram) {}
  uniform(name: string) {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.handle, name));
    return this.uniforms.get(name)!;
  }
}

/** Own every allocation, including partial initialization, so failed boot can release it. */
export class Resources {
  /** Each allocation's destroy call, in the order made (a Map so one can be freed early with `release`). */
  private cleanup = new Map<unknown, () => void>();
  constructor(readonly gl: WebGL2RenderingContext) {}
  own<T>(value: T | null, destroy: (value: T) => void): T {
    if (!value) throw new Error("WebGL allocation failed.");
    this.cleanup.set(value, () => destroy(value));
    return value;
  }
  /** Free one allocation now (a scene that is left): it is deleted once, and `dispose` will not delete it again. */
  release(value: unknown) {
    const destroy = this.cleanup.get(value);
    if (!destroy) return;
    this.cleanup.delete(value);
    destroy();
  }
  buffer(target: number, data: ArrayBufferView | number, usage: number = this.gl.STATIC_DRAW): WebGLBuffer {
    const gl = this.gl;
    const b = this.own(gl.createBuffer(), (v) => gl.deleteBuffer(v));
    gl.bindBuffer(target, b);
    if (typeof data === "number") gl.bufferData(target, data, usage);
    else gl.bufferData(target, data, usage);
    return b;
  }
  vao() { return this.own(this.gl.createVertexArray(), (v) => this.gl.deleteVertexArray(v)); }
  texture() { return this.own(this.gl.createTexture(), (v) => this.gl.deleteTexture(v)); }
  framebuffer() { return this.own(this.gl.createFramebuffer(), (v) => this.gl.deleteFramebuffer(v)); }
  renderbuffer() { return this.own(this.gl.createRenderbuffer(), (v) => this.gl.deleteRenderbuffer(v)); }
  program(vertex: string, fragment: string, label: string, hdr: boolean): Program {
    const gl = this.gl;
    const header = `#version 300 es\nprecision highp float;\nprecision highp int;\n#define SCENE_SCALE ${hdr ? "1.0" : "0.25"}\n${common}\n`;
    const shaders: WebGLShader[] = [];
    const p = this.own(gl.createProgram(), (v) => gl.deleteProgram(v));
    try {
      for (const [type, body] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error(`WebGL ${label}: shader allocation failed`);
        shaders.push(shader);
        gl.shaderSource(shader, header + body);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`GLSL ${label}: ${gl.getShaderInfoLog(shader)}`);
        gl.attachShader(p, shader);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`GLSL ${label}: ${gl.getProgramInfoLog(p)}`);
      const block = gl.getUniformBlockIndex(p, "Frame");
      if (block !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, block, 0);
      const result = new Program(gl, p);
      gl.useProgram(p);
      for (const [name, unit] of [["shadowTex", 0], ["baseTex", 1], ["jointTex", 2], ["sourceTex", 1], ["bloomTex", 2], ["depthTex", 3]] as const) gl.uniform1i(result.uniform(name), unit);
      return result;
    } finally { for (const shader of shaders) { gl.detachShader(p, shader); gl.deleteShader(shader); } }
  }
  dispose() { for (const destroy of [...this.cleanup.values()].reverse()) destroy(); this.cleanup.clear(); }
}

export function attribute(gl: WebGL2RenderingContext, location: number, size: number, stride: number, offset: number, divisor = 0) {
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
  gl.vertexAttribDivisor(location, divisor);
}
