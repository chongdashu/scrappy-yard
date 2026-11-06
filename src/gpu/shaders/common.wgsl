// Shared frame uniforms and lighting helpers, prepended to every shader module.
// The layout is written by Renderer.render() (src/gpu/renderer.ts, FRAME_FLOATS).

struct Frame {
  viewProj: mat4x4f,
  view: mat4x4f,
  invViewProj: mat4x4f,
  sunViewProj: mat4x4f, // world → sun shadow clip space
  eye: vec4f,        // xyz eye, w time (s)
  sun: vec4f,        // xyz direction toward the sun, w intensity
  camRight: vec4f,   // billboard right, w dt
  camUp: vec4f,      // billboard up, w aspect
  viewport: vec4f,   // render target px: w h 1/w 1/h
  look: vec4f,       // x toon amount (0 smooth … 1 banded), y toon softness, z saturation, w bloom
  look2: vec4f,      // x exposure, y vignette, z rim strength, w ink width (px at 720p, 0 = off)
  ink: vec4f,        // x tan(fovY/2), y bloom threshold, z 1 − cloud opacity (Style.cloudOpacity), w ground grid strength
  shadowP: vec4f,    // x strength, y PCF radius (texels), z 1/shadow size, w blob-shadow scale
  light: vec4f,      // x key intensity, y ambient, z shadow lift, w ground contact AO
  grade: vec4f,      // x contrast, y highlight roll-off, z split tone, w haze
  misc: vec4f,       // x key warmth, y shadows enabled (0/1), z local light count, w cloud tint (packed: cloudTint())
  ground: vec4f,     // rgb ground colour (linear), w ground height
  ambSky: vec4f,     // rgb ambient from above (linear), w 1 = use it instead of the daylight sky
  ambGround: vec4f,  // rgb ambient from below
  roomMin: vec4f,    // xyz corner of the room box, w occlusion strength (0 = none)
  roomMax: vec4f,    // xyz opposite corner, w occlusion reach (m)
  lights: array<vec4f, 16>, // local lights as pairs: (xyz position, w radius), (rgb colour x intensity, unused); F.misc.z of them
  // Look block (Style; colours are sRGB, linearised here with srgb()).
  tint: vec4f,       // rgb shadow tint, w relief of "bump" materials (m, Style.bumpHeight)
  zenith: vec4f,     // rgb sky zenith, w haze start (m)
  horizon: vec4f,    // rgb sky horizon / haze colour, w haze end (m)
  bounce: vec4f,     // rgb ground bounce, w near-ground bounce strength (0 = none)
  dof: vec4f,        // x depth-of-field strength (0 = off), y focus near (m), z focus far (m), w ground bounce reach (m)
  motion: vec4f,     // x foliage sway (m), y foliage sway (Hz), z liquid wave height (m), w liquid wave speed
};

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var shadowTex: texture_depth_2d;
@group(0) @binding(2) var shadowSamp: sampler_comparison;

const PI: f32 = 3.14159265;

fn srgb(c: vec3f) -> vec3f { return pow(c, vec3f(2.2)); }

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm2(p: vec2f) -> f32 {
  return vnoise(p) * 0.55 + vnoise(p * 2.07 + 13.1) * 0.3 + vnoise(p * 4.3 + 7.7) * 0.15;
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// Diffuse ramp: F.look.x blends a smooth wrapped Lambert (0) with a soft
// two-band toon ramp (1). Both keep a lifted floor so shade never goes black.
fn diffuseRamp(ndl: f32) -> f32 {
  let soft = F.look.y;
  let toon = smoothstep(-soft, soft, ndl) * 0.55 + smoothstep(0.45 - soft, 0.45 + soft, ndl) * 0.25;
  let wrapped = clamp(ndl * 0.5 + 0.5, 0.0, 1.0) * 0.8;
  return 0.42 + mix(wrapped, toon, F.look.x);
}

// Sky/ground hemisphere ambient: a cool fill from above, warm bounce from below.
fn hemi(n: vec3f) -> vec3f {
  var sky = srgb(vec3f(0.64, 0.76, 0.95));
  var ground = srgb(F.bounce.rgb);
  if (F.ambSky.w > 0.5) {
    sky = F.ambSky.rgb;
    ground = F.ambGround.rgb;
  }
  return mix(ground, sky, n.y * 0.5 + 0.5);
}

// Room occlusion: how open a point is to the room's faces (1 open, darker toward them, most in corners and along edges). Each face occludes by
// its closeness (1 on the face, 0 at `reach`, squared for a soft foot), except a face the surface faces away from: a floor is not occluded by
// itself, a table top is not by the floor beneath it. Pairs of faces that meet add the corners and edges.
fn roomAO(world: vec3f, n: vec3f) -> f32 {
  let strength = F.roomMin.w;
  if (strength <= 0.0) { return 1.0; }
  let reach = F.roomMax.w;
  let lo = world - F.roomMin.xyz;
  let hi = F.roomMax.xyz - world;
  // Faces in the order -x, +x, floor, ceiling, -z, +z; `away` is how much the surface looks away from a face (its inward normal along n).
  var w = array<f32, 6>(
    1.0 - clamp(lo.x / reach, 0.0, 1.0), 1.0 - clamp(hi.x / reach, 0.0, 1.0),
    1.0 - clamp(lo.y / reach, 0.0, 1.0), 1.0 - clamp(hi.y / reach, 0.0, 1.0),
    1.0 - clamp(lo.z / reach, 0.0, 1.0), 1.0 - clamp(hi.z / reach, 0.0, 1.0));
  var away = array<f32, 6>(max(n.x, 0.0), max(-n.x, 0.0), max(n.y, 0.0), max(-n.y, 0.0), max(n.z, 0.0), max(-n.z, 0.0));
  var sum = 0.0;
  for (var i = 0; i < 6; i++) {
    w[i] = w[i] * w[i] * (1.0 - away[i]);
    sum += w[i];
  }
  var pairs = 0.0;
  for (var i = 0; i < 6; i++) {
    for (var j = i + 1; j < 6; j++) {
      if ((i / 2) != (j / 2)) { pairs += w[i] * w[j]; }
    }
  }
  return 1.0 - strength * clamp(sum * 0.2 + pairs * 0.55, 0.0, 1.0);
}

// Local lights: wrapped, softly banded diffuse with a smooth radius falloff, no shadows.
fn localLights(n: vec3f, world: vec3f) -> vec3f {
  var acc = vec3f(0.0);
  let count = i32(F.misc.z);
  for (var i = 0; i < count; i++) {
    let a = F.lights[i * 2];
    let d = a.xyz - world;
    let dist = length(d);
    if (dist >= a.w) { continue; }
    let x = 1.0 - dist / a.w;
    let fall = x * x * (3.0 - 2.0 * x);
    let ndl = dot(n, d / max(dist, 1e-3));
    let wrap = smoothstep(-0.3, 0.7, ndl);
    acc += F.lights[i * 2 + 1].rgb * fall * fall * wrap;
  }
  return acc;
}

// Key light colour (warmth 0 = neutral white, 1 = warm late-morning).
fn sunColor() -> vec3f {
  return mix(vec3f(1.0, 0.99, 0.97), vec3f(1.0, 0.91, 0.76), F.misc.x) * F.sun.w * F.light.x;
}

// Sun visibility (1 lit, 0 shadowed): 3×3 PCF with a normal-offset bias,
// sharpened with a smoothstep so edges stay crisp.
fn shadowAt(world: vec3f, n: vec3f) -> f32 {
  if (F.misc.y < 0.5 || F.shadowP.x <= 0.0) { return 1.0; }
  let ndl = dot(n, normalize(F.sun.xyz));
  let offset = n * (0.02 + 0.04 * (1.0 - clamp(ndl, 0.0, 1.0)));
  let c = F.sunViewProj * vec4f(world + offset, 1.0);
  let ndc = c.xyz / c.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (any(uv < vec2f(0.001)) || any(uv > vec2f(0.999)) || ndc.z > 1.0) { return 1.0; }
  let depth = ndc.z - 0.0015;
  let r = F.shadowP.z * F.shadowP.y;
  var sum = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      sum += textureSampleCompareLevel(shadowTex, shadowSamp, uv + vec2f(f32(i), f32(j)) * r, depth);
    }
  }
  let lit = smoothstep(0.2, 0.8, sum / 9.0);
  // Fade toward the shadow-map edge so the fitted footprint never shows.
  let edge = smoothstep(0.0, 0.08, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
  return mix(1.0, lit, F.shadowP.x * edge);
}

// Lit colour: hemisphere ambient + key light through the diffuse ramp, with
// sun shadows lifting to the ramp's dark band (never to black).
fn shade(albedo: vec3f, n: vec3f, world: vec3f, keyScale: f32) -> vec3f {
  let l = normalize(F.sun.xyz);
  let ndl = dot(n, l);
  let vis = shadowAt(world, n);
  let lit = diffuseRamp(ndl);
  let shadowLevel = 0.42 * mix(0.55, 1.0, F.light.z);
  let diffuse = mix(min(lit, shadowLevel), lit, vis);
  let ao = roomAO(world, n);
  let key = sunColor() * diffuse * keyScale * mix(1.0, ao, 0.5);
  // Shadowed areas get a cool fill so shade reads blue-violet, not grey.
  let fill = (hemi(n) * F.light.y + srgb(F.tint.rgb) * (1.0 - vis) * 0.12) * ao;
  return albedo * (fill + key + groundBounce(n, world) + localLights(n, world) * mix(1.0, ao, 0.35));
}

// Optional extra bounce off the ground onto down- and side-facing surfaces near it (off at strength 0).
fn groundBounce(n: vec3f, world: vec3f) -> vec3f {
  if (F.bounce.w <= 0.0) { return vec3f(0.0); }
  let facing = clamp(0.4 - n.y * 0.6, 0.0, 1.0);
  let near = 1.0 - smoothstep(0.0, F.dof.w, world.y - F.ground.w);
  return srgb(F.bounce.rgb) * facing * near * F.bounce.w * F.light.x;
}

// Soft contact darkening near the ground for props and characters.
fn groundAO(world: vec3f) -> f32 {
  return mix(1.0 - F.light.w, 1.0, smoothstep(F.ground.w, F.ground.w + 0.45, world.y));
}

// Style.cloudTint, linear. frame.ts packColor8 stores it in F.misc.w as 8 bits a channel, each 255 minus its value:
// 0 (the default) is white, which leaves the clouds exactly as drawn.
fn cloudTint() -> vec3f {
  let p = u32(F.misc.w);
  if (p == 0u) { return vec3f(1.0); }
  let inverse = vec3f(f32((p >> 16u) & 255u), f32((p >> 8u) & 255u), f32(p & 255u));
  return srgb(1.0 - inverse / 255.0);
}

// Sky gradient for a view direction (also the haze colour at the horizon).
fn skyColor(dir: vec3f) -> vec3f {
  let up = clamp(dir.y, -1.0, 1.0);
  let zenith = srgb(F.zenith.rgb);
  let horizon = srgb(F.horizon.rgb);
  // Just below the horizon: the horizon colour, a little lighter and warmer (0.9, 0.9, 0.88 by default).
  let low = srgb(clamp(F.horizon.rgb + vec3f(0.1, 0.02, -0.08), vec3f(0.0), vec3f(1.0)));
  var c = mix(horizon, zenith, smoothstep(0.0, 0.55, up));
  c = mix(low, c, smoothstep(-0.05, 0.08, up));
  let s = max(dot(normalize(dir), normalize(F.sun.xyz)), 0.0);
  c += srgb(vec3f(1.0, 0.93, 0.76)) * (pow(s, 24.0) * 0.5 + pow(s, 4.0) * 0.06);
  return c;
}

// Distance haze toward the horizon colour: invisible at gameplay distances,
// blends the ground into the sky at low camera angles.
fn applyHaze(col: vec3f, world: vec3f) -> vec3f {
  if (F.grade.w <= 0.0) { return col; }
  let d = distance(F.eye.xyz, world);
  let k = smoothstep(F.zenith.w, F.horizon.w, d) * F.grade.w;
  if (k <= 0.0) { return col; }
  let dir = normalize(world - F.eye.xyz);
  return mix(col, skyColor(vec3f(dir.x, 0.02, dir.z)), k * 0.92);
}

// Screen-constant ink offset: F.look2.w pixels at 720p, whatever the distance.
fn inkWorldWidth(world: vec3f) -> f32 {
  let dist = max(length(F.eye.xyz - world), 1e-3);
  let pxWorld = 2.0 * F.ink.x * dist / 720.0;
  let taper = mix(1.0, 0.55, smoothstep(18.0, 70.0, dist));
  return F.look2.w * pxWorld * taper;
}

// Deep violet-navy ink with a hint of the surface hue.
fn inkColor(base: vec3f) -> vec3f {
  return srgb(vec3f(0.1, 0.08, 0.15)) + base * 0.04;
}
