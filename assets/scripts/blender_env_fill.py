"""Blender fill props + skyline for Scrapyard Dash (free, procedural, flat materials).
Run from game root: blender -b --python assets/scripts/blender_env_fill.py
Outputs game/public/assets/env/env_*.glb. glTF +Y up, pivot at feet centre, front = +Z.
Also shrinks the Tripo crane/plane textures to 1024 JPEG for mobile."""
import bpy, os, math, random
from mathutils import Vector
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "game/public/assets/env")
os.makedirs(OUT, exist_ok=True)

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

_mats = {}
def mat(name, col, rough=0.8, metal=0.0, emit=None, strength=1.0):
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*col, 1)
    b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1); b.inputs["Emission Strength"].default_value = strength
    return m

def add(obj, m):
    obj.data.materials.append(m); return obj

def box(m, loc, size, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object; o.scale = size; return add(o, m)

def cyl(m, loc, r, d, rot=(0, 0, 0), v=12):
    bpy.ops.mesh.primitive_cylinder_add(vertices=v, radius=r, depth=d, location=loc, rotation=rot)
    return add(bpy.context.object, m)

def torus(m, loc, R, r, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=14, minor_segments=6, location=loc, rotation=rot)
    return add(bpy.context.object, m)

def export(name):
    obs = [o for o in bpy.data.objects if o.type == "MESH"]
    for o in obs: o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    bpy.ops.object.join()
    o = bpy.context.object; o.name = name; o.data.name = name + "_mesh"
    # pivot: feet centre
    ws = [o.matrix_world @ v.co for v in o.data.vertices]
    cx = (min(w.x for w in ws) + max(w.x for w in ws)) / 2; cy = (min(w.y for w in ws) + max(w.y for w in ws)) / 2
    z0 = min(w.z for w in ws)
    for v in o.data.vertices: v.co -= o.matrix_world.inverted().to_3x3() @ Vector((cx, cy, z0))
    o.location = (0, 0, 0)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    p = os.path.join(OUT, name + ".glb")
    bpy.ops.export_scene.gltf(filepath=p, export_format="GLB", export_yup=True, export_apply=True, export_animations=False)
    print("EXPORT", name, os.path.getsize(p), "tris", sum(len(pp.vertices) - 2 for pp in o.data.polygons))

R = random.Random(7)
RUST = (0.55, 0.22, 0.08); RUST2 = (0.38, 0.17, 0.09); TEAL = (0.12, 0.35, 0.38); TIRE = (0.05, 0.05, 0.06)
WOOD = (0.48, 0.32, 0.17); STEEL = (0.42, 0.44, 0.48); YEL = (0.9, 0.62, 0.1); RED = (0.62, 0.12, 0.1); BLUE = (0.15, 0.25, 0.55)

# tire stack
reset(); m = mat("mat_tire", TIRE, 0.9)
for i, (x, y) in enumerate([(0, 0), (0, 0), (0, 0), (0, 0), (0.9, 0.2), (0.9, 0.2), (0.45, 0.1)]):
    z = [0.17, 0.5, 0.83, 1.16, 0.17, 0.5, 1.5][i]
    torus(m, (x + R.uniform(-.05, .05), y, z), 0.38, 0.17, (0, 0, R.random()))
export("env_tire_stack")

# corrugated sheets leaning
reset(); ms = [mat("mat_sheet_rust", RUST, 0.7, 0.4), mat("mat_sheet_teal", TEAL, 0.6, 0.4), mat("mat_sheet_steel", STEEL, 0.5, 0.7)]
for k in range(3):
    m = ms[k]; lean = 0.25 + k * 0.08
    for r in range(8):
        x = -1.1 + r * 0.3 + k * 0.2
        box(m, (x, k * 0.12, 1.1 * math.cos(lean)), (0.16, 0.05, 2.2), (lean, 0, 0)).location.y += (r % 2) * 0.04
export("env_corrugated_sheets")

# pallet stack
reset(); m = mat("mat_pallet", WOOD, 0.9)
for lvl in range(4):
    zb = lvl * 0.16; rot = R.uniform(-0.15, 0.15)
    for x in (-0.5, 0, 0.5): box(m, (x, 0, zb + 0.05), (0.1, 1.2, 0.1), (0, 0, rot))
    for y in (-0.5, -0.25, 0, 0.25, 0.5): box(m, (0, y, zb + 0.13), (1.2, 0.14, 0.03), (0, 0, rot))
export("env_pallet_stack")

# drum cluster
reset(); cols = [mat("mat_drum_blue", BLUE, 0.5, 0.5), mat("mat_drum_red", RED, 0.5, 0.5), mat("mat_drum_yel", YEL, 0.5, 0.5)]
band = mat("mat_drum_band", (0.1, 0.1, 0.1), 0.6, 0.6)
for i, (x, y, z, tip) in enumerate([(0, 0, 0.45, 0), (0.65, 0.1, 0.45, 0), (0.3, 0.6, 0.45, 0), (0.33, 0.25, 1.35, 0), (-0.8, 0.3, 0.3, 1.5708)]):
    rot = (tip, 0, R.random())
    cyl(cols[i % 3], (x, y, z), 0.3, 0.9, rot, 14)
    if not tip:
        for dz in (-0.25, 0.25): cyl(band, (x, y, z + dz), 0.31, 0.05, rot, 14)
export("env_drum_cluster")

# neon billboard frame
reset(); fr = mat("mat_bb_frame", (0.12, 0.1, 0.12), 0.6, 0.7)
pink = mat("mat_bb_neon_pink", (1, 0.2, 0.6), 0.4, 0, (1, 0.15, 0.6), 4); cyan = mat("mat_bb_neon_cyan", (0.2, 0.9, 1), 0.4, 0, (0.1, 0.9, 1), 4)
panel = mat("mat_bb_panel", (0.16, 0.08, 0.22), 0.8)
for x in (-1.4, 1.4): box(fr, (x, 0, 2.2), (0.18, 0.18, 4.4))
box(fr, (0, 0, 2.6), (3.2, 0.12, 0.12)); box(fr, (0, 0, 5.1), (3.2, 0.12, 0.12))
box(panel, (0, 0.04, 3.85), (3.0, 0.05, 2.4))
box(pink, (0, -0.02, 4.35), (2.4, 0.06, 0.2)); box(cyan, (-0.3, -0.02, 3.6), (1.8, 0.06, 0.16))
box(pink, (0.95, -0.02, 3.3), (0.5, 0.06, 0.5)); box(cyan, (0, -0.02, 5.25), (3.3, 0.06, 0.08))
export("env_neon_billboard")

# scrap pipes
reset(); ms = [mat("mat_pipe_rust", RUST2, 0.7, 0.5), mat("mat_pipe_steel", STEEL, 0.4, 0.8), mat("mat_pipe_yel", YEL, 0.5, 0.4)]
for i, (x, z, r) in enumerate([(0, 0.4, 0.4), (0.85, 0.4, 0.4), (0.42, 1.08, 0.38), (-0.75, 0.25, 0.25), (1.5, 0.22, 0.22)]):
    cyl(ms[i % 3], (x, R.uniform(-.3, .3), z), r, 3.2 + R.uniform(-.5, .5), (math.pi / 2, 0, R.uniform(-.2, .2)), 14)
export("env_scrap_pipes")

# fence panels (chain-link look: posts + wire grid bars)
reset(); post = mat("mat_fence_post", STEEL, 0.5, 0.8); wire = mat("mat_fence_wire", (0.3, 0.32, 0.35), 0.5, 0.8)
for x in (-2, 0, 2): cyl(post, (x, 0, 1.1), 0.05, 2.2, (0, 0, 0), 8)
for z in (0.1, 2.15): box(post, (0, 0, z), (4.0, 0.04, 0.04))
for i in range(16): box(wire, (-1.9 + i * 0.25, 0, 1.1), (0.015, 0.015, 2.0), (0, 0.45 if i % 2 else -0.45, 0))
for i in range(8): box(wire, (0, 0, 0.3 + i * 0.25), (4.0, 0.015, 0.015))
export("env_fence_panel")

# shipping container stack (Blender, replaces 3rd Tripo hero)
reset(); cs = [mat("mat_cont_red", (0.55, 0.12, 0.08), 0.6, 0.4), mat("mat_cont_teal", TEAL, 0.6, 0.4), mat("mat_cont_yel", (0.75, 0.5, 0.1), 0.6, 0.4)]
rib = mat("mat_cont_rib", (0.08, 0.07, 0.07), 0.7, 0.5)
for i, (x, z, rz) in enumerate([(0, 1.3, 0), (2.6, 1.3, 0.05), (1.2, 3.9, -0.12)]):
    box(cs[i], (x, 0, z), (2.44, 6.0, 2.6), (0, 0, rz))
    for k in range(9): box(rib, (x + 1.24, -2.8 + k * 0.7, z), (0.04, 0.1, 2.5), (0, 0, rz))
export("env_container_stack")

# scrap heap landmark (Blender, replaces 4th Tripo hero)
reset(); ms = [mat("mat_heap_a", RUST, 0.8, 0.4), mat("mat_heap_b", RUST2, 0.8, 0.3), mat("mat_heap_c", STEEL, 0.6, 0.7), mat("mat_heap_d", TEAL, 0.7, 0.4), mat("mat_heap_e", YEL, 0.6, 0.3)]
bpy.ops.mesh.primitive_cone_add(vertices=10, radius1=4.5, depth=5, location=(0, 0, 2.5)); add(bpy.context.object, ms[1])
for i in range(40):
    a = R.random() * 6.283; rr = R.uniform(0, 4); h = 5 * (1 - rr / 4.5) * R.uniform(0.6, 1.05)
    box(ms[i % 5], (math.cos(a) * rr, math.sin(a) * rr, h), (R.uniform(.5, 1.6), R.uniform(.4, 1.4), R.uniform(.3, 1)), (R.random() * 3, R.random() * 3, R.random() * 3))
cyl(ms[2], (0.5, 0, 6.3), 0.08, 2.6, (0.2, 0.15, 0), 6)
export("env_scrap_heap")

# skyline (v2, owner 2026-11-04: no rectangular building slabs): irregular scrap mounds, crane
# silhouettes, angled scrap sheets and distant wrecks, 160 m wide, front = +Z.
reset(); sil = mat("mat_skyline", (0.16, 0.09, 0.22), 1.0); glow = mat("mat_skyline_win", (1, 0.7, 0.4), 1, 0, (1, 0.62, 0.3), 3)
x = -80
while x < 80:
    k = R.random(); near = abs(x) < 10
    if k < 0.45:  # scrap mound: lumpy low-poly cone
        r = R.uniform(4, 9); h = R.uniform(3, 7) if near else R.uniform(5, 14)
        bpy.ops.mesh.primitive_cone_add(vertices=R.randint(5, 8), radius1=r, depth=h, location=(x + r, 0, h / 2), rotation=(0, R.uniform(-0.15, 0.15), R.uniform(0, 3)))
        add(bpy.context.object, sil); w = r * 1.6
    elif k < 0.65 and not near:  # crane silhouette: mast + jib + cable
        h = R.uniform(18, 30)
        cyl(sil, (x, 0, h / 2), 0.5, h, (0, 0, 0), 4)
        cyl(sil, (x + 5, 0, h), 0.3, 16, (0, math.pi / 2 + R.uniform(-0.1, 0.1), 0), 4)
        cyl(sil, (x + 10, 0, h - 4), 0.05, 8, (0, 0, 0), 4)
        bpy.ops.mesh.primitive_uv_sphere_add(segments=6, ring_count=4, radius=0.4, location=(x, 0, h + 0.6)); add(bpy.context.object, glow)
        w = 10
    elif k < 0.85:  # angled scrap sheets leaning together
        for _ in range(R.randint(2, 4)):
            l = R.uniform(5, 12)
            cyl(sil, (x + R.uniform(0, 5), 0, l * 0.35), R.uniform(1.2, 2.2), l, (0, R.uniform(-0.7, 0.7), math.pi / 2), 3)
        w = 7
    else:  # distant wreck: tipped hull (squashed sphere) with a stack
        bpy.ops.mesh.primitive_uv_sphere_add(segments=8, ring_count=5, radius=1, location=(x + 6, 0, 2), rotation=(0, R.uniform(-0.4, 0.4), 0))
        o = bpy.context.object; o.scale = (7, 1.5, 3); add(o, sil)
        cyl(sil, (x + 7, 0, 6), 0.6, 5, (0, 0.3, 0), 6)
        w = 13
    x += w + R.uniform(-2, 1.5)
export("env_skyline")

# clouds: flat stylized puff cards (lit sunset pink), 30 m cluster
reset(); cl = mat("mat_cloud", (1, 0.7, 0.62), 1, 0, (1, 0.62, 0.55), 0.6)
for i in range(18):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=10, ring_count=6, radius=R.uniform(2, 4.5), location=(R.uniform(-14, 14), R.uniform(-2, 2), R.uniform(0, 2.5)))
    o = bpy.context.object; o.scale = (1.6, 0.6, 0.7); add(o, cl)
export("env_clouds")

# shrink Tripo textures (crane, plane) to 1024 JPEG
for rel in ("game/public/assets/env/env_crane.glb", "game/public/assets/props/prop_scrap_plane.glb"):
    p = os.path.join(ROOT, rel); reset(); bpy.ops.import_scene.gltf(filepath=p)
    for img in bpy.data.images:
        if img.size[0] > 1024: img.scale(1024, 1024)
    bpy.ops.export_scene.gltf(filepath=p, export_format="GLB", export_yup=True, export_image_format="JPEG", export_jpeg_quality=85, export_animations=False)
    print("SHRUNK", rel, os.path.getsize(p))
