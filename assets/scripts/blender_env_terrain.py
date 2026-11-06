"""Side terrain strip for Scrapyard Dash (free, procedural, flat materials).
Run from game root: blender -b --python assets/scripts/blender_env_terrain.py
Outputs game/public/assets/env/env_side_terrain.glb.
One 8 m tile of ground beside the track: glTF origin at the track edge (x = 0), y = 0 is the
deck top, the strip runs x 0 → 40 m outward and z 0 → 8 m (tiles along z, periodic so seams
match). A concrete curb runs along the inner edge, a jagged cliff skirt drops to y = −7 (the pit
floor) under it so gaps read as trenches, the flat yard (x ≈ 0.6–20) holds the fill props and
landmarks at y ≈ 0, and a scrap berm rises to ~3.5 m beyond x ≈ 22. Half-buried scrap bits
(plates, pipe stubs, tyre halves) dress the dirt. The game mirrors it (yaw π) for the left side."""
import bpy, bmesh, os, math, random
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "game/public/assets/env")
L = 8.0  # tile length (= LANE_TILE)
R = random.Random(11)
bpy.ops.wm.read_factory_settings(use_empty=True)

def mat(name, col, rough=0.9, metal=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*col, 1)
    b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    return m
M_DIRT = mat("mat_terrain_dirt", (0.30, 0.22, 0.15))
M_OIL = mat("mat_terrain_oil", (0.12, 0.11, 0.11), 0.6)
M_RUSTSOIL = mat("mat_terrain_rustsoil", (0.42, 0.20, 0.09))
M_BERM = mat("mat_terrain_berm", (0.24, 0.20, 0.18))
M_ROCK = mat("mat_terrain_rock", (0.20, 0.17, 0.15))
M_CURB = mat("mat_terrain_curb", (0.55, 0.53, 0.48), 0.8)
M_STRIPE = mat("mat_terrain_stripe", (0.85, 0.62, 0.08), 0.7)
M_RUST = mat("mat_terrain_scrap_rust", (0.40, 0.17, 0.07), 0.7, 0.4)
M_STEEL = mat("mat_terrain_scrap_steel", (0.40, 0.42, 0.46), 0.5, 0.7)
M_TIRE = mat("mat_terrain_tire", (0.05, 0.05, 0.06))
MATS = [M_DIRT, M_OIL, M_RUSTSOIL, M_BERM, M_ROCK, M_CURB, M_STRIPE, M_RUST, M_STEEL, M_TIRE]
TAU = math.pi * 2

def smooth(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)

def per(z, k, ph):  # periodic in z over the tile
    return math.sin(TAU * k * z / L + ph)

def height(x, z):
    bump = 0.05 * per(z, 1, x * 0.9) * math.sin(x * 1.3) + 0.03 * per(z, 3, x * 2.1)
    yard = -0.05 + bump * smooth(0.6, 1.4, x)
    berm = smooth(19, 30, x) * (3.4 + 0.6 * per(z, 1, x * 0.35) + 0.35 * per(z, 2, x * 0.8 + 1))
    lump = smooth(19, 26, x) * 0.25 * per(z, 4, x * 1.7) * math.sin(x * 2.3)
    return yard + berm + lump

def tag(x, z):  # material id per face
    if x > 21: return 3
    n = per(z, 1, x * 0.6) * math.sin(x * 0.45 + 1) + 0.5 * per(z, 2, x * 1.1)
    return 1 if n > 0.75 else 2 if n < -0.8 else 0

me = bpy.data.meshes.new("terrain"); ob = bpy.data.objects.new("terrain", me)
bpy.context.collection.objects.link(ob)
for m in MATS: me.materials.append(m)
bm = bmesh.new()
# Grid: fine near the track, coarser out on the berm. Blender (x, -z, y) = glTF (x, y, z).
xs = [0.45 + i * 0.5 for i in range(0, 20)]  # 0.45 .. 9.95
while xs[-1] < 40: xs.append(min(40.0, xs[-1] + (1.0 if xs[-1] < 22 else 1.5)))
zs = [i * 0.8 for i in range(int(L / 0.8) + 1)]
V = [[bm.verts.new((x, -z, height(x, z % L))) for z in zs] for x in xs]
for i in range(len(xs) - 1):
    for j in range(len(zs) - 1):
        f = bm.faces.new((V[i][j], V[i + 1][j], V[i + 1][j + 1], V[i][j + 1]))
        f.material_index = MATS.index([M_DIRT, M_OIL, M_RUSTSOIL, M_BERM][tag((xs[i] + xs[i + 1]) / 2, (zs[j] + zs[j + 1]) / 2)])
# Cliff skirt under the curb: jagged rock face from y = 0 down to −7 at x ≈ 0..0.4.
top = [bm.verts.new((0.0, -z, -0.02)) for z in zs]
mid = [bm.verts.new((0.15 + 0.25 * (0.5 + 0.5 * per(z, 2, 0.7)), -z, -2.5)) for z in zs]
bot = [bm.verts.new((0.6 + 0.5 * (0.5 + 0.5 * per(z, 3, 1.9)), -z, -7.2)) for z in zs]
for j in range(len(zs) - 1):
    for a, b in ((top, mid), (mid, bot)):
        f = bm.faces.new((a[j + 1], b[j + 1], b[j], a[j])); f.material_index = MATS.index(M_ROCK)
    f = bm.faces.new((top[j], V[0][j], V[0][j + 1], top[j + 1])); f.material_index = MATS.index(M_ROCK)
bm.normal_update(); bm.to_mesh(me); bm.free()
# Recalc normals so all faces point up / toward the track.
bpy.context.view_layer.objects.active = ob; ob.select_set(True)
bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.normals_make_consistent(inside=False); bpy.ops.object.mode_set(mode="OBJECT")

def prim(kind, m, loc, size=(1, 1, 1), rot=(0, 0, 0), **kw):
    getattr(bpy.ops.mesh, "primitive_%s_add" % kind)(location=loc, rotation=rot, **kw)
    o = bpy.context.object; o.scale = size; o.data.materials.append(m); return o

# Curb along the inner edge: two 3.9 m concrete segments with hazard-stripe caps; fence-post stubs.
for k in range(2):
    zc = 2.0 + k * 4.0
    prim("cube", M_CURB, (0.28, -zc, 0.06), (0.5, 3.9, 0.26))
    prim("cube", M_STRIPE, (0.06, -zc, 0.2), (0.08, 3.9, 0.04))
for zc in (0.2, 4.2):
    prim("cylinder", M_STEEL, (0.42, -zc, 0.35), (1, 1, 1), vertices=6, radius=0.05, depth=0.5)
# Half-buried scrap in the dirt: plates, pipe stubs, tyre halves (kept low in the prop row x 1.5–3.6).
for n in range(16):
    x = R.uniform(0.8, 30); z = R.uniform(0.3, L - 0.3)
    low = 1.4 < x < 3.8 or 8.5 < x < 18
    y = height(x, z); k = R.random(); s = 0.6 if low else 1.0 + (x > 20) * R.uniform(0.5, 1.4)
    if k < 0.45:
        prim("cube", R.choice([M_RUST, M_STEEL, M_RUST]), (x, -z, y + 0.03 * s), (0.55 * s, 0.4 * s, 0.05 * s),
             (R.uniform(-0.35, 0.35), R.uniform(-0.35, 0.35), R.uniform(0, TAU)))
    elif k < 0.75:
        prim("cylinder", M_RUST, (x, -z, y + 0.05 * s), (1, 1, 1), (R.uniform(0.9, 1.4), 0, R.uniform(0, TAU)),
             vertices=6, radius=0.1 * s, depth=0.9 * s)
    else:
        prim("torus", M_TIRE, (x, -z, y), (s, s, s), (R.uniform(1.2, 1.9), 0, R.uniform(0, TAU)),
             major_radius=0.32, minor_radius=0.13, major_segments=9, minor_segments=4)
# Join and export with the origin left at the track edge.
for o in bpy.data.objects: o.select_set(o.type == "MESH")
bpy.context.view_layer.objects.active = ob
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
bpy.ops.object.join(); ob = bpy.context.object; ob.name = "env_side_terrain"; ob.data.name = "env_side_terrain_mesh"
p = os.path.join(OUT, "env_side_terrain.glb")
bpy.ops.export_scene.gltf(filepath=p, export_format="GLB", export_yup=True, export_apply=True, export_animations=False)
print("EXPORT env_side_terrain", os.path.getsize(p), "tris", sum(len(pp.vertices) - 2 for pp in ob.data.polygons))
