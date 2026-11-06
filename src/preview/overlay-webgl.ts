import type { WebGLRenderer } from "../gpu/webgl/renderer";
import { attribute, type Program } from "../gpu/webgl/resources";

const groundVS = `
uniform vec4 shadow; uniform vec4 params; out vec3 vWorld;
void main() { vec2 p=corners[gl_VertexID]*params.y; vWorld=vec3(p.x+shadow.x,params.w-0.002,p.y+shadow.y); gl_Position=project(vWorld); }`;
const groundFS = `
uniform vec4 shadow; uniform vec4 params; in vec3 vWorld; out vec4 color;
float gridLine(float x,float w) { float f=abs(fract(x+0.5)-0.5),aa=fwidth(x)*1.2; return 1.0-smoothstep(w-aa,w+aa,f); }
void main() {
  vec2 p=vWorld.xz; vec3 col=srgb(vec3(0.78,0.8,0.84));
  float d=length(p-shadow.xy)/params.y;
  col=mix(col,srgb(vec3(0.62,0.66,0.74)),smoothstep(0.35,1.0,d));
  if(params.x>0.5) {
    vec2 q=p+vec2(0,params.z);
    float minor=max(gridLine(q.x*4.0,0.02),gridLine(q.y*4.0,0.02))*0.25;
    float major=max(gridLine(q.x,0.012),gridLine(q.y,0.012));
    col=mix(col,srgb(vec3(0.42,0.46,0.56)),max(minor,major)*(1.0-smoothstep(0.5,1.0,d)));
    float ax=1.0-smoothstep(0.01,0.02,abs(p.y)),az=1.0-smoothstep(0.01,0.02,abs(p.x));
    col=mix(col,srgb(vec3(0.9,0.25,0.25)),ax*step(0.0,p.x)*0.8);
    col=mix(col,srgb(vec3(0.25,0.45,0.95)),az*step(0.0,p.y)*0.8);
  }
  float sd=length(p-shadow.xy)/max(shadow.z,0.01);
  col*=1.0-(1.0-smoothstep(0.2,1.0,sd))*shadow.w;
  vec3 n=vec3(0,1,0),l=normalize(F.sun.xyz);
  col*=hemi(n)*0.5+vec3(1,0.95,0.86)*F.sun.w*0.62*diffuseRamp(dot(n,l));
  color=sceneColor(col,1.0);
}`;
const backVS = `out vec2 vUV; void main() { vec2 q=fullscreen[gl_VertexID]; gl_Position=vec4(q,0.99998,1); vUV=q*0.5+0.5; }`;
const backFS = `in vec2 vUV; out vec4 color; void main() { color=sceneColor(mix(srgb(vec3(0.86,0.87,0.9)),srgb(vec3(0.55,0.66,0.84)),clamp(vUV.y,0.0,1.0))*1.05,1.0); }`;
const lineVS = `layout(location=0) in vec3 position; layout(location=1) in vec4 tint; out vec4 vColor; void main() { gl_Position=project(position); vColor=tint; }`;
const lineFS = `in vec4 vColor; out vec4 color; void main() { color=sceneColor(vColor.rgb*2.0,1.0); }`;

export class WebGLOverlay {
  private ground: Program; private back: Program; private line: Program;
  private empty: WebGLVertexArrayObject; private vao: WebGLVertexArrayObject; private buffer: WebGLBuffer;
  private count = 0;
  private data = new Float32Array(8);
  constructor(private renderer: WebGLRenderer) {
    const {gl,resources:r,capabilities:c}=renderer;
    this.ground=r.program(groundVS,groundFS,"preview-ground",c.hdr);
    this.back=r.program(backVS,backFS,"preview-background",c.hdr);
    this.line=r.program(lineVS,lineFS,"preview-lines",c.hdr);
    this.empty=r.vao(); this.vao=r.vao(); gl.bindVertexArray(this.vao);
    this.buffer=r.buffer(gl.ARRAY_BUFFER,8192*7*4,gl.DYNAMIC_DRAW);
    attribute(gl,0,3,28,0); attribute(gl,1,4,28,12); gl.bindVertexArray(null);
  }
  upload(ground: Float32Array, lines: Float32Array, count: number) {
    this.data.set(ground); this.count=count;
    const gl=this.renderer.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    if(count) gl.bufferSubData(gl.ARRAY_BUFFER,0,lines.subarray(0,count*7));
  }
  drawGround() {
    const gl=this.renderer.gl;
    this.renderer.use(this.ground);
    gl.bindVertexArray(this.empty); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    gl.uniform4fv(this.ground.uniform("shadow"),this.data.subarray(0,4)); gl.uniform4fv(this.ground.uniform("params"),this.data.subarray(4,8));
    gl.drawArrays(gl.TRIANGLES,0,6);
  }
  drawBackground() {
    const gl=this.renderer.gl;
    this.renderer.use(this.back); gl.bindVertexArray(this.empty); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(false); gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLES,0,3);
  }
  drawLines() {
    if(!this.count) return;
    const gl=this.renderer.gl;
    this.renderer.use(this.line); gl.bindVertexArray(this.vao); gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    gl.drawArrays(gl.LINES,0,this.count); gl.bindVertexArray(null);
  }
}
