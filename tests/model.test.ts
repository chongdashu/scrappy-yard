import { describe, expect, it, vi } from 'vitest';
import { ModelRenderer, ALPHA_MODE, MAT_FLOATS, alphaModeOf, materialSlot, type ModelDriver, type GpuModel, type TranslucentDraw } from '../src/gpu/model';
import type { Renderer, TranslucentHook } from '../src/gpu/renderer';
import { IDENTITY, materialOptions, parseGlb, type GltfDoc } from '../src/gltf/glb';
import { buildGlb, box, quad } from './fixtures/glb';

function fixture() {
  const node = (name: string, parent = -1, x = 0, children: number[] = []) => ({name,parent,children,t:[x,0,0] as [number,number,number],r:[0,0,0,1] as [number,number,number,number],s:[1,1,1] as [number,number,number],mesh:0,skin:-1,extras:{}});
  const doc: GltfDoc = {
    url:'fixture',roots:[0,2],extensionsUsed:[],skins:[],clips:[],
    nodes:[node('body',-1,0,[1]),node('child',0,2),node('col_wall',-1,100,[3]),node('hidden_child',2)],
    meshes:[{name:'triangle',primitives:[{positions:new Float32Array([0,0,0,1,0,0,0,1,0]),normals:new Float32Array([0,0,1,0,0,1,0,0,1]),indices:new Uint32Array([0,1,2]),material:0}]}],
    materials:[{name:'paint',baseColor:[0.2,0.3,0.4,1],emissive:[0,0,0],emissiveStrength:1}],
  };
  const submissions: GpuModel[][] = [];
  const driver: ModelDriver = {upload:vi.fn(),update:vi.fn(),retexture:vi.fn(),draw:vi.fn(models=>{submissions.push([...models]);return {draws:models.length,triangles:models.length};})};
  const renderer = {createModelDriver:()=>driver,shadowHooks:[]} as unknown as Renderer;
  return {doc,models:new ModelRenderer(renderer),driver,submissions};
}

describe('shared model state',()=>{
  it('shares geometry but keeps each instance pose and recolour independent',()=>{
    const {doc,models}=fixture(); const original=models.upload(doc), copy=models.instance(original);
    const root=new Float32Array(IDENTITY); root[12]=10;
    models.prepareStatic(copy,{root,flash:0.5});
    models.recolor(copy,new Map([['child/paint',[1,0,0]]]));
    expect(copy.primitives[0].geometry).toBe(original.primitives[0].geometry);
    expect(copy.world[12]).toBe(10); expect(copy.world[28]).toBe(12); expect(original.world[12]).toBe(0);
    expect(copy.params[0]).toBe(0.5); expect(original.params[0]).toBe(0);
    expect(copy.draws[1]).toBe(0); expect(copy.draws[5]).toBe(2); expect(original.draws[5]).toBe(0);
    expect([...copy.materials.slice(24,27)]).toEqual([1,0,0]);
    models.recolor(copy,null); expect(copy.materials).toEqual(copy.matBase); expect(copy.draws).toEqual(copy.drawBase);
  });
  it('recolours the emissive colour by material name, keeping the file\'s emissive strength, and puts everything back on reset',()=>{
    const {doc,models}=fixture(); doc.materials[0].emissive=[1,0.2,0.1]; doc.materials[0].emissiveStrength=3;
    const m=models.upload(doc), before=new Float32Array(m.materials);
    // The base colour alone leaves the emissive row alone (what recolor always did).
    models.recolor(m,new Map([['paint',[0.9,0.8,0.7]]]));
    expect([...m.materials.slice(0,3)]).toEqual([expect.closeTo(0.9,5),expect.closeTo(0.8,5),expect.closeTo(0.7,5)]);
    expect([...m.materials.slice(4,7)]).toEqual([...before.slice(4,7)]);
    // The glow writes rgb times the strength into the emissive row and touches nothing else.
    models.recolor(m,null,new Map([['paint',[0.5,0.25,1]]]));
    expect([...m.materials.slice(4,7)]).toEqual([1.5,0.75,3]);
    expect([...m.materials.slice(0,4)]).toEqual([...before.slice(0,4)]);
    expect([...m.materials.slice(7,12)]).toEqual([...before.slice(7,12)]);
    // Both at once, a name the model lacks is skipped, and no glow at all is byte-for-byte the old recolour.
    models.recolor(m,new Map([['paint',[0.1,0.2,0.3]],['nothing',[1,1,1]]]),new Map([['paint',[1,1,1]],['nothing',[1,1,1]]]));
    expect([...m.materials.slice(4,7)]).toEqual([3,3,3]);
    expect(m.materials.slice(0,3)[0]).toBeCloseTo(0.1,5);
    models.recolor(m,new Map([['paint',[0.1,0.2,0.3]]]),null);
    expect([...m.materials.slice(4,7)]).toEqual([...before.slice(4,7)]);
    models.recolor(m,null,null); expect(m.materials).toEqual(m.matBase);
  });
  it('gives a node its own emissive colour through a spare material slot, shared with its base colour edit',()=>{
    const {doc,models}=fixture(); doc.materials[0].emissive=[1,1,1]; doc.materials[0].emissiveStrength=2;
    const m=models.upload(doc);
    models.recolor(m,new Map([['child/paint',[0,1,0]]]),new Map([['child/paint',[1,0,0]]]));
    // One slot (index 2 -> floats 24..35) holds both edits; the other node keeps the file's material.
    expect([...m.materials.slice(24,27)]).toEqual([0,1,0]);
    expect([...m.materials.slice(28,31)]).toEqual([2,0,0]);
    expect(m.draws[5]).toBe(2); expect(m.draws[1]).toBe(0);
    expect([...m.materials.slice(4,7)]).toEqual([2,2,2]);
    models.recolor(m,null,null); expect(m.materials).toEqual(m.matBase); expect(m.draws).toEqual(m.drawBase);
  });
  it('releases a group of models to the driver and takes them out of the draw queue',()=>{
    const {doc,models,driver,submissions}=fixture(), a=models.upload(doc), b=models.instance(a);
    models.prepareStatic(a); models.prepareStatic(b);
    (driver as {release?:unknown}).release=vi.fn(); (driver as {resources?:unknown}).resources=vi.fn(()=>({buffers:3,textures:1,bytes:99}));
    models.release([a,b]);
    expect((driver as unknown as {release:ReturnType<typeof vi.fn>}).release).toHaveBeenCalledWith([a,b]);
    models.draw(); expect(submissions).toEqual([[]]);
    expect(models.resources()).toEqual({buffers:3,textures:1,bytes:99});
    // A driver that does not count or free still lets the room go.
    delete (driver as {release?:unknown}).release; delete (driver as {resources?:unknown}).resources;
    expect(()=>models.release([a])).not.toThrow(); expect(models.resources()).toBeNull();
  });
  it('preserves queued models when another model is uploaded or instanced mid-frame',()=>{
    const {doc,models,submissions}=fixture(), first=models.upload(doc);
    models.prepareStatic(first); models.upload(doc); models.instance(first);
    models.drawShadow(); models.draw(); models.draw();
    expect(submissions).toEqual([[first],[first],[]]);
  });
  it('propagates world overrides and hides collider descendants',()=>{
    const {doc,models}=fixture(), model=models.upload(doc), override=new Float32Array(IDENTITY);
    override[12]=5; models.prepareStatic(model,{override:new Map([[0,override]])});
    expect(model.world[12]).toBe(5); expect(model.world[28]).toBe(7);
    expect([...model.hidden]).toEqual([0,0,1,1]);
  });
});

describe('glTF material kinds and alpha modes',()=>{
  it('reads alphaMode, alphaCutoff and the vgd kind from material JSON',()=>{
    expect(materialOptions({})).toEqual({alphaMode:'OPAQUE',alphaCutoff:0.5,kind:'default'});
    expect(materialOptions({alphaMode:'MASK',alphaCutoff:0.3})).toEqual({alphaMode:'MASK',alphaCutoff:0.3,kind:'default'});
    expect(materialOptions({alphaMode:'BLEND',extras:{vgd_kind:'liquid'}})).toEqual({alphaMode:'BLEND',alphaCutoff:0.5,kind:'liquid'});
    // Blender's custom property group (a dict) arrives nested; names are case- and space-tolerant.
    expect(materialOptions({extras:{vgd:{kind:' Foliage '}}}).kind).toBe('foliage');
    expect(materialOptions({extras:{vgd_kind:'bump'}}).kind).toBe('bump');
    expect(materialOptions({extras:{vgd:{kind:'BUMP'}}}).kind).toBe('bump');
    expect(materialSlot({name:'ground',baseColor:[1,1,1,1],emissive:[0,0,0],emissiveStrength:1,kind:'bump'})[9]).toBe(3); // KIND_BUMP in both shaders
    // The flat property wins over the group when both are present.
    expect(materialOptions({extras:{vgd_kind:'liquid',vgd:{kind:'foliage'}}}).kind).toBe('liquid');
    expect(materialOptions({alphaCutoff:7}).alphaCutoff).toBe(1);
    expect(materialOptions({alphaCutoff:'x'}).alphaCutoff).toBe(0.5);
  });
  it('falls back on unknown values and says why',()=>{
    const warn=vi.fn();
    expect(materialOptions({alphaMode:'ADD',extras:{vgd_kind:'lava'}},warn)).toEqual({alphaMode:'OPAQUE',alphaCutoff:0.5,kind:'default'});
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.join(' ')).toMatch(/ADD.*lava|lava.*ADD/s);
    expect(materialOptions({extras:{other:1}},warn).kind).toBe('default');
    expect(warn).toHaveBeenCalledTimes(2);
  });
  it('parses them from a GLB into the material slots',async()=>{
    const glb=buildGlb({
      materials:[
        {name:'mat_stone',pbrMetallicRoughness:{baseColorFactor:[0.5,0.5,0.5,1],roughnessFactor:0.8}},
        {name:'mat_leaves',alphaMode:'MASK',alphaCutoff:0.4,extras:{vgd_kind:'foliage'}},
        {name:'mat_water',alphaMode:'BLEND',pbrMetallicRoughness:{baseColorFactor:[0.2,0.4,0.6,0.5]},extras:{vgd:{kind:'liquid'}}},
      ],
      meshes:[box(1,1,1,0),quad(1,1,1),quad(2,2,2)],
      nodes:[{name:'stone',mesh:0},{name:'leaves',mesh:1,translation:[0,1,0]},{name:'water',mesh:2,translation:[0,0,3]}],
    });
    const doc=await parseGlb(glb,'materials.glb');
    expect(doc.materials.map(m=>[m.name,m.alphaMode,m.alphaCutoff,m.kind])).toEqual([
      ['mat_stone','OPAQUE',0.5,'default'],['mat_leaves','MASK',expect.closeTo(0.4,5),'foliage'],['mat_water','BLEND',0.5,'liquid'],
    ]);
    const {models}=fixture(), model=models.upload(doc);
    const slot=(i:number)=>[...model.materials.slice(i*MAT_FLOATS+8,i*MAT_FLOATS+12)];
    expect(slot(0)).toEqual([expect.closeTo(0.2,5),0,ALPHA_MODE.OPAQUE,0.5]);
    expect(slot(1)).toEqual([0,1,ALPHA_MODE.MASK,expect.closeTo(0.4,5)]);
    expect(slot(2)).toEqual([0,2,ALPHA_MODE.BLEND,0.5]);
    expect(model.materials[2*MAT_FLOATS+3]).toBe(0.5);
    expect(model.primitives.map((_,i)=>alphaModeOf(model,i))).toEqual([0,1,2]);
    expect(model.primitives[0].center).toEqual([0,0,0]);
  });
});

describe('translucent pass',()=>{
  function scene(){
    const hooks:TranslucentHook[]=[];
    const translucent:TranslucentDraw[][]=[];
    const driver:ModelDriver={upload:vi.fn(),update:vi.fn(),retexture:vi.fn(),draw:vi.fn(()=>({draws:1,triangles:2})),
      drawTranslucent:vi.fn((items)=>{translucent.push([...items]);return {draws:items.length,triangles:items.length*2};})};
    const renderer={createModelDriver:()=>driver,shadowHooks:[],translucentHooks:hooks} as unknown as Renderer;
    return {models:new ModelRenderer(renderer),hooks,translucent,driver};
  }
  async function water(){
    return parseGlb(buildGlb({
      materials:[{name:'mat_rock'},{name:'mat_glass',alphaMode:'BLEND'}],
      meshes:[box(1,1,1,0),quad(1,1,1)],
      nodes:[{name:'rock',mesh:0},{name:'near',mesh:1,translation:[0,0,2]},{name:'far',mesh:1,translation:[0,0,-6]},{name:'col_hidden',mesh:1,translation:[0,0,-9]}],
    }));
  }
  it('registers a hook and draws BLEND primitives after the opaque pass, back to front across models',async()=>{
    const {models,hooks,translucent}=scene(), doc=await water();
    const a=models.upload(doc), b=models.instance(a);
    const root=new Float32Array(IDENTITY); root[14]=-20; // b sits 20 m further away
    models.prepareStatic(a); models.prepareStatic(b,{root});
    models.draw();
    expect(hooks).toHaveLength(1);
    hooks[0]([0,0,10]);
    // Farthest first: b's far, b's near, a's far, a's near; colliders and opaque primitives are not in the list.
    expect(translucent[0].map(t=>[t.model===a?'a':'b',doc.nodes[t.model.primitives[t.primitive].node].name])).toEqual([['b','far'],['b','near'],['a','far'],['a','near']]);
    expect(models.stats).toEqual({draws:5,triangles:10,translucent:4});
    // Nothing is left over for the next frame.
    hooks[0]([0,0,10]); expect(translucent).toHaveLength(1);
  });
  it('re-sorts as the eye moves and drops released models',async()=>{
    const {models,hooks,translucent}=scene(), doc=await water();
    const a=models.upload(doc);
    models.prepareStatic(a); models.draw(); hooks[0]([0,0,-30]);
    expect(translucent[0].map(t=>doc.nodes[t.model.primitives[t.primitive].node].name)).toEqual(['near','far']);
    models.prepareStatic(a); models.draw(); models.release([a]); hooks[0]([0,0,10]);
    expect(translucent).toHaveLength(1);
  });
});

