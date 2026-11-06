// Procedural placeholder meshes (position + normal) and per-mesh instance batches.
import { mat4 } from "../math";

export interface MeshData {
  vertices: Float32Array; // px py pz nx ny nz
  indices: Uint16Array;
}

export const INSTANCE_FLOATS = 24; // mat4 + color(rgb, gloss) + params(flash, outline, rim, emissive)

function box(): MeshData {
  const v: number[] = [];
  const idx: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, w] of faces) {
    const base = v.length / 6;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      v.push(
        0.5 * (n[0] + a * u[0] + b * w[0]),
        0.5 * (n[1] + a * u[1] + b * w[1]),
        0.5 * (n[2] + a * u[2] + b * w[2]),
        n[0], n[1], n[2],
      );
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/** Unit-diameter sphere centred at the origin; `dome` keeps the top half. */
function sphere(seg = 20, rings = 14, dome = false): MeshData {
  const v: number[] = [];
  const idx: number[] = [];
  const maxRing = dome ? rings / 2 : rings;
  for (let r = 0; r <= maxRing; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= seg; s++) {
      const th = (s / seg) * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(th);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(th);
      v.push(x * 0.5, y * 0.5, z * 0.5, x, y, z);
    }
  }
  for (let r = 0; r < maxRing; r++) {
    for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s;
      const b = a + seg + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  if (dome) {
    // Close the dome with a flat bottom.
    const c = v.length / 6;
    v.push(0, 0, 0, 0, -1, 0);
    const ringStart = maxRing * (seg + 1);
    for (let s = 0; s < seg; s++) {
      const a = ringStart + s;
      const p = v.slice(a * 6, a * 6 + 3);
      v.push(p[0], 0, p[2], 0, -1, 0);
    }
    for (let s = 0; s < seg; s++) {
      const a = c + 1 + s;
      const b = c + 1 + ((s + 1) % seg);
      idx.push(c, a, b); // faces −Y
    }
  }
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

/** Unit cylinder/cone along +Y from y=0 to y=1, radius 0.5 (top radius scaled). */
function cylinder(seg = 20, topScale = 1): MeshData {
  const v: number[] = [];
  const idx: number[] = [];
  const slope = 0.5 * (1 - topScale);
  for (let s = 0; s <= seg; s++) {
    const th = (s / seg) * Math.PI * 2;
    const c = Math.cos(th), sn = Math.sin(th);
    const n = [c, slope, sn];
    const l = Math.hypot(n[0], n[1], n[2]);
    v.push(c * 0.5, 0, sn * 0.5, n[0] / l, n[1] / l, n[2] / l);
    v.push(c * 0.5 * topScale, 1, sn * 0.5 * topScale, n[0] / l, n[1] / l, n[2] / l);
  }
  for (let s = 0; s < seg; s++) {
    const a = s * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  for (const [y, ny, sc] of [[0, -1, 1], [1, 1, topScale]] as const) {
    if (sc <= 0.001) continue;
    const c = v.length / 6;
    v.push(0, y, 0, 0, ny, 0);
    for (let s = 0; s < seg; s++) {
      const th = (s / seg) * Math.PI * 2;
      v.push(Math.cos(th) * 0.5 * sc, y, Math.sin(th) * 0.5 * sc, 0, ny, 0);
    }
    for (let s = 0; s < seg; s++) {
      const a = c + 1 + s, b = c + 1 + ((s + 1) % seg);
      if (ny > 0) idx.push(c, b, a);
      else idx.push(c, a, b);
    }
  }
  return { vertices: new Float32Array(v), indices: new Uint16Array(idx) };
}

export const MESH = { box: 0, sphere: 1, dome: 2, cylinder: 3, cone: 4 } as const;
export type MeshId = (typeof MESH)[keyof typeof MESH];

export function buildMeshes(): MeshData[] {
  return [box(), sphere(), sphere(20, 14, true), cylinder(), cylinder(18, 0)];
}

export class InstanceBatch {
  data: Float32Array;
  count = 0;
  constructor(public capacity: number) {
    this.data = new Float32Array(capacity * INSTANCE_FLOATS);
  }
  reset() {
    this.count = 0;
  }
  /** Push an instance; returns its float offset for tweaks. */
  push(
    px: number, py: number, pz: number,
    yaw: number, pitch: number, roll: number,
    sx: number, sy: number, sz: number,
    color: [number, number, number], gloss = 0.4,
    flash = 0, outline = 1, rim = 1, emissive = 0,
  ): number {
    if (this.count >= this.capacity) return -1;
    const o = this.count * INSTANCE_FLOATS;
    mat4.compose(this.data, o, px, py, pz, yaw, pitch, roll, sx, sy, sz);
    this.data[o + 16] = color[0];
    this.data[o + 17] = color[1];
    this.data[o + 18] = color[2];
    this.data[o + 19] = gloss;
    this.data[o + 20] = flash;
    this.data[o + 21] = outline;
    this.data[o + 22] = rim;
    this.data[o + 23] = emissive;
    this.count++;
    return o;
  }
  /** Push with an explicit column-major matrix. */
  pushMatrix(m: Float32Array, color: [number, number, number], gloss = 0.4, flash = 0, outline = 1, rim = 1, emissive = 0) {
    if (this.count >= this.capacity) return;
    const o = this.count * INSTANCE_FLOATS;
    this.data.set(m, o);
    this.data[o + 16] = color[0];
    this.data[o + 17] = color[1];
    this.data[o + 18] = color[2];
    this.data[o + 19] = gloss;
    this.data[o + 20] = flash;
    this.data[o + 21] = outline;
    this.data[o + 22] = rim;
    this.data[o + 23] = emissive;
    this.count++;
  }
}

/** sRGB hex → linear rgb triple for instance colors. */
export function hex(h: number): [number, number, number] {
  const c = (v: number) => Math.pow(v / 255, 2.2);
  return [c((h >> 16) & 255), c((h >> 8) & 255), c(h & 255)];
}
