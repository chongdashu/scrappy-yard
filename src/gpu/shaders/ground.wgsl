// The ground plane (an endless blockout floor under the level, with an
// optional metre grid) and soft blob contact shadows.

struct GOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
};

@vertex
fn vsGround(@builtin(vertex_index) vi: u32) -> GOut {
  var c = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  // A 400 m square that follows the camera (snapped to whole metres so the grid stays put).
  let centre = floor(F.eye.xz);
  let p = centre + c[vi] * 200.0;
  var o: GOut;
  o.world = vec3f(p.x, F.ground.w, p.y);
  o.pos = F.viewProj * vec4f(o.world, 1.0);
  return o;
}

fn gridLine(x: f32, w: f32) -> f32 {
  let f = abs(fract(x + 0.5) - 0.5);
  let aa = fwidth(x) * 1.2;
  return 1.0 - smoothstep(w - aa, w + aa, f);
}

@fragment
fn fsGround(in: GOut) -> @location(0) vec4f {
  let n = vec3f(0.0, 1.0, 0.0);
  var base = F.ground.rgb;
  // Large soft variation so the plane doesn't read as a flat card.
  base *= 0.92 + 0.16 * fbm2(in.world.xz * 0.08);
  if (F.ink.w > 0.0) {
    let fade = 1.0 - smoothstep(20.0, 60.0, distance(F.eye.xz, in.world.xz));
    let g = max(gridLine(in.world.x, 0.015), gridLine(in.world.z, 0.015));
    base = mix(base, base * 0.72, g * F.ink.w * fade);
  }
  let col = shade(base, n, in.world, 0.75);
  return vec4f(applyHaze(col, in.world), 1.0);
}

struct SIn {
  @location(0) s: vec4f, // x z radius opacity
};

struct SOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) opacity: f32,
  @location(2) world: vec3f,
};

@vertex
fn vsBlob(@builtin(vertex_index) vi: u32, s: SIn) -> SOut {
  var corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let c = corners[vi];
  // Nudged a little away from the sun (real cast shadows come from the shadow map).
  let sunOff = -normalize(F.sun.xz + vec2f(1e-4, 0.0)) * s.s.z * 0.1;
  let world = vec3f(s.s.x + c.x * s.s.z + sunOff.x, 0.006, s.s.y + c.y * s.s.z + sunOff.y);
  var o: SOut;
  o.pos = F.viewProj * vec4f(world, 1.0);
  o.uv = c;
  o.opacity = s.s.w;
  o.world = world;
  return o;
}

@fragment
fn fsBlob(in: SOut) -> @location(0) vec4f {
  let r = length(in.uv);
  if (r > 1.0) { discard; }
  // Softer where the sun shadow already darkens the ground.
  let sunVis = shadowAt(in.world, vec3f(0.0, 1.0, 0.0));
  let a = (1.0 - smoothstep(0.35, 1.0, r)) * in.opacity * F.shadowP.w * mix(0.35, 1.0, sunVis);
  let tint = srgb(vec3f(0.18, 0.16, 0.3));
  return vec4f(tint * a, a);
}
