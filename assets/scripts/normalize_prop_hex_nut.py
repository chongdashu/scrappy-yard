"""Rerunnable build for prop_hex_nut (Blender-only, no generation).

Outputs:
  assets/blender/props/prop_hex_nut.blend
  game/public/assets/props/prop_hex_nut.glb
  out/blender/reimport-prop_hex_nut.txt

Run from the game root:
  blender -b --python assets/scripts/normalize_prop_hex_nut.py

What it builds (asset contract: 0.5 × 0.5 × 0.14 m, centre-bottom pivot):
  * upright hex nut: axis along glTF Z (faces the oncoming camera), a flat on the
    ground, across-flats 0.50 m (H); the two side corners are chamfered to 0.50 m
    so W = H (a regular hexagon would be 0.577 m wide)
  * 0.14 m thick (glTF Z), bored hole r = 0.12 m, bevelled edges for the toy look
  * pivot: bottom rim centre on y = 0, x = z = 0; transforms applied (unit scale)
  * one material mat_nut_neon: flat neon gold, emissive ×1 (reads under dusk light)
"""
import bpy, bmesh, os, math
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ID = "prop_hex_nut"
BLEND = os.path.join(ROOT, "assets/blender/props", ID + ".blend")
GLB = os.path.join(ROOT, "game/public/assets/props", ID + ".glb")
REPORT = os.path.join(ROOT, "out/blender/reimport-" + ID + ".txt")
H, W, D, HOLE_R = 0.50, 0.50, 0.14, 0.12

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.unit_settings.system = "METRIC"; sc.unit_settings.scale_length = 1.0

# Hex outline in the Blender XZ plane (front = −Y = glTF +Z). Flat on the bottom.
R = H / 2 / math.cos(math.radians(30))  # circumradius for across-flats H
outline = []
for i in range(6):
    a = math.radians(i * 60)  # corners at 0°, 60°… → flats top/bottom
    outline.append((R * math.cos(a), R * math.sin(a)))
# chamfer the two side corners (±R, 0) to |x| = W/2
half_w = W / 2
pts = []
for i, (x, z) in enumerate(outline):
    if abs(z) < 1e-6:  # side corner → two points on the vertical chamfer
        s = 1 if x > 0 else -1
        dz = (R - half_w) * math.tan(math.radians(60))
        pts += [(s * half_w, -dz * s), (s * half_w, dz * s)] if s > 0 else [(s * half_w, dz), (s * half_w, -dz)]
    else:
        pts.append((x, z))

bm = bmesh.new()
front = [bm.verts.new((x, -D / 2, z + H / 2)) for x, z in pts]
face = bm.faces.new(front)
bm.normal_update()
if face.normal.y > 0:
    face.normal_flip()
ext = bmesh.ops.extrude_face_region(bm, geom=[face])
moved = [g for g in ext["geom"] if isinstance(g, bmesh.types.BMVert)]
bmesh.ops.translate(bm, verts=moved, vec=(0, D, 0))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
me = bpy.data.meshes.new(ID)
bm.to_mesh(me); bm.free()
nut = bpy.data.objects.new(ID, me)
sc.collection.objects.link(nut)

# bore
bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=HOLE_R, depth=D * 3, location=(0, 0, H / 2), rotation=(math.pi / 2, 0, 0))
cutter = bpy.context.active_object
bool_m = nut.modifiers.new("bore", "BOOLEAN"); bool_m.object = cutter; bool_m.operation = "DIFFERENCE"; bool_m.solver = "EXACT"
bev = nut.modifiers.new("bevel", "BEVEL"); bev.width = 0.018; bev.segments = 2; bev.limit_method = "ANGLE"; bev.angle_limit = math.radians(35)
bpy.context.view_layer.objects.active = nut
for m in list(nut.modifiers):
    bpy.ops.object.modifier_apply(modifier=m.name)
bpy.data.objects.remove(cutter)
for p in nut.data.polygons:
    p.use_smooth = False

# material
mat = bpy.data.materials.new("mat_nut_neon")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
gold = (1.0, 0.68, 0.04, 1.0)
bsdf.inputs["Base Color"].default_value = gold
bsdf.inputs["Metallic"].default_value = 0.0
bsdf.inputs["Roughness"].default_value = 0.35
bsdf.inputs["Emission Color"].default_value = (1.0, 0.58, 0.02, 1.0)
bsdf.inputs["Emission Strength"].default_value = 1.0
nut.data.materials.clear()  # the boolean adds an empty slot
nut.data.materials.append(mat)

# pivot: bottom centre at origin
zs = [v.co.z for v in nut.data.vertices]
assert abs(min(zs)) < 1e-5, min(zs)

# export collection
col = bpy.data.collections.new("export_" + ID)
sc.collection.children.link(col)
sc.collection.objects.unlink(nut); col.objects.link(nut)

def bounds(objs):
    vs = [o.matrix_world @ v.co for o in objs if o.type == "MESH" for v in o.data.vertices]
    mn = Vector((min(v[i] for v in vs) for i in range(3))); mx = Vector((max(v[i] for v in vs) for i in range(3)))
    return mn, mx

report = []
mn, mx = bounds([nut])
report.append(f"blender bounds min {tuple(round(c, 4) for c in mn)} max {tuple(round(c, 4) for c in mx)}")
report.append(f"tris {sum(len(p.vertices) - 2 for p in nut.data.polygons)}")

os.makedirs(os.path.dirname(BLEND), exist_ok=True); os.makedirs(os.path.dirname(GLB), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=BLEND)
bpy.ops.object.select_all(action="DESELECT"); nut.select_set(True)
bpy.ops.export_scene.gltf(filepath=GLB, export_format="GLB", use_selection=True, export_yup=True,
                          export_apply=True, export_animations=False, export_extras=False)

# ---- reimport check (importer converts glTF Y-up back to Blender Z-up) ----
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
objs = list(bpy.data.objects)
mn, mx = bounds(objs)
# glTF (x, y, z) = Blender (x, z, -y)
gmn = (mn.x, mn.z, -mx.y); gmx = (mx.x, mx.z, -mn.y)
size = [gmx[i] - gmn[i] for i in range(3)]
report.append(f"reimport glTF bounds min {tuple(round(c, 4) for c in gmn)} max {tuple(round(c, 4) for c in gmx)}")
report.append(f"reimport size glTF W×H×D = {size[0]:.3f} × {size[1]:.3f} × {size[2]:.3f} m")
report.append(f"reimport objects: {[(o.name, o.type, tuple(round(s, 4) for s in o.scale)) for o in objs]}")
report.append(f"reimport materials: {sorted(m.name for m in bpy.data.materials)}")
report.append(f"glb bytes: {os.path.getsize(GLB)}")
os.makedirs(os.path.dirname(REPORT), exist_ok=True)
open(REPORT, "w").write("\n".join(report) + "\n")
print("\n".join(report))
