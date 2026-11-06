// glTF models (static and skinned) with the same look as mesh.wgsl: diffuse
// ramp, hemisphere ambient, a thin sunlit rim, thresholded gloss, hit flash
// and an inverted-hull ink outline of constant screen width (along
// position-smoothed normals, so hard edges don't crack it). Prepended with
// common.wgsl.
//
// Materials carry a kind and a glTF alpha mode (model.ts MAT_FLOATS):
// OPAQUE and MASK (cut out below the cutoff) draw with `fs`; BLEND draws
// later in the translucent pass with `fsBlend` (premultiplied alpha, no depth
// write, no ink, no sun shadow). Kinds add vertex motion from Style: foliage
// sways, liquid waves; both are off by default. Bump shades relief from the
// base colour's brightness (Style.bumpHeight).

struct NodeData {
  m: mat4x4f,
  p: vec4f, // x flash
};

struct Material {
  base: vec4f,     // linear base colour factor
  emissive: vec4f, // rgb × strength, w = has texture
  params: vec4f,   // x gloss (1 − roughness), y kind (0 default, 1 foliage, 2 liquid, 3 bump), z alpha mode (0 OPAQUE, 1 MASK, 2 BLEND), w alpha cutoff
};

const KIND_FOLIAGE: f32 = 1.0;
const KIND_LIQUID: f32 = 2.0;
const KIND_BUMP: f32 = 3.0;
const ALPHA_MASK: f32 = 1.0;

struct Draw {
  node: u32,
  material: u32,
  pad0: u32,
  pad1: u32,
};

struct ModelParams {
  v: vec4f, // x flash (whole model), y flatten baked light 0..1, z outline scale, w emissive boost
};

@group(1) @binding(0) var<storage, read> nodes: array<NodeData>;
@group(1) @binding(1) var<storage, read> mats: array<Material>;
@group(1) @binding(2) var<storage, read> draws: array<Draw>;
@group(1) @binding(3) var<storage, read> joints: array<mat4x4f>;
@group(1) @binding(4) var<uniform> MP: ModelParams;
@group(2) @binding(0) var baseTex: texture_2d<f32>;
@group(2) @binding(1) var baseSamp: sampler;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) nrm: vec3f,
  @location(2) uv: vec2f,
};

struct SkinIn {
  @location(3) j: vec4u,
  @location(4) w: vec4f,
};

// Ink pass only: normals averaged over coincident positions (see model.ts).
struct HullIn {
  @location(5) n: vec3f,
};

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) normal: vec3f,
  @location(1) world: vec3f,
  @location(2) uv: vec2f,
  @location(3) @interpolate(flat) material: u32,
  @location(4) flash: f32,
};

fn finish(world: vec3f, n: vec3f, uv: vec2f, d: Draw, flash: f32) -> VOut {
  var o: VOut;
  o.pos = F.viewProj * vec4f(world, 1.0);
  o.normal = n;
  o.world = world;
  o.uv = uv;
  o.material = d.material;
  o.flash = max(flash, MP.v.x);
  return o;
}

fn outlineOffset(world: vec3f, n: vec3f) -> vec3f {
  let toCam = F.eye.xyz - world;
  let dist = max(length(toCam), 1e-3);
  let w = inkWorldWidth(world) * MP.v.z;
  // Grow along the normal, then push the shell away from the camera so it
  // cannot poke through concave detail (faces, brims); silhouettes keep ink.
  let back = max(w * 3.0, 0.012);
  return n * w - (toCam / dist) * back;
}

fn skinMatrix(s: SkinIn) -> mat4x4f {
  return joints[s.j.x] * s.w.x + joints[s.j.y] * s.w.y + joints[s.j.z] * s.w.z + joints[s.j.w] * s.w.w;
}

struct Moved {
  world: vec3f,
  normal: vec3f,
};

// Per-kind vertex motion (Style foliageSway/foliageFreq, liquidWave/liquidSpeed; off by default).
// `base` is the height foliage sways from: the node's origin (the ground plane for skins).
fn kindMotion(world: vec3f, n: vec3f, kind: f32, base: f32) -> Moved {
  var o = Moved(world, n);
  let t = F.eye.w;
  if (kind == KIND_FOLIAGE && F.motion.x > 0.0) {
    // Sway grows with height above the origin (full at 1.5 m); the phase drifts across the ground so neighbours don't move in lockstep.
    let h = smoothstep(0.0, 1.5, world.y - base);
    let w = t * F.motion.y * 2.0 * PI + dot(world.xz, vec2f(0.9, 0.6));
    o.world.x += sin(w) * F.motion.x * h;
    o.world.z += sin(w * 0.77 + 1.3) * F.motion.x * 0.6 * h;
  } else if (kind == KIND_LIQUID && F.motion.z > 0.0) {
    // Two crossing sine waves (about 2.5 m and 1.6 m long) on up-facing surfaces; crests move at 0.5 m/s × speed. The normal follows the slope.
    let a = F.motion.z * clamp(n.y, 0.0, 1.0);
    let k1 = vec2f(2.2, 1.3);
    let k2 = vec2f(-1.6, 3.7);
    let p1 = dot(world.xz, k1) - t * F.motion.w * 0.5 * length(k1);
    let p2 = dot(world.xz, k2) - t * F.motion.w * 0.5 * length(k2);
    o.world.y += a * (0.6 * sin(p1) + 0.4 * sin(p2));
    let slope = a * (0.6 * cos(p1) * k1 + 0.4 * cos(p2) * k2);
    o.normal = normalize(n - vec3f(slope.x, 0.0, slope.y));
  }
  return o;
}

@vertex
fn vsStatic(v: VIn, @builtin(instance_index) ii: u32) -> VOut {
  let d = draws[ii];
  let nd = nodes[d.node];
  let world = (nd.m * vec4f(v.pos, 1.0)).xyz;
  let n = normalize((nd.m * vec4f(v.nrm, 0.0)).xyz);
  let mv = kindMotion(world, n, mats[d.material].params.y, nd.m[3].y);
  return finish(mv.world, mv.normal, v.uv, d, nd.p.x);
}

@vertex
fn vsStaticOutline(v: VIn, h: HullIn, @builtin(instance_index) ii: u32) -> VOut {
  let d = draws[ii];
  let nd = nodes[d.node];
  let n = normalize((nd.m * vec4f(v.nrm, 0.0)).xyz);
  let mv = kindMotion((nd.m * vec4f(v.pos, 1.0)).xyz, n, mats[d.material].params.y, nd.m[3].y);
  let world = mv.world + outlineOffset(mv.world, normalize((nd.m * vec4f(h.n, 0.0)).xyz));
  return finish(world, n, v.uv, d, 0.0);
}

@vertex
fn vsSkinned(v: VIn, s: SkinIn, @builtin(instance_index) ii: u32) -> VOut {
  let d = draws[ii];
  let sm = skinMatrix(s);
  let world = (sm * vec4f(v.pos, 1.0)).xyz;
  let n = normalize((sm * vec4f(v.nrm, 0.0)).xyz);
  let mv = kindMotion(world, n, mats[d.material].params.y, F.ground.w);
  return finish(mv.world, mv.normal, v.uv, d, 0.0);
}

@vertex
fn vsSkinnedOutline(v: VIn, s: SkinIn, h: HullIn, @builtin(instance_index) ii: u32) -> VOut {
  let d = draws[ii];
  let sm = skinMatrix(s);
  let n = normalize((sm * vec4f(v.nrm, 0.0)).xyz);
  let mv = kindMotion((sm * vec4f(v.pos, 1.0)).xyz, n, mats[d.material].params.y, F.ground.w);
  let world = mv.world + outlineOffset(mv.world, normalize((sm * vec4f(h.n, 0.0)).xyz));
  return finish(world, n, v.uv, d, 0.0);
}

// Base colour (rgb) and alpha (base alpha × texture alpha).
fn albedo(in: VOut) -> vec4f {
  let m = mats[in.material];
  let texel = textureSample(baseTex, baseSamp, in.uv);
  var tex = texel.rgb;
  // Close up, a small atlas is magnified: an unsharp mask against a blurrier
  // mip keeps painted detail crisp. It fades out once texels shrink below a
  // pixel, where small atlas islands would bleed.
  let soft = textureSampleBias(baseTex, baseSamp, in.uv, 1.5).rgb;
  let texels = max(length(dpdx(in.uv)), length(dpdy(in.uv))) * f32(textureDimensions(baseTex).x);
  let sharpen = 0.5 * m.emissive.w * (1.0 - smoothstep(0.7, 1.8, texels));
  tex = max(tex + (tex - soft) * sharpen, vec3f(0.0));
  // Textures with baked shading (e.g. photogrammetry/AI exports): lift the darkest bake.
  let flatten = MP.v.y * m.emissive.w;
  tex = mix(tex, pow(tex, vec3f(0.78)), flatten * 0.6);
  return vec4f(m.base.rgb * tex, m.base.a * texel.a);
}

// The lit, hazed surface colour and its alpha (straight, not premultiplied).
fn surface(in: VOut, front: bool) -> vec4f {
  let m = mats[in.material];
  var n = normalize(in.normal);
  if (!front) { n = -n; } // double-sided materials
  let l = normalize(F.sun.xyz);
  let v = normalize(F.eye.xyz - in.world);
  let tinted = albedo(in);
  // Bump: the base colour's brightness as a height field, up to F.tint.w metres (Style.bumpHeight), bends the shading
  // normal (surface-gradient bump mapping). Only bump materials pay for the derivatives. A draw has one material, so in
  // practice the branch is uniform over every quad; WGSL's uniformity analysis cannot know that, hence the diagnostic.
  @diagnostic(off, derivative_uniformity)
  if (m.params.y == KIND_BUMP && F.tint.w > 0.0) {
    let height = luma(tinted.rgb) * F.tint.w;
    let px = dpdx(in.world);
    let py = dpdy(in.world);
    let r1 = cross(py, n);
    let r2 = cross(n, px);
    let det = dot(px, r1); // the pixel's footprint area on the surface (signed)
    n = normalize(n - (r1 * dpdx(height) + r2 * dpdy(height)) * (sign(det) / max(abs(det), 1e-10)));
  }
  let base = tinted.rgb;
  let flatten = MP.v.y * m.emissive.w;
  let lit = shade(base, n, in.world, 0.7);
  let vis = shadowAt(in.world, n);
  let evenLit = base * sunColor() * mix(0.55, 0.95, vis) + base * hemi(n) * F.light.y * 0.4;
  var col = mix(lit, evenLit, flatten * 0.7) * groundAO(in.world);
  // Rim: a thin, crisp band on the sunlit side only, masked on up-facing
  // surfaces at grazing angles (floors would read as grey haze).
  let ndv = max(dot(n, v), 0.0);
  let rimBand = smoothstep(0.72, 0.8, 1.0 - ndv) * smoothstep(-0.2, 0.35, dot(n, l)) * vis * (1.0 - smoothstep(0.6, 0.85, n.y));
  let rimCol = mix(base * 1.6, srgb(vec3f(1.0, 0.94, 0.82)), 0.55);
  col += rimCol * rimBand * F.look2.z * mix(0.3, 0.2, flatten);
  let gloss = m.params.x;
  let h = normalize(l + v);
  // (A matte surface has no glint: fades out below gloss 0.4, roughness 0.6, so cloth, skin, walls and floors do not grow a hard grey blob where they face the light.)
  let spec = smoothstep(0.9, 0.94, pow(max(dot(n, h), 0.0), 24.0 * gloss + 4.0)) * gloss * smoothstep(0.18, 0.4, gloss) * vis;
  col += vec3f(1.0) * spec * mix(1.2, 0.2, flatten);
  col += m.emissive.rgb * (1.0 + MP.v.w);
  col = mix(col, vec3f(2.2, 2.2, 2.4), in.flash);
  var alpha = tinted.a;
  // Liquids get more opaque toward grazing angles (only BLEND uses the alpha).
  if (m.params.y == KIND_LIQUID) { alpha = mix(alpha, 1.0, pow(1.0 - ndv, 3.0) * 0.7); }
  return vec4f(applyHaze(col, in.world), alpha);
}

// OPAQUE and MASK.
@fragment
fn fs(in: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let c = surface(in, front);
  let m = mats[in.material];
  if (m.params.z == ALPHA_MASK && c.a < m.params.w) { discard; }
  return vec4f(c.rgb, 1.0);
}

// BLEND, premultiplied (the translucent pass blends one, one − src alpha).
@fragment
fn fsBlend(in: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let c = surface(in, front);
  return vec4f(c.rgb * c.a, c.a);
}

@fragment
fn fsOutline(in: VOut) -> @location(0) vec4f {
  let a = albedo(in);
  let m = mats[in.material];
  if (m.params.z == ALPHA_MASK && a.a < m.params.w) { discard; }
  return vec4f(applyHaze(inkColor(a.rgb), in.world), 1.0);
}

// Sun shadow casters with MASK materials: cut out like the fill pass.
@fragment
fn fsShadowMask(in: VOut) {
  let m = mats[in.material];
  let a = m.base.a * textureSample(baseTex, baseSamp, in.uv).a;
  if (a < m.params.w) { discard; }
}
