"""Rerunnable normalise for IAP skin characters (generic; same pipeline as char_raccoon_player).

Usage: CHAR_ID=char_fox_player SRC_GLB=<retarget model.glb> blender -b --python assets/scripts/normalize_char_skin.py


Input  (untouched Tripo download, never edited):
  assets/source/tripo/char_raccoon_player/tripo-out/retarget-e1c271f7/model.glb
  (Tripo rig v1.0-20240301 biped, task 32e89e12…; retarget e1c271f7…, presets
   biped:idle, biped:run, biped:jump, biped:jump_down, animate_in_place)
Outputs:
  assets/blender/characters/char_raccoon_player.blend
  game/public/assets/characters/char_raccoon_player.glb
  out/blender/reimport-char_raccoon_player.txt

Run from the game root:
  blender -b --python assets/scripts/normalize_char_raccoon_player.py

What it does:
  * face +Z in glTF (Tripo faces Blender +X → rotate −90° about Z so front is −Y)
  * uniform scale to 1.10 m tall, apply transforms (unit node scale)
  * feet-centre pivot: idle feet midpoint at x = z = 0, soles on y = 0
  * clips: idle (source idle, loop), run (source run, loop, hip recentred),
    jump (one hop sliced from source jump, retimed to 0.625 s ≈ sim airtime),
    land (impact slice of source jump_down, lifted to the ground, retimed 0.30 s)
  * materials: mat_raccoon_body + mat_goggles (blue lens faces split, cyan emissive)
"""
import bpy, os, sys, math
from mathutils import Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CID = os.environ["CHAR_ID"]
SRC = os.path.join(ROOT, os.environ["SRC_GLB"])
SPECIES = CID.split("_")[1]
BLEND = os.path.join(ROOT, f"assets/blender/characters/{CID}.blend")
GLB = os.path.join(ROOT, f"game/public/assets/characters/{CID}.glb")
REPORT = os.path.join(ROOT, f"out/blender/reimport-{CID}.txt")
TARGET_H = 1.10
FPS = 24

# (new name, source action, src start frame, src end frame, new length in frames, loop, extra lift in source metres)
CLIPS = [
    ("idle", "idle", None, None, None, True, 0.0),
    ("run", "run", None, None, None, True, 0.0),
    ("jump", "jump", 12, 24, 15, False, 0.0),
    ("land", "jump_down", 50, 70, round(0.30 * FPS), False, 0.225),
]

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.fps = FPS
bpy.ops.import_scene.gltf(filepath=SRC)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
mesh = next(o for o in bpy.data.objects if o.type == "MESH" and o.vertex_groups)
if arm.animation_data:
    for t in list(arm.animation_data.nla_tracks):
        arm.animation_data.nla_tracks.remove(t)  # importer adds one track per source clip
for o in list(bpy.data.objects):
    if o not in (arm, mesh):
        bpy.data.objects.remove(o)  # importer's bone-shape icosphere
for pb in arm.pose.bones:
    pb.custom_shape = None
arm.name = CID; arm.data.name = CID + "_rig"
mesh.name = CID + "_mesh"

# ---- measure, rotate, scale, apply -------------------------------------------
def mesh_bounds(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    ws = [ev.matrix_world @ v.co for v in ev.data.vertices]
    return Vector([min(w[i] for w in ws) for i in range(3)]), Vector([max(w[i] for w in ws) for i in range(3)])

arm.animation_data.action = None
for pb in arm.pose.bones:
    pb.matrix_basis = Matrix.Identity(4)
bpy.context.view_layer.update()
mn, mx = mesh_bounds(mesh)
src_h = mx.z - mn.z
S = TARGET_H / src_h
arm.rotation_mode = "XYZ"  # importer leaves QUATERNION, which ignores rotation_euler
arm.rotation_euler = (0, 0, -math.pi / 2)
arm.scale = (S, S, S)
bpy.ops.object.select_all(action="DESELECT")
arm.select_set(True); mesh.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
bpy.context.view_layer.update()

# ---- resample clips -----------------------------------------------------------
src_actions = {a.name: a for a in bpy.data.actions}
bones = [pb.name for pb in arm.pose.bones]

def sample(action, frame):
    arm.animation_data.action = action
    sc.frame_set(int(math.floor(frame)), subframe=frame - math.floor(frame))
    out = {}
    for pb in arm.pose.bones:
        m = pb.matrix_basis.copy()
        loc, rot, scl = m.decompose()
        out[pb.name] = (loc * S, rot, scl)  # bone-local translations scale with the mesh
    return out

def world_hip_feet():
    bpy.context.view_layer.update()
    h = arm.matrix_world @ arm.pose.bones["Hip"].head
    lf = arm.matrix_world @ arm.pose.bones["L_Foot"].head
    rf = arm.matrix_world @ arm.pose.bones["R_Foot"].head
    return h, (lf + rf) / 2

def apply_pose(p):
    for name, (loc, rot, scl) in p.items():
        pb = arm.pose.bones[name]
        pb.rotation_mode = "QUATERNION"
        pb.location, pb.rotation_quaternion, pb.scale = loc, rot, scl

plans = []
for name, src, f0, f1, n, loop, lift in CLIPS:
    a = src_actions[src]
    s, e = a.frame_range
    f0 = s if f0 is None else f0
    f1 = e if f1 is None else f1
    n = int(round(f1 - f0)) if n is None else n
    frames = [sample(a, f0 + (f1 - f0) * i / n) for i in range(n + 1)]
    if loop:  # close the seam: ease the last frames into frame 0 (Tripo run ends ~28° off on a forearm)
        k = min(6, n // 4)
        for j in range(n - k + 1, n + 1):
            w = ((j - (n - k)) / k) ** 2
            frames[j] = {b: (frames[j][b][0].lerp(frames[0][b][0], w), frames[j][b][1].slerp(frames[0][b][1], w),
                             frames[j][b][2].lerp(frames[0][b][2], w)) for b in frames[j]}
    hips, feet = [], []
    for p in frames:
        apply_pose(p); h, f = world_hip_feet(); hips.append(h); feet.append(f)
    plans.append((name, frames, hips, feet, loop, lift * S))

idle_hips, idle_feet = plans[0][2], plans[0][3]
idle_hip_xy = sum((h.xy for h in idle_hips), Vector((0, 0))) / len(idle_hips)
idle_feet_xy = sum((f.xy for f in idle_feet), Vector((0, 0))) / len(idle_feet)
target_hip_xy = idle_hip_xy - idle_feet_xy  # idle feet midpoint → origin

for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)

report = []
for name, frames, hips, feet, loop, lift in plans:
    mean_xy = sum((h.xy for h in hips), Vector((0, 0))) / len(hips)
    delta = Vector((target_hip_xy.x - mean_xy.x, target_hip_xy.y - mean_xy.y, lift))
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data.action = act
    for i, p in enumerate(frames):
        sc.frame_set(0)
        apply_pose(p)
        bpy.context.view_layer.update()
        hip = arm.pose.bones["Hip"]
        m = hip.matrix.copy(); m.translation += delta; hip.matrix = m
        bpy.context.view_layer.update()
        for pb in arm.pose.bones:
            pb.keyframe_insert("location", frame=i)
            pb.keyframe_insert("rotation_quaternion", frame=i)
            pb.keyframe_insert("scale", frame=i)
    # loop seam + drift
    seam = 0.0
    if loop:
        a0, a1 = frames[0], frames[-1]
        for b in bones:
            seam = max(seam, math.degrees(a0[b][1].rotation_difference(a1[b][1]).angle))
    drift = (hips[-1] - hips[0]).length
    report.append(f"clip {name}: frames {len(frames)-1} @ {FPS} fps = {(len(frames)-1)/FPS:.3f} s, loop={loop}, "
                  f"seam_max_joint_deg={seam:.2f}, hip_drift_m={drift:.3f}, recentre=({delta.x:.3f},{delta.y:.3f},{delta.z:.3f})")

# NLA tracks so the exporter writes each action as its own clip
arm.animation_data.action = None
for act in bpy.data.actions:
    tr = arm.animation_data.nla_tracks.new(); tr.name = act.name
    tr.strips.new(act.name, 0, act)
    tr.mute = True

# ---- materials: body + emissive goggles --------------------------------------
body = mesh.data.materials[0]
body.name = f"mat_{SPECIES}_body"
gog = body.copy(); gog.name = "mat_goggles"
bsdf = next(n for n in gog.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Emission Color"].default_value = (0.15, 0.75, 1.0, 1.0)
bsdf.inputs["Emission Strength"].default_value = 1.0
mesh.data.materials.append(gog)
img = None
for n in body.node_tree.nodes:
    if n.type == "TEX_IMAGE" and bsdf.inputs["Base Color"].links and n == body.node_tree.nodes[bsdf.inputs["Base Color"].links[0].from_node.name]:
        img = n.image
if img is None:
    img = next((n.image for n in body.node_tree.nodes if n.type == "TEX_IMAGE" and n.image and "base" in n.image.name.lower()), None) \
        or next(n.image for n in body.node_tree.nodes if n.type == "TEX_IMAGE" and n.image)
W, H = img.size
px = img.pixels[:]
uvl = mesh.data.uv_layers.active.data
gog_faces = 0
zs = [v.co.z for v in mesh.data.vertices]
zmin, zmax = min(zs), max(zs)
for poly in mesh.data.polygons:
    u = sum(uvl[li].uv.x for li in poly.loop_indices) / poly.loop_total
    v = sum(uvl[li].uv.y for li in poly.loop_indices) / poly.loop_total
    x = min(W - 1, max(0, int((u % 1) * W))); y = min(H - 1, max(0, int((v % 1) * H)))
    i = (y * W + x) * 4
    r, g, b = px[i], px[i + 1], px[i + 2]
    hz = (poly.center.z - zmin) / (zmax - zmin)
    if hz > 0.72 and b > 0.25 and b > r * 1.6 and b > g * 1.1:
        poly.material_index = 1; gog_faces += 1
if gog_faces == 0:
    mesh.data.materials.pop(index=1)
report.append(f"goggles faces: {gog_faces} / {len(mesh.data.polygons)} (texture {img.name} {W}x{H})")

# ---- final measure ------------------------------------------------------------
arm.animation_data.action = bpy.data.actions["idle"]; sc.frame_set(0)
bpy.context.view_layer.update()
mn, mx = mesh_bounds(mesh)
# Blender (x, y, z) → glTF (x, z, −y)
report.insert(0, f"source height {src_h:.4f} → scale {S:.4f}")
report.insert(1, f"idle f0 bounds (Blender): min {tuple(round(c,3) for c in mn)} max {tuple(round(c,3) for c in mx)}")
report.insert(2, f"idle f0 size glTF W×H×D = {mx.x-mn.x:.3f} × {mx.z-mn.z:.3f} × {mx.y-mn.y:.3f} m")
_, fm = world_hip_feet()
report.insert(3, f"idle f0 feet-mid (Blender) = ({fm.x:.3f}, {fm.y:.3f}); soles z_min = {mn.z:.3f}")
arm.animation_data.action = None
for pb in arm.pose.bones:
    pb.matrix_basis = Matrix.Identity(4)
bpy.context.view_layer.update()
rmn, rmx = mesh_bounds(mesh)
report.insert(4, f"rest-pose size glTF W×H×D = {rmx.x-rmn.x:.3f} × {rmx.z-rmn.z:.3f} × {rmx.y-rmn.y:.3f} m, z_min {rmn.z:.3f}")
# front check: nose/face verts should sit at −Y (glTF +Z)
lf = arm.data.bones["L_Foot"]; fd = (lf.tail_local - lf.head_local).normalized()
report.insert(5, f"rest L_Foot direction (Blender) = ({fd.x:.2f}, {fd.y:.2f}, {fd.z:.2f}) (−y = toes toward glTF +Z)")

os.makedirs(os.path.dirname(BLEND), exist_ok=True)
os.makedirs(os.path.dirname(GLB), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=BLEND)
bpy.ops.object.select_all(action="DESELECT")
arm.select_set(True); mesh.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=GLB, export_format="GLB", use_selection=True, export_yup=True,
    export_apply=True, export_animations=True, export_animation_mode="NLA_TRACKS",
    export_force_sampling=True, export_frame_step=1, export_def_bones=False,
    export_anim_single_armature=True, export_reset_pose_bones=True,
    export_image_format="AUTO", export_extras=False,
)

# ---- reimport check -----------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
acts = sorted((a.name, round((a.frame_range[1] - a.frame_range[0]) / FPS, 3)) for a in bpy.data.actions)
objs = [(o.name, o.type, tuple(round(s, 4) for s in o.scale)) for o in bpy.data.objects]
mats = sorted(m.name for m in bpy.data.materials)
report.append(f"reimport actions: {acts}")
report.append(f"reimport objects: {objs}")
report.append(f"reimport materials: {mats}")
report.append(f"glb bytes: {os.path.getsize(GLB)}")
os.makedirs(os.path.dirname(REPORT), exist_ok=True)
open(REPORT, "w").write("\n".join(report) + "\n")
print("\n".join(report))
