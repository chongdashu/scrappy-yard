// Matches common.wgsl's Frame byte layout (std140: matrices and vec4s only).
layout(std140) uniform Frame {
  mat4 viewProj; mat4 view; mat4 invViewProj; mat4 sunViewProj;
  vec4 eye; vec4 sun; vec4 camRight; vec4 camUp; vec4 viewport;
  vec4 look; vec4 look2; vec4 ink; vec4 shadowP; vec4 light; vec4 grade; vec4 misc; vec4 ground;
  vec4 ambSky; vec4 ambGround; vec4 roomMin; vec4 roomMax; vec4 lights[16];
  vec4 tint; vec4 zenith; vec4 horizon; vec4 bounce; vec4 dof; vec4 motion; // look block: see common.wgsl
} F;
uniform highp sampler2DShadow shadowTex;
const float PI = 3.14159265;
// Shared cameras use WebGPU's 0..1 depth; GL clips against -w..w.
vec4 project(vec3 world) { vec4 p = F.viewProj * vec4(world, 1.0); p.z = 2.0 * p.z - p.w; return p; }
vec4 sceneColor(vec3 c, float a) { return vec4(c * SCENE_SCALE, a); }
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
float hash21(vec2 p) { vec2 q = fract(p * vec2(123.34,456.21)); q += dot(q,q+45.32); return fract(q.x*q.y); }
float vnoise(vec2 p) {
  vec2 i=floor(p), f=fract(p), u=f*f*(3.0-2.0*f);
  return mix(mix(hash21(i),hash21(i+vec2(1,0)),u.x),mix(hash21(i+vec2(0,1)),hash21(i+vec2(1)),u.x),u.y);
}
float fbm2(vec2 p) { return vnoise(p)*0.55+vnoise(p*2.07+13.1)*0.3+vnoise(p*4.3+7.7)*0.15; }
float luma(vec3 c) { return dot(c,vec3(0.2126,0.7152,0.0722)); }
float diffuseRamp(float ndl) {
  float soft=F.look.y;
  float toon=smoothstep(-soft,soft,ndl)*0.55+smoothstep(0.45-soft,0.45+soft,ndl)*0.25;
  return 0.42+mix(clamp(ndl*0.5+0.5,0.0,1.0)*0.8,toon,F.look.x);
}
vec3 hemi(vec3 n) {
  vec3 sky = F.ambSky.w > 0.5 ? F.ambSky.rgb : srgb(vec3(0.64,0.76,0.95));
  vec3 ground = F.ambSky.w > 0.5 ? F.ambGround.rgb : srgb(F.bounce.rgb);
  return mix(ground, sky, n.y*0.5+0.5);
}
// Keep indoor lighting identical to common.wgsl, including corner/edge occlusion.
float roomAO(vec3 world, vec3 n) {
  if (F.roomMin.w <= 0.0) return 1.0;
  vec3 lo = world - F.roomMin.xyz, hi = F.roomMax.xyz - world;
  float reach = F.roomMax.w;
  float w[6] = float[6](
    1.0-clamp(lo.x/reach,0.0,1.0), 1.0-clamp(hi.x/reach,0.0,1.0),
    1.0-clamp(lo.y/reach,0.0,1.0), 1.0-clamp(hi.y/reach,0.0,1.0),
    1.0-clamp(lo.z/reach,0.0,1.0), 1.0-clamp(hi.z/reach,0.0,1.0));
  float away[6] = float[6](max(n.x,0.0),max(-n.x,0.0),max(n.y,0.0),max(-n.y,0.0),max(n.z,0.0),max(-n.z,0.0));
  float sum = 0.0, pairs = 0.0;
  for (int i=0;i<6;i++) { w[i] *= w[i]*(1.0-away[i]); sum += w[i]; }
  for (int i=0;i<6;i++) for (int j=i+1;j<6;j++) if (i/2 != j/2) pairs += w[i]*w[j];
  return 1.0-F.roomMin.w*clamp(sum*0.2+pairs*0.55,0.0,1.0);
}
vec3 localLights(vec3 n, vec3 world) {
  vec3 acc = vec3(0.0);
  for (int i=0;i<int(F.misc.z);i++) {
    vec4 a = F.lights[i*2];
    vec3 d = a.xyz-world;
    float dist = length(d);
    if (dist >= a.w) continue;
    float x = 1.0-dist/a.w, fall = x*x*(3.0-2.0*x);
    float wrap = smoothstep(-0.3,0.7,dot(n,d/max(dist,1e-3)));
    acc += F.lights[i*2+1].rgb*fall*fall*wrap;
  }
  return acc;
}
vec3 sunColor() { return mix(vec3(1,0.99,0.97),vec3(1,0.91,0.76),F.misc.x)*F.sun.w*F.light.x; }
float shadowAt(vec3 world,vec3 n) {
  if(F.misc.y<0.5 || F.shadowP.x<=0.0) return 1.0;
  float ndl=dot(n,normalize(F.sun.xyz));
  vec3 offset=n*(0.02+0.04*(1.0-clamp(ndl,0.0,1.0)));
  vec4 c=F.sunViewProj*vec4(world+offset,1);
  vec3 ndc=c.xyz/c.w;
  // GL render targets and shadow UVs both have their origin at the bottom left.
  vec2 uv=ndc.xy*0.5+0.5;
  if(any(lessThan(uv,vec2(0.001))) || any(greaterThan(uv,vec2(0.999))) || ndc.z>1.0) return 1.0;
  float r=F.shadowP.z*F.shadowP.y, sum=0.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++) sum+=texture(shadowTex,vec3(uv+vec2(i,j)*r,ndc.z-0.0015));
  float lit=smoothstep(0.2,0.8,sum/9.0);
  float edge=smoothstep(0.0,0.08,min(min(uv.x,uv.y),min(1.0-uv.x,1.0-uv.y)));
  return mix(1.0,lit,F.shadowP.x*edge);
}
vec3 groundBounce(vec3 n,vec3 world) {
  if(F.bounce.w<=0.0) return vec3(0.0);
  float facing=clamp(0.4-n.y*0.6,0.0,1.0), near=1.0-smoothstep(0.0,F.dof.w,world.y-F.ground.w);
  return srgb(F.bounce.rgb)*facing*near*F.bounce.w*F.light.x;
}
vec3 shade(vec3 albedo,vec3 n,vec3 world,float keyScale) {
  float vis=shadowAt(world,n), lit=diffuseRamp(dot(n,normalize(F.sun.xyz)));
  float level=0.42*mix(0.55,1.0,F.light.z);
  float ao=roomAO(world,n);
  vec3 key=sunColor()*mix(min(lit,level),lit,vis)*keyScale*mix(1.0,ao,0.5);
  vec3 fill=(hemi(n)*F.light.y+srgb(F.tint.rgb)*(1.0-vis)*0.12)*ao;
  return albedo*(fill+key+groundBounce(n,world)+localLights(n,world)*mix(1.0,ao,0.35));
}
float groundAO(vec3 world) { return mix(1.0-F.light.w,1.0,smoothstep(F.ground.w,F.ground.w+0.45,world.y)); }
// Style.cloudTint (common.wgsl cloudTint): F.misc.w packs 255 minus each 8-bit channel; 0 is white.
vec3 cloudTint() {
  uint p=uint(F.misc.w);
  if(p==0u) return vec3(1.0);
  return srgb(1.0-vec3(float((p>>16)&255u),float((p>>8)&255u),float(p&255u))/255.0);
}
vec3 skyColor(vec3 dir) {
  float up=clamp(dir.y,-1.0,1.0);
  vec3 c=mix(srgb(F.horizon.rgb),srgb(F.zenith.rgb),smoothstep(0.0,0.55,up));
  c=mix(srgb(clamp(F.horizon.rgb+vec3(0.1,0.02,-0.08),vec3(0),vec3(1))),c,smoothstep(-0.05,0.08,up));
  float s=max(dot(normalize(dir),normalize(F.sun.xyz)),0.0);
  return c+srgb(vec3(1,0.93,0.76))*(pow(s,24.0)*0.5+pow(s,4.0)*0.06);
}
vec3 applyHaze(vec3 col,vec3 world) {
  if(F.grade.w<=0.0) return col;
  float k=smoothstep(F.zenith.w,F.horizon.w,distance(F.eye.xyz,world))*F.grade.w;
  if(k<=0.0) return col;
  vec3 dir=normalize(world-F.eye.xyz);
  return mix(col,skyColor(vec3(dir.x,0.02,dir.z)),k*0.92);
}
float inkWorldWidth(vec3 world) {
  float dist=max(length(F.eye.xyz-world),1e-3);
  return F.look2.w*(2.0*F.ink.x*dist/720.0)*mix(1.0,0.55,smoothstep(18.0,70.0,dist));
}
vec3 inkColor(vec3 base) { return srgb(vec3(0.1,0.08,0.15))+base*0.04; }
const vec2 corners[6]=vec2[6](vec2(-1,-1),vec2(1,-1),vec2(1,1),vec2(-1,-1),vec2(1,1),vec2(-1,1));
const vec2 fullscreen[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3));
