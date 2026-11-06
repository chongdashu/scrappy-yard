"""Review render for a built GLB: dusk-lit Cycles CPU still, origin axes optional.

  blender -b --python assets/scripts/review_render.py -- <glb> <out.png> <cam_x,cam_y,cam_z> <target_x,target_y,target_z> [lens]

Camera coordinates are Blender space (Z up, glTF +Z = Blender −Y). Output goes under share/media/.
"""
import bpy, sys, os, math
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
glb, out = args[0], args[1]
cam = Vector(float(c) for c in args[2].split(","))
tgt = Vector(float(c) for c in args[3].split(","))
lens = float(args[4]) if len(args) > 4 else 50

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=glb)
# ground
zmin = min((o.matrix_world @ v.co).z for o in bpy.data.objects if o.type == "MESH" for v in o.data.vertices)
bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, zmin - 0.001))
g = bpy.context.active_object
gm = bpy.data.materials.new("ground"); gm.use_nodes = True
gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.18, 0.09, 0.06, 1)
g.data.materials.append(gm)
# dusk world
w = bpy.data.worlds.new("dusk"); sc.world = w; w.use_nodes = True
bg = w.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.55, 0.32, 0.45, 1); bg.inputs["Strength"].default_value = 0.6
# warm low sun + cool fill
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); sc.collection.objects.link(sun)
sun.data.energy = 3.0; sun.data.color = (1.0, 0.7, 0.45); sun.rotation_euler = (math.radians(55), 0, math.radians(-35))
fill = bpy.data.objects.new("fill", bpy.data.lights.new("fill", "SUN")); sc.collection.objects.link(fill)
fill.data.energy = 0.8; fill.data.color = (0.55, 0.6, 1.0); fill.rotation_euler = (math.radians(60), 0, math.radians(150))
# camera
c = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(c)
c.location = cam; c.data.lens = lens
c.rotation_euler = (tgt - cam).to_track_quat("-Z", "Y").to_euler()
sc.camera = c
sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = 48; sc.cycles.use_denoising = True
sc.render.resolution_x, sc.render.resolution_y = 1024, 768
sc.view_settings.view_transform = "Standard"  # closer to the runtime look than AgX
sc.render.image_settings.file_format = "PNG"
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
sc.render.filepath = os.path.abspath(out)
bpy.ops.render.render(write_still=True)
print("wrote", out)
