// Instanced procedural meshes (blockout geometry, placeholders, debug shapes)
// with the shared look, plus their inverted-hull ink outline.

struct Inst {
  @location(2) m0: vec4f,
  @location(3) m1: vec4f,
  @location(4) m2: vec4f,
  @location(5) m3: vec4f,
  @location(6) color: vec4f,  // linear rgb, a = gloss
  @location(7) params: vec4f, // x flash, y outline scale, z rim scale, w emissive
};

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) color: vec4f,
  @location(3) params: vec4f,
};

@vertex
fn vs(@location(0) pos: vec3f, @location(1) nrm: vec3f, inst: Inst) -> VOut {
  let m = mat4x4f(inst.m0, inst.m1, inst.m2, inst.m3);
  let world = (m * vec4f(pos, 1.0)).xyz;
  var o: VOut;
  o.pos = F.viewProj * vec4f(world, 1.0);
  o.normal = normalize((m * vec4f(nrm, 0.0)).xyz);
  o.world = world;
  o.color = inst.color;
  o.params = inst.params;
  return o;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let n = normalize(in.normal);
  let l = normalize(F.sun.xyz);
  let v = normalize(F.eye.xyz - in.world);
  let base = in.color.rgb;
  var col = shade(base, n, in.world, 0.7) * groundAO(in.world);
  // Rim: a thin band on the sunlit side, masked on up-facing surfaces seen at
  // grazing angles (floors would read as grey haze otherwise).
  let rimBand = smoothstep(0.72, 0.8, 1.0 - max(dot(n, v), 0.0)) * smoothstep(-0.2, 0.35, dot(n, l)) * (1.0 - smoothstep(0.6, 0.85, n.y));
  col += mix(base * 1.6, srgb(vec3f(1.0, 0.94, 0.82)), 0.55) * rimBand * F.look2.z * in.params.z * 0.3;
  // Gloss: thresholded Blinn highlight.
  let h = normalize(l + v);
  let spec = smoothstep(0.9, 0.94, pow(max(dot(n, h), 0.0), 24.0 * in.color.a + 4.0)) * in.color.a;
  col += vec3f(1.0) * spec * 1.2;
  col += base * in.params.w;
  col = mix(col, vec3f(2.2, 2.2, 2.4), in.params.x);
  return vec4f(applyHaze(col, in.world), 1.0);
}

@vertex
fn vsOutline(@location(0) pos: vec3f, @location(1) nrm: vec3f, inst: Inst) -> VOut {
  let m = mat4x4f(inst.m0, inst.m1, inst.m2, inst.m3);
  let wn = normalize((m * vec4f(nrm, 0.0)).xyz);
  var world = (m * vec4f(pos, 1.0)).xyz;
  // Screen-constant width (ink px at 720p), grown along the normal and pushed
  // back along the view ray so the shell can't poke through concave detail.
  let w = inkWorldWidth(world) * inst.params.y;
  let toCam = normalize(F.eye.xyz - world);
  world += wn * w - toCam * max(w * 3.0, 0.012) * step(0.0001, w);
  var o: VOut;
  o.pos = F.viewProj * vec4f(world, 1.0);
  o.normal = wn;
  o.world = world;
  o.color = inst.color;
  o.params = inst.params;
  return o;
}

@fragment
fn fsOutline(in: VOut) -> @location(0) vec4f {
  return vec4f(applyHaze(inkColor(in.color.rgb), in.world), 1.0);
}
