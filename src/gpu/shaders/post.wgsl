// Post: bloom prefilter, separable blur, and the final grade/composite (with
// optional depth of field from the scene depth).

@group(1) @binding(0) var srcTex: texture_2d<f32>;
@group(1) @binding(1) var srcSamp: sampler;
@group(1) @binding(2) var bloomTex: texture_2d<f32>;

struct Blur {
  dir: vec4f, // xy texel step, zw unused
};
@group(1) @binding(3) var<uniform> B: Blur;
// Composite only: the scene's depth buffer.
@group(2) @binding(0) var sceneDepth: texture_depth_2d;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: VOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  o.uv = vec2f(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
  return o;
}

@fragment
fn fsPrefilter(in: VOut) -> @location(0) vec4f {
  let c = textureSampleLevel(srcTex, srcSamp, in.uv, 0.0).rgb;
  let l = max(c.r, max(c.g, c.b));
  // Only true HDR (sparkles, glints, flashes, emissives) blooms; lit diffuse
  // surfaces stay under the knee so bright props don't haze over their ink.
  let knee = 0.3;
  let threshold = F.ink.y;
  var soft = clamp(l - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  let contrib = max(soft, l - threshold) / max(l, 1e-4);
  return vec4f(min(c * contrib, vec3f(16.0)), 1.0);
}

@fragment
fn fsBlur(in: VOut) -> @location(0) vec4f {
  let w = array<f32, 5>(0.227, 0.194, 0.121, 0.054, 0.016);
  var c = textureSampleLevel(srcTex, srcSamp, in.uv, 0.0).rgb * w[0];
  for (var i = 1; i < 5; i++) {
    let o = B.dir.xy * f32(i) * 1.5;
    c += textureSampleLevel(srcTex, srcSamp, in.uv + o, 0.0).rgb * w[i];
    c += textureSampleLevel(srcTex, srcSamp, in.uv - o, 0.0).rgb * w[i];
  }
  return vec4f(c, 1.0);
}

fn tonemap(x: vec3f) -> vec3f {
  // Filmic curve (ACES fit), per channel.
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn tonemap1(x: f32) -> f32 {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// Metres from the eye to what the scene drew at pixel `px` (the sky, at the far plane, reads as very far).
// Translucent surfaces write no depth, so they take the focus of what is behind them.
fn sceneDistance(px: vec2i) -> f32 {
  let size = vec2i(textureDimensions(sceneDepth));
  let p = clamp(px, vec2i(0), size - 1);
  let d = textureLoad(sceneDepth, p, 0);
  if (d >= 1.0) { return 1e6; }
  let uv = (vec2f(p) + 0.5) / vec2f(size);
  let w = F.invViewProj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  return distance(w.xyz / w.w, F.eye.xyz);
}

// Blur 0..1 at a distance: none between focus near and far, full at 0.4 × near and at 2 × far.
fn dofBlur(dist: f32) -> f32 {
  let near = 1.0 - smoothstep(F.dof.y * 0.4, F.dof.y, dist);
  let far = smoothstep(F.dof.z, F.dof.z * 2.0, dist);
  return max(near, far);
}

// Depth of field: a 16-tap disc whose radius follows this pixel's blur (up to 8 px at 720p × strength).
// A tap nearer than this pixel counts only as much as it is blurred itself, so a sharp subject does not
// smear onto the blurred background behind it.
fn depthOfField(uv: vec2f, pos: vec2f, c: vec3f) -> vec3f {
  let dist = sceneDistance(vec2i(pos));
  let blur = dofBlur(dist);
  let radius = F.dof.x * blur * 8.0 * F.viewport.y / 720.0;
  if (radius < 0.5) { return c; }
  var acc = c;
  var total = 1.0;
  for (var i = 0; i < 16; i++) {
    let a = f32(i) * 2.39996323; // golden angle: an even spiral over the disc
    let o = vec2f(cos(a), sin(a)) * sqrt((f32(i) + 0.5) / 16.0) * radius;
    let tapDist = sceneDistance(vec2i(pos + o));
    var w = 1.0;
    if (tapDist < dist) { w = clamp(dofBlur(tapDist) / max(blur, 1e-3), 0.0, 1.0); }
    acc += textureSampleLevel(srcTex, srcSamp, uv + o * F.viewport.zw, 0.0).rgb * w;
    total += w;
  }
  return acc / total;
}

@fragment
fn fsComposite(in: VOut) -> @location(0) vec4f {
  var c = textureSampleLevel(srcTex, srcSamp, in.uv, 0.0).rgb;
  if (F.dof.x > 0.0) { c = depthOfField(in.uv, in.pos.xy, c); }
  let bloom = textureSampleLevel(bloomTex, srcSamp, in.uv, 0.0).rgb;
  c += bloom * F.look.w;
  c *= F.look2.x;
  // Highlight roll-off: per-channel filmic bleaches bright creams toward
  // white; a luminance curve keeps their hue. Only the bright end takes the
  // hue-preserving curve, so mid-tones keep the filmic saturation.
  let per = tonemap(c);
  let l0 = max(luma(c), 1e-4);
  let hue = c * (tonemap1(l0) / l0);
  let over = max(max(hue.r, hue.g), hue.b);
  let keep = hue / max(over, 1.0); // compress rather than clip saturated highlights
  c = mix(per, keep, F.grade.y * smoothstep(0.3, 0.85, tonemap1(l0)));
  // Display space for grading.
  var g = pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2));
  let s = g * g * (3.0 - 2.0 * g);
  g = mix(g, s, clamp(F.grade.x - 1.0, -1.0, 1.0) * 2.0);
  // Split tone: cool shadows, warm highlights.
  let lg = luma(g);
  let shadowW = (1.0 - smoothstep(0.0, 0.55, lg)) * F.grade.z;
  let highW = smoothstep(0.55, 1.0, lg) * F.grade.z;
  g = g + vec3f(-0.02, 0.0, 0.05) * shadowW + vec3f(0.035, 0.012, -0.03) * highW;
  g = mix(vec3f(luma(g)), g, F.look.z);
  // Vignette keeps the eye on the middle of the frame.
  let dv = length((in.uv - 0.5) * vec2f(F.camUp.w, 1.0));
  g *= mix(1.0, 0.76, smoothstep(0.45, 1.1, dv) * F.look2.y);
  return vec4f(clamp(g, vec3f(0.0), vec3f(1.0)), 1.0);
}
