// Shared preview geometry; drawing remains private to the chosen backend.
import type { Renderer } from "../gpu/renderer";
import type { WebGPURenderer } from "../gpu/webgpu-renderer";
import type { WebGLRenderer } from "../gpu/webgl/renderer";
import { WebGPUOverlay } from "./overlay-webgpu";
import { WebGLOverlay } from "./overlay-webgl";
const MAX_LINE_VERTS = 8192;
export class Overlay {
  private lines = new Float32Array(MAX_LINE_VERTS * 7);
  private lineCount = 0;
  groundData = new Float32Array([0, 0, 0.5, 0.45, 1, 30, 0, 0]);
  private driver: WebGPUOverlay | WebGLOverlay;
  constructor(renderer: Renderer) {
    this.driver = renderer.backend === "webgpu" ? new WebGPUOverlay(renderer as WebGPURenderer) : new WebGLOverlay(renderer as WebGLRenderer);
  }
  clearLines() {
    this.lineCount = 0;
  }

  line(a: ArrayLike<number>, b: ArrayLike<number>, color: [number, number, number]) {
    if (this.lineCount + 2 > MAX_LINE_VERTS) return;
    const o = this.lineCount * 7;
    this.lines.set([a[0], a[1], a[2], color[0], color[1], color[2], 1, b[0], b[1], b[2], color[0], color[1], color[2], 1], o);
    this.lineCount += 2;
  }

  /** Local axes of a column-major world matrix: X red, Y green, Z blue. */
  axes(m: ArrayLike<number>, size: number) {
    const o = [m[12], m[13], m[14]];
    const ax = (c: number) => {
      const l = Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]) || 1;
      return [o[0] + (m[c * 4] / l) * size, o[1] + (m[c * 4 + 1] / l) * size, o[2] + (m[c * 4 + 2] / l) * size];
    };
    this.line(o, ax(0), [1, 0.2, 0.2]);
    this.line(o, ax(1), [0.2, 1, 0.3]);
    this.line(o, ax(2), [0.3, 0.5, 1]);
  }

  box(min: ArrayLike<number>, max: ArrayLike<number>, color: [number, number, number]) {
    const c = (i: number): [number, number, number] => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
    for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) this.line(c(a), c(b), color);
  }

  /** Upload data; call before renderer.render(). */
  prepare(showGrid: boolean, groundSize: number, travel: number, groundY = 0) {
    this.groundData[4] = showGrid ? 1 : 0;
    this.groundData[5] = groundSize;
    this.groundData[6] = travel;
    this.groundData[7] = groundY;
    this.driver.upload(this.groundData, this.lines, this.lineCount);
  }
  drawGround() { this.driver.drawGround(); }
  drawBackground() { this.driver.drawBackground(); }
  drawLines() { this.driver.drawLines(); }
}
