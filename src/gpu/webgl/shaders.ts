// GLSL ES 3.00 counterparts to gpu/shaders/*.wgsl. All scene outputs are linear.
// SCENE_SCALE keeps a 0..4 lighting range in RGBA8 when float targets are unavailable.
// Model materials: kind 0 default, 1 foliage, 2 liquid, 3 bump; alphaMode 0 OPAQUE, 1 MASK, 2 BLEND (see model.wgsl).
export const modelVertex = `
layout(location=0) in vec3 position; layout(location=1) in vec3 normal;
layout(location=2) in vec2 texcoord; layout(location=3) in uvec4 joint;
layout(location=4) in vec4 weight; layout(location=5) in vec3 hull;
uniform mat4 node; uniform highp sampler2D jointTex;
uniform bool skinned; uniform bool inkPass; uniform vec4 params; uniform float nodeFlash; uniform float kind;
out vec3 vNormal; out vec3 vWorld; out vec2 vUV; out float vFlash;
mat4 bone(uint j) { int y=int(j); return mat4(texelFetch(jointTex,ivec2(0,y),0),texelFetch(jointTex,ivec2(1,y),0),texelFetch(jointTex,ivec2(2,y),0),texelFetch(jointTex,ivec2(3,y),0)); }
// Per-kind vertex motion (model.wgsl kindMotion): foliage sways from its base height, liquid waves on up-facing surfaces.
void kindMotion(inout vec3 world,inout vec3 n,float base) {
  float t=F.eye.w;
  if(kind==1.0 && F.motion.x>0.0) {
    float h=smoothstep(0.0,1.5,world.y-base), w=t*F.motion.y*2.0*PI+dot(world.xz,vec2(0.9,0.6));
    world.x+=sin(w)*F.motion.x*h;
    world.z+=sin(w*0.77+1.3)*F.motion.x*0.6*h;
  } else if(kind==2.0 && F.motion.z>0.0) {
    float a=F.motion.z*clamp(n.y,0.0,1.0);
    vec2 k1=vec2(2.2,1.3), k2=vec2(-1.6,3.7);
    float p1=dot(world.xz,k1)-t*F.motion.w*0.5*length(k1), p2=dot(world.xz,k2)-t*F.motion.w*0.5*length(k2);
    world.y+=a*(0.6*sin(p1)+0.4*sin(p2));
    vec2 slope=a*(0.6*cos(p1)*k1+0.4*cos(p2)*k2);
    n=normalize(n-vec3(slope.x,0.0,slope.y));
  }
}
void main() {
  mat4 m=node;
  if(skinned) m=bone(joint.x)*weight.x+bone(joint.y)*weight.y+bone(joint.z)*weight.z+bone(joint.w)*weight.w;
  vec3 world=(m*vec4(position,1)).xyz;
  vNormal=normalize((m*vec4(normal,0)).xyz);
  vec3 moved=vNormal;
  kindMotion(world,moved,skinned ? F.ground.w : node[3].y);
  if(!inkPass) vNormal=moved;
  if(inkPass) {
    vec3 n=normalize((m*vec4(hull,0)).xyz), toCam=F.eye.xyz-world;
    float w=inkWorldWidth(world)*params.z;
    world+=n*w-toCam/max(length(toCam),1e-3)*max(w*3.0,0.012);
  }
  gl_Position=project(world); vWorld=world; vUV=texcoord;
  vFlash=max(skinned || inkPass ? 0.0 : nodeFlash,params.x);
}`;
export const modelFragment = `
in vec3 vNormal; in vec3 vWorld; in vec2 vUV; in float vFlash;
uniform sampler2D baseTex; uniform vec4 base; uniform vec4 emissive; uniform float gloss;
uniform vec4 params; uniform bool inkPass; uniform bool blendPass;
uniform float kind; uniform float alphaMode; uniform float cutoff;
out vec4 color;
void main() {
  vec4 texel=texture(baseTex,vUV);
  vec3 tex=texel.rgb;
  float alpha=base.a*texel.a;
  vec3 soft=texture(baseTex,vUV,1.5).rgb;
  float texels=max(length(dFdx(vUV)),length(dFdy(vUV)))*float(textureSize(baseTex,0).x);
  tex=max(tex+(tex-soft)*(0.5*emissive.w*(1.0-smoothstep(0.7,1.8,texels))),vec3(0));
  float flatten=params.y*emissive.w;
  tex=mix(tex,pow(tex,vec3(0.78)),flatten*0.6);
  vec3 albedo=base.rgb*tex;
  if(inkPass) {
    if(alphaMode==1.0 && alpha<cutoff) discard;
    color=sceneColor(applyHaze(inkColor(albedo),vWorld),1.0); return;
  }
  vec3 n=normalize(vNormal); if(!gl_FrontFacing) n=-n;
  // Bump (model.wgsl): relief from the base colour's brightness, up to F.tint.w metres; kind is a uniform, so only bump draws take this.
  if(kind==3.0 && F.tint.w>0.0) {
    float height=luma(albedo)*F.tint.w;
    vec3 px=dFdx(vWorld), py=dFdy(vWorld), r1=cross(py,n), r2=cross(n,px);
    float det=dot(px,r1);
    n=normalize(n-(r1*dFdx(height)+r2*dFdy(height))*(sign(det)/max(abs(det),1e-10)));
  }
  vec3 l=normalize(F.sun.xyz), v=normalize(F.eye.xyz-vWorld);
  float vis=shadowAt(vWorld,n);
  vec3 lit=shade(albedo,n,vWorld,0.7);
  vec3 evenLit=albedo*sunColor()*mix(0.55,0.95,vis)+albedo*hemi(n)*F.light.y*0.4;
  vec3 col=mix(lit,evenLit,flatten*0.7)*groundAO(vWorld);
  float ndv=max(dot(n,v),0.0);
  float rimBand=smoothstep(0.72,0.8,1.0-ndv)*smoothstep(-0.2,0.35,dot(n,l))*vis*(1.0-smoothstep(0.6,0.85,n.y));
  col+=mix(albedo*1.6,srgb(vec3(1,0.94,0.82)),0.55)*rimBand*F.look2.z*mix(0.3,0.2,flatten);
  float spec=smoothstep(0.9,0.94,pow(max(dot(n,normalize(l+v)),0.0),24.0*gloss+4.0))*gloss*smoothstep(0.18,0.4,gloss)*vis;
  col+=vec3(spec*mix(1.2,0.2,flatten))+emissive.rgb*(1.0+params.w);
  col=mix(col,vec3(2.2,2.2,2.4),vFlash);
  if(kind==2.0) alpha=mix(alpha,1.0,pow(1.0-ndv,3.0)*0.7);
  col=applyHaze(col,vWorld);
  // BLEND: premultiplied for the translucent pass (one, one - src alpha).
  if(blendPass) { color=sceneColor(col*alpha,alpha); return; }
  if(alphaMode==1.0 && alpha<cutoff) discard;
  color=sceneColor(col,1.0);
}`;
export const depthFragment = `void main() {}`;
// MASK shadow casters: cut out like the fill pass.
export const depthMaskFragment = `
in vec2 vUV; uniform sampler2D baseTex; uniform vec4 base; uniform float cutoff;
void main() { if(base.a*texture(baseTex,vUV).a<cutoff) discard; }`;
export const meshVertex = `
layout(location=0) in vec3 position; layout(location=1) in vec3 normal;
layout(location=2) in mat4 model; layout(location=6) in vec4 tint; layout(location=7) in vec4 params;
uniform bool inkPass;
out vec3 vNormal; out vec3 vWorld; out vec4 vColor; out vec4 vParams;
void main() {
  vec3 world=(model*vec4(position,1)).xyz, n=normalize((model*vec4(normal,0)).xyz);
  if(inkPass) { float w=inkWorldWidth(world)*params.y; world+=n*w-normalize(F.eye.xyz-world)*max(w*3.0,0.012)*step(0.0001,w); }
  gl_Position=project(world); vNormal=n; vWorld=world; vColor=tint; vParams=params;
}`;
export const meshFragment = `
in vec3 vNormal; in vec3 vWorld; in vec4 vColor; in vec4 vParams;
uniform bool inkPass; out vec4 color;
void main() {
  if(inkPass) { color=sceneColor(applyHaze(inkColor(vColor.rgb),vWorld),1.0); return; }
  vec3 n=normalize(vNormal), l=normalize(F.sun.xyz), v=normalize(F.eye.xyz-vWorld), base=vColor.rgb;
  vec3 col=shade(base,n,vWorld,0.7)*groundAO(vWorld);
  float rim=smoothstep(0.72,0.8,1.0-max(dot(n,v),0.0))*smoothstep(-0.2,0.35,dot(n,l))*(1.0-smoothstep(0.6,0.85,n.y));
  col+=mix(base*1.6,srgb(vec3(1,0.94,0.82)),0.55)*rim*F.look2.z*vParams.z*0.3;
  float spec=smoothstep(0.9,0.94,pow(max(dot(n,normalize(l+v)),0.0),24.0*vColor.a+4.0))*vColor.a;
  col+=vec3(spec*1.2)+base*vParams.w;
  col=mix(col,vec3(2.2,2.2,2.4),vParams.x);
  color=sceneColor(applyHaze(col,vWorld),1.0);
}`;
export const groundVertex = `
out vec3 vWorld;
void main() { vec2 p=floor(F.eye.xz)+corners[gl_VertexID]*200.0; vWorld=vec3(p.x,F.ground.w,p.y); gl_Position=project(vWorld); }
`;
export const groundFragment = `
in vec3 vWorld; out vec4 color;
float gridLine(float x,float w) { float f=abs(fract(x+0.5)-0.5), aa=fwidth(x)*1.2; return 1.0-smoothstep(w-aa,w+aa,f); }
void main() {
  vec3 base=F.ground.rgb*(0.92+0.16*fbm2(vWorld.xz*0.08));
  if(F.ink.w>0.0) {
    float fade=1.0-smoothstep(20.0,60.0,distance(F.eye.xz,vWorld.xz));
    float g=max(gridLine(vWorld.x,0.015),gridLine(vWorld.z,0.015));
    base=mix(base,base*0.72,g*F.ink.w*fade);
  }
  color=sceneColor(applyHaze(shade(base,vec3(0,1,0),vWorld,0.75),vWorld),1.0);
}`;
export const blobVertex = `
layout(location=0) in vec4 blob;
out vec2 vUV; out vec3 vWorld; out float vOpacity;
void main() {
  vec2 c=corners[gl_VertexID], off=-normalize(F.sun.xz+vec2(1e-4,0))*blob.z*0.1;
  vWorld=vec3(blob.x+c.x*blob.z+off.x,0.006,blob.y+c.y*blob.z+off.y);
  gl_Position=project(vWorld); vUV=c; vOpacity=blob.w;
}`;
export const blobFragment = `
in vec2 vUV; in vec3 vWorld; in float vOpacity; out vec4 color;
void main() {
  float r=length(vUV); if(r>1.0) discard;
  float a=(1.0-smoothstep(0.35,1.0,r))*vOpacity*F.shadowP.w*mix(0.35,1.0,shadowAt(vWorld,vec3(0,1,0)));
  color=sceneColor(srgb(vec3(0.18,0.16,0.3))*a,a);
}`;
export const particleVertex = `
layout(location=0) in vec4 a; layout(location=1) in vec4 b; layout(location=2) in vec4 c;
out vec2 vUV; flat out int vKind; out float vLife; out vec4 vColor; out float vAlpha;
void main() {
  vec2 corner=corners[gl_VertexID]; int kind=int(b.x+0.5); float life=b.y, size=a.w;
  if(kind==0) size*=1.0-life*0.6;
  if(kind==1) size*=sin(life*PI)*1.3;
  if(kind==2) size*=0.3+life*1.7;
  if(kind==4) size*=1.0-life*life;
  vec2 rc=vec2(corner.x*cos(b.z)-corner.y*sin(b.z),corner.x*sin(b.z)+corner.y*cos(b.z));
  vec3 world=a.xyz+(kind==2 ? vec3(corner.x,0,corner.y) : F.camRight.xyz*rc.x+F.camUp.xyz*rc.y)*size;
  gl_Position=project(world); vUV=corner; vKind=kind; vLife=life; vColor=c; vAlpha=b.w;
}`;
export const particleFragment = `
in vec2 vUV; flat in int vKind; in float vLife; in vec4 vColor; in float vAlpha; out vec4 color;
float starShape(vec2 uv,float points,float inner) {
  float k=cos(atan(uv.y,uv.x)*points)*0.5+0.5, edge=mix(inner,1.0,pow(k,3.0));
  return 1.0-smoothstep(edge-0.08,edge,length(uv));
}
void main() {
  float r=length(vUV), a=0.0; vec3 rgb=vColor.rgb*(1.0+vColor.w), col=vec3(0);
  if(vKind==0) { a=(1.0-smoothstep(0.0,1.0,r))*(1.0-vLife); col=rgb; }
  else if(vKind==1) { a=starShape(vUV,4.0,0.08); col=rgb*2.5; }
  else if(vKind==2) { a=(1.0-smoothstep(0.0,0.12,abs(r-0.85)))*(1.0-vLife); col=rgb*1.5; }
  else if(vKind==3) { if(max(abs(vUV.x),abs(vUV.y*1.6))>0.8) discard; a=1.0-smoothstep(0.7,1.0,vLife); col=rgb; }
  else if(vKind==4) { a=starShape(vUV,5.0,0.45); col=mix(srgb(vec3(0.12,0.08,0.15)),rgb*1.4,starShape(vUV*1.35,5.0,0.45)); }
  else discard;
  a*=vAlpha; if(a<=0.002) discard; color=sceneColor(col*a,a);
}`;
export const skyVertex = `out vec2 vNdc; void main() { vNdc=fullscreen[gl_VertexID]; gl_Position=vec4(vNdc,1,1); }`;
export const skyFragment = `
in vec2 vNdc; out vec4 color;
void main() {
  vec4 farPoint=F.invViewProj*vec4(vNdc,1,1), nearPoint=F.invViewProj*vec4(vNdc,0,1);
  vec3 dir=normalize(farPoint.xyz/farPoint.w-nearPoint.xyz/nearPoint.w), c=skyColor(dir);
  if(dir.y>0.0 && F.ink.z<1.0) {
    vec2 uv=dir.xz/(dir.y+0.25)*1.6+vec2(F.eye.w*0.01,0);
    float n=fbm2(uv*0.9)*0.75+fbm2(uv*2.3+5.0)*0.25;
    float band=smoothstep(0.02,0.18,dir.y)*(1.0-smoothstep(0.45,0.8,dir.y));
    float puff=smoothstep(0.54,0.6,n)*band, belly=smoothstep(0.54,0.7,fbm2(uv*0.9+vec2(0,0.08)));
    vec3 cloud=mix(srgb(vec3(0.86,0.9,1)),srgb(vec3(1,0.99,0.96)),belly);
    c=mix(c,cloud*1.05*cloudTint(),puff*0.9*(1.0-F.ink.z));
  }
  color=sceneColor(c,1.0);
}`;
export const postVertex = `out vec2 vUV; void main() { vec2 p=fullscreen[gl_VertexID]; gl_Position=vec4(p,0,1); vUV=p*0.5+0.5; }`;
export const postFragment = `
in vec2 vUV; out vec4 color; uniform sampler2D sourceTex; uniform sampler2D bloomTex; uniform highp sampler2D depthTex;
uniform int operation; uniform vec2 blurDir;
// Depth of field (post.wgsl): distance from the scene depth, blur outside the focus range, a 16-tap disc.
float sceneDistance(ivec2 px) {
  ivec2 size=textureSize(depthTex,0), p=clamp(px,ivec2(0),size-1);
  float d=texelFetch(depthTex,p,0).r;
  if(d>=1.0) return 1e6;
  vec2 uv=(vec2(p)+0.5)/vec2(size);
  vec4 w=F.invViewProj*vec4(uv*2.0-1.0,d,1.0);
  return distance(w.xyz/w.w,F.eye.xyz);
}
float dofBlur(float dist) { return max(1.0-smoothstep(F.dof.y*0.4,F.dof.y,dist),smoothstep(F.dof.z,F.dof.z*2.0,dist)); }
vec3 depthOfField(vec2 uv,vec2 pos,vec3 c) {
  float dist=sceneDistance(ivec2(pos)), blur=dofBlur(dist), radius=F.dof.x*blur*8.0*F.viewport.y/720.0;
  if(radius<0.5) return c;
  vec3 acc=c; float total=1.0;
  for(int i=0;i<16;i++) {
    float a=float(i)*2.39996323;
    vec2 o=vec2(cos(a),sin(a))*sqrt((float(i)+0.5)/16.0)*radius;
    float tapDist=sceneDistance(ivec2(pos+o)), w=1.0;
    if(tapDist<dist) w=clamp(dofBlur(tapDist)/max(blur,1e-3),0.0,1.0);
    acc+=texture(sourceTex,uv+o*F.viewport.zw).rgb*w; total+=w;
  }
  return acc/total;
}
vec3 tonemap(vec3 x) { return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),vec3(0),vec3(1)); }
float tonemap1(float x) { return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
void main() {
  vec3 c=texture(sourceTex,vUV).rgb;
  if(operation==0) {
    float l=max(c.r,max(c.g,c.b)), knee=0.3, threshold=F.ink.y;
    float soft=clamp(l-threshold+knee,0.0,2.0*knee); soft=soft*soft/(4.0*knee+1e-4);
    color=vec4(min(c*max(soft,l-threshold)/max(l,1e-4),vec3(16)),1); return;
  }
  if(operation==1) {
    const float weights[5]=float[5](0.227,0.194,0.121,0.054,0.016); c*=weights[0];
    for(int i=1;i<5;i++) { vec2 o=blurDir*float(i)*1.5; c+=(texture(sourceTex,vUV+o).rgb+texture(sourceTex,vUV-o).rgb)*weights[i]; }
    color=vec4(c,1); return;
  }
  if(F.dof.x>0.0) c=depthOfField(vUV,gl_FragCoord.xy,c);
  c=c/SCENE_SCALE+texture(bloomTex,vUV).rgb*F.look.w;
  c*=F.look2.x;
  vec3 per=tonemap(c); float l0=max(luma(c),1e-4); vec3 hue=c*(tonemap1(l0)/l0);
  vec3 keep=hue/max(max(max(hue.r,hue.g),hue.b),1.0);
  c=mix(per,keep,F.grade.y*smoothstep(0.3,0.85,tonemap1(l0)));
  vec3 g=pow(max(c,vec3(0)),vec3(1.0/2.2));
  g=mix(g,g*g*(3.0-2.0*g),clamp(F.grade.x-1.0,-1.0,1.0)*2.0);
  float lg=luma(g), sw=(1.0-smoothstep(0.0,0.55,lg))*F.grade.z, hw=smoothstep(0.55,1.0,lg)*F.grade.z;
  g+=vec3(-0.02,0,0.05)*sw+vec3(0.035,0.012,-0.03)*hw;
  g=mix(vec3(luma(g)),g,F.look.z);
  float dv=length((vUV-0.5)*vec2(F.camUp.w,1));
  g*=mix(1.0,0.76,smoothstep(0.45,1.1,dv)*F.look2.y);
  color=vec4(clamp(g,vec3(0),vec3(1)),1);
}`;
