// Instanced particle billboards with per-particle colour. Premultiplied
// alpha output into the HDR target (colours above 1 bloom).
// Kinds: 0 soft glow dot, 1 four-point sparkle, 2 ground ring, 3 spinning
// chip (confetti), 4 five-point star with an ink edge.

struct PIn {
  @location(0) a: vec4f, // x y z size
  @location(1) b: vec4f, // kind, life01, rotation, alpha
  @location(2) c: vec4f, // linear rgb, w emissive boost
};

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) kind: u32,
  @location(2) life: f32,
  @location(3) color: vec4f,
  @location(4) alpha: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, p: PIn) -> VOut {
  var corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let c = corners[vi];
  let kind = u32(p.b.x + 0.5);
  let life = p.b.y;
  var size = p.a.w;
  switch kind {
    case 0u: { size *= 1.0 - life * 0.6; }             // glow shrinks
    case 1u: { size *= sin(life * PI) * 1.3; }         // sparkle pops
    case 2u: { size *= 0.3 + life * 1.7; }             // ring expands
    case 4u: { size *= 1.0 - life * life; }            // star shrinks at the end
    default: {}
  }
  let rot = p.b.z;
  let cr = cos(rot);
  let sr = sin(rot);
  let rc = vec2f(c.x * cr - c.y * sr, c.x * sr + c.y * cr);
  var world: vec3f;
  if (kind == 2u) {
    world = p.a.xyz + vec3f(c.x, 0.0, c.y) * size; // flat on the ground
  } else {
    world = p.a.xyz + (F.camRight.xyz * rc.x + F.camUp.xyz * rc.y) * size;
  }
  var o: VOut;
  o.pos = F.viewProj * vec4f(world, 1.0);
  o.uv = c;
  o.kind = kind;
  o.life = life;
  o.color = p.c;
  o.alpha = p.b.w;
  return o;
}

fn starShape(uv: vec2f, points: f32, inner: f32) -> f32 {
  let a = atan2(uv.y, uv.x);
  let r = length(uv);
  let k = cos(a * points) * 0.5 + 0.5;
  let edge = mix(inner, 1.0, pow(k, 3.0));
  return 1.0 - smoothstep(edge - 0.08, edge, r);
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let uv = in.uv;
  let r = length(uv);
  let rgb = in.color.rgb * (1.0 + in.color.w);
  var a = 0.0;
  var col = vec3f(0.0);
  switch in.kind {
    case 0u: { // glow dot
      a = (1.0 - smoothstep(0.0, 1.0, r)) * (1.0 - in.life);
      col = rgb;
    }
    case 1u: { // sparkle
      a = starShape(uv, 4.0, 0.08);
      col = rgb * 2.5;
    }
    case 2u: { // ground ring
      a = (1.0 - smoothstep(0.0, 0.12, abs(r - 0.85))) * (1.0 - in.life);
      col = rgb * 1.5;
    }
    case 3u: { // chip
      if (max(abs(uv.x), abs(uv.y * 1.6)) > 0.8) { discard; }
      a = 1.0 - smoothstep(0.7, 1.0, in.life);
      col = rgb;
    }
    case 4u: { // star with ink edge
      a = starShape(uv, 5.0, 0.45);
      let inner = starShape(uv * 1.35, 5.0, 0.45);
      col = mix(srgb(vec3f(0.12, 0.08, 0.15)), rgb * 1.4, inner);
    }
    default: { discard; }
  }
  a *= in.alpha;
  if (a <= 0.002) { discard; }
  return vec4f(col * a, a);
}
