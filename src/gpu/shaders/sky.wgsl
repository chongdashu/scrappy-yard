// Procedural sky behind everything (drawn at the far plane after opaque
// geometry): a gradient with a soft sun glow and simple toon clouds. Only
// visible when the camera tilts toward the horizon (title shots).

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) ndc: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VOut;
  o.pos = vec4f(p[vi], 1.0, 1.0);
  o.ndc = p[vi];
  return o;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let far = F.invViewProj * vec4f(in.ndc, 1.0, 1.0);
  let near = F.invViewProj * vec4f(in.ndc, 0.0, 1.0);
  let dir = normalize(far.xyz / far.w - near.xyz / near.w);
  var c = skyColor(dir);
  // Clouds: Style.cloudOpacity (F.ink.z is 1 − opacity; at 0 opacity they are skipped) and Style.cloudTint.
  if (dir.y > 0.0 && F.ink.z < 1.0) {
    let uv = dir.xz / (dir.y + 0.25) * 1.6 + vec2f(F.eye.w * 0.01, 0.0);
    let n = fbm2(uv * 0.9) * 0.75 + fbm2(uv * 2.3 + 5.0) * 0.25;
    let band = smoothstep(0.02, 0.18, dir.y) * (1.0 - smoothstep(0.45, 0.8, dir.y));
    let puff = smoothstep(0.54, 0.6, n) * band;
    let belly = smoothstep(0.54, 0.7, fbm2(uv * 0.9 + vec2f(0.0, 0.08)));
    let cloud = mix(srgb(vec3f(0.86, 0.9, 1.0)), srgb(vec3f(1.0, 0.99, 0.96)), belly);
    c = mix(c, cloud * 1.05 * cloudTint(), puff * 0.9 * (1.0 - F.ink.z));
  }
  return vec4f(c, 1.0);
}
