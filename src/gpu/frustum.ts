// View-frustum tests for culling whole groups of geometry (chunks, models, instance batches) before they are drawn.
// The engine does not cull for you: a game that streams many objects tests each group's world bounds here.

/**
 * The six planes (a, b, c, d) of a column-major view-projection with WebGPU's [0, 1] clip depth (what `Camera`
 * and `OrbitCamera` build for both backends), normalised; a point is inside when a·x + b·y + c·z + d ≥ 0 for all six.
 * Order: left, right, bottom, top, near, far.
 */
export function frustumPlanes(m: ArrayLike<number>, out = new Float32Array(24)): Float32Array {
  const row = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
  const planes = [
    r3.map((v, i) => v + r0[i]), r3.map((v, i) => v - r0[i]), // left, right
    r3.map((v, i) => v + r1[i]), r3.map((v, i) => v - r1[i]), // bottom, top
    r2, r3.map((v, i) => v - r2[i]), // near (z ≥ 0), far
  ];
  planes.forEach((p, k) => {
    const len = Math.hypot(p[0], p[1], p[2]) || 1;
    out.set([p[0] / len, p[1] / len, p[2] / len, p[3] / len], k * 4);
  });
  return out;
}

/** True when an axis-aligned world box touches the frustum. Conservative: a box just outside a corner may still pass. */
export function boxInFrustum(planes: ArrayLike<number>, min: ArrayLike<number>, max: ArrayLike<number>): boolean {
  for (let k = 0; k < 6; k++) {
    const a = planes[k * 4], b = planes[k * 4 + 1], c = planes[k * 4 + 2], d = planes[k * 4 + 3];
    // The box corner furthest along the plane normal.
    const x = a >= 0 ? max[0] : min[0], y = b >= 0 ? max[1] : min[1], z = c >= 0 ? max[2] : min[2];
    if (a * x + b * y + c * z + d < 0) return false;
  }
  return true;
}
