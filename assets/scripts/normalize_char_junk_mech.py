"""Rerunnable normalise for char_junk_mech (skinned).

Input  (untouched Tripo download, never edited):
  assets/source/tripo/char_junk_mech/tripo-out/retarget-2-48a343f6/model.glb
  (mesh 70693399…; Tripo rig v1.0-20240301 biped 85055f87…; retarget 48a343f6…,
   presets biped:idle, biped:walk, animate_in_place)
Outputs:
  assets/blender/characters/char_junk_mech.blend
  game/public/assets/characters/char_junk_mech.glb
  out/blender/reimport-char_junk_mech.txt
Run from the game root: blender -b --python assets/scripts/normalize_char_junk_mech.py

  * front +Z glTF, uniform scale to 5.0 m, idle feet midpoint at origin, soles y=0
  * clips: idle (source idle, loop), stomp_loop (source walk retimed to 38 f ≈ 1.58 s, loop),
    run (derived from stomp_loop, no new Tripo: 24 f ≈ 1.0 s, joint swings amplified, big
    counter-swinging arms, forearms bent, spine pitched forward; the game plays it on surges)
  * loop seams eased into frame 0 (last 6 frames), hips recentred
  * materials: mat_mech_paint + flat-emissive splits mat_mech_eye, mat_mech_eye_cyan, mat_mech_lamp
    (same picks/discs as the static script)
"""
import bpy, os, sys, math, colorsys
from mathutils import Matrix, Quaternion, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(ROOT, "assets/source/tripo/char_junk_mech/tripo-out/retarget-2-48a343f6/model.glb")
BLEND = os.path.join(ROOT, "assets/blender/characters/char_junk_mech.blend")
GLB = os.path.join(ROOT, "game/public/assets/characters/char_junk_mech.glb")
REPORT = os.path.join(ROOT, "out/blender/reimport-char_junk_mech.txt")
TARGET_H = 5.0
FPS = 24

# (new name, source action, src start frame, src end frame, new length in frames, loop, extra lift in source metres)
CLIPS = [
    ("idle", "idle", None, None, None, True, 0.0),
    ("stomp_loop", "walk", None, None, 38, True, 0.0),
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
arm.name = "char_junk_mech"; arm.data.name = "char_junk_mech_rig"
mesh.name = "char_junk_mech_mesh"

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

# ---- derived run clip (exaggerated sprint from the walk; free, no Tripo) ------------------------
RUN_N = 24
AMP = {"Thigh": 1.7, "Calf": 1.6, "Foot": 1.3, "Clavicle": 2.0, "Upperarm": 2.2, "Forearm": 1.8,
       "Hand": 1.5, "Spine01": 1.4, "Spine02": 1.4, "Waist": 1.4, "Pelvis": 1.3, "Hip": 1.0}
ARM_SWING = 1.25    # rad of extra fore/aft upper-arm swing at the cycle peaks
FOREARM_BEND = 1.0  # rad held elbow bend
SPINE_LEAN = 0.24   # rad forward pitch on each of Spine01 / Spine02
def amp_of(b):
    for k, v in AMP.items():
        if b.endswith(k): return v
    return 1.0
walk = plans[1][1][:-1]  # one loop, seam frame dropped
nW = len(walk)
lat = Vector((1, 0, 0))  # character's left-right axis (faces −Y after the rotate)
def local_axis(b):
    return (arm.data.bones[b].matrix_local.to_3x3().inverted() @ lat).normalized()
means = {}
for b in bones:
    q0 = walk[0][b][1]; acc = Quaternion((0, 0, 0, 0))
    for p in walk:
        q = p[b][1]; acc = Quaternion([a + (c if q0.dot(q) >= 0 else -c) for a, c in zip(acc, q)])
    means[b] = acc.normalized()
# Cycle phase from the left foot: +1 when it is furthest back (left arm then swings forward).
ly = []
for p in walk:
    apply_pose(p); bpy.context.view_layer.update()
    ly.append((arm.matrix_world @ arm.pose.bones["L_Foot"].head).y)
lo_, hi_ = min(ly), max(ly)
swing = [((y - lo_) / max(1e-6, hi_ - lo_)) * 2 - 1 for y in ly]
run_frames = []
for i in range(RUN_N + 1):
    u = (i % RUN_N) / RUN_N * nW
    j0 = int(u) % nW; j1 = (j0 + 1) % nW; w = u - int(u)
    f = {}
    sw = swing[j0] * (1 - w) + swing[j1] * w
    for b in bones:
        loc = walk[j0][b][0].lerp(walk[j1][b][0], w)
        q = walk[j0][b][1].slerp(walk[j1][b][1], w)
        m = means[b]; d = m.inverted() @ q
        if d.w < 0: d = -d
        ax, ang = d.to_axis_angle()
        q = m @ Quaternion(ax, ang * amp_of(b))
        if b in ("L_Upperarm", "R_Upperarm"):
            side = 1 if b[0] == "L" else -1
            q = q @ Quaternion(local_axis(b), -ARM_SWING * sw * side)
        elif b in ("L_Forearm", "R_Forearm"):
            q = q @ Quaternion(local_axis(b), -FOREARM_BEND)
        elif b in ("Spine01", "Spine02"):
            q = q @ Quaternion(local_axis(b), SPINE_LEAN)
        f[b] = (loc, q, walk[j0][b][2])
    run_frames.append(f)
hips, feet = [], []
for p in run_frames:
    apply_pose(p); h, ft = world_hip_feet(); hips.append(h); feet.append(ft)
plans.append(("run", run_frames, hips, feet, True, 0.0))

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

# ---- materials: paint + flat-emissive splits (runtime reads emissiveFactor only) ----
EMISSIVE = [
    dict(name="mat_mech_eye_cyan", color=(0.15, 0.85, 1.0), disc=(0.44, 3.92, 0.26),
         disc_pick=lambda h, s, v: v > 0.6 and (s < 0.25 or 0.42 < h < 0.66), pick=lambda h, s, v: False),
    dict(name="mat_mech_eye", color=(1.0, 0.8, 0.15), disc=(-0.44, 3.92, 0.26),
         disc_pick=lambda h, s, v: v > 0.6 and 0.09 < h < 0.2 and s > 0.2, pick=lambda h, s, v: False),
    dict(name="mat_mech_lamp", color=(1.0, 0.55, 0.1),
         pick=lambda h, s, v: (0.11 < h < 0.19 and s > 0.6 and v > 0.85) or (0.04 < h < 0.11 and s > 0.6 and v > 0.92)),
]
body = mesh.data.materials[0]
body.name = "mat_mech_paint"
bsdf0 = next(n for n in body.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
lk = bsdf0.inputs["Base Color"].links
img = lk[0].from_node.image if lk and lk[0].from_node.type == "TEX_IMAGE" else \
    next(n.image for n in body.node_tree.nodes if n.type == "TEX_IMAGE" and n.image)
W, H = img.size
px = img.pixels[:]
uvl = mesh.data.uv_layers.active.data
slots = []
for spec in EMISSIVE:
    em = body.copy(); em.name = spec["name"]
    eb = next(n for n in em.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    eb.inputs["Emission Color"].default_value = (*spec["color"], 1.0)
    eb.inputs["Emission Strength"].default_value = 1.0
    mesh.data.materials.append(em); slots.append([spec, len(mesh.data.materials) - 1, 0])
# rest-pose world coords, shifted so the ground-contact centre sits at origin (matches static disc coords)
mw = mesh.matrix_world
wv = [mw @ v.co for v in mesh.data.vertices]
z0 = min(p.z for p in wv); band = z0 + 0.04 * (max(p.z for p in wv) - z0)
low = [p for p in wv if p.z <= band]
off = Vector(((min(p.x for p in low) + max(p.x for p in low)) / 2, (min(p.y for p in low) + max(p.y for p in low)) / 2, z0))
wv = [p - off for p in wv]
nrm = mw.to_3x3()
def texel(poly):
    u = sum(uvl[li].uv.x for li in poly.loop_indices) / poly.loop_total
    v = sum(uvl[li].uv.y for li in poly.loop_indices) / poly.loop_total
    x = min(W - 1, max(0, int((u % 1) * W))); y = min(H - 1, max(0, int((v % 1) * H)))
    i = (y * W + x) * 4
    return colorsys.rgb_to_hsv(px[i], px[i + 1], px[i + 2])
for poly in mesh.data.polygons:
    h, s_, v_ = texel(poly)
    for sl in slots:
        if sl[0]["pick"](h, s_, v_):
            poly.material_index = sl[1]; sl[2] += 1; break
for sl in slots:
    spec, idx = sl[0], sl[1]
    if not spec.get("disc"):
        continue
    cx, cz, r = spec["disc"]
    for poly in mesh.data.polygons:
        if poly.material_index != 0 or (nrm @ poly.normal).normalized().y > -0.5:
            continue
        if any(((wv[vi].x - cx) ** 2 + (wv[vi].z - cz) ** 2) ** 0.5 > r for vi in poly.vertices):
            continue
        if spec["disc_pick"](*texel(poly)):
            poly.material_index = idx; sl[2] += 1
for spec, _, n in slots:
    report.append(f"emissive faces {spec['name']}: {n} / {len(mesh.data.polygons)}")

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

# Background chaser: 1024² textures (2048² tipped headless WebGPU/SwiftShader over its texture budget
# as the 6th GLB; the mech is distant so 1024 reads the same).
for im in bpy.data.images:
    if im.size[0] > 1024:
        im.scale(1024, 1024)
        im.pack()
report.append("textures downscaled to 1024²: " + ", ".join(im.name for im in bpy.data.images if im.size[0] == 1024))
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
