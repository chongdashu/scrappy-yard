"""Rerunnable build for env_scrapyard_lane (Blender-only, no generation).

Outputs:
  assets/blender/environment/env_scrapyard_lane.blend
  game/public/assets/env/env_scrapyard_lane.glb
  out/blender/reimport-env_scrapyard_lane.txt

Run from the game root:
  blender -b --python assets/scripts/normalize_env_scrapyard_lane.py

Layout (glTF / runtime metres; +Y up, tile runs from z = 0 to z = +8):
  * deck   x ±2.2, y −0.3..0 (top surface y = 0), three 1.4 m lanes centred at
           x = −1.4, 0, +1.4; plated-steel texture (seams every 2 m along Z, lane seams
           at x = ±0.7, rivets) → mat_track
  * lane dividers: raised steel strips 0.08 wide × 0.02 high at x = ±0.7 → mat_track
  * rails  x ±2.2..±2.5, y −0.3..+0.1, yellow/black diagonal hazard stripes → mat_rail_hazard
  * rail lamps: 0.1 m amber neon blocks on each rail at z = 2 and 6 (top y = +0.2) → mat_neon_sign
  * thin neon glow strip along the inner rail foot → mat_neon_sign
  Overall 5.0 × 0.5 × 8.0 m; pivot = tile start edge centre (x = 0, z = 0) with the deck top
  on y = 0. Textures are generated procedurally here (numpy) and packed into the GLB.
  Side junk walls are separate assets (not in this tile).
"""
import bpy, bmesh, os, math
import numpy as np
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ID = "env_scrapyard_lane"
BLEND = os.path.join(ROOT, "assets/blender/environment", ID + ".blend")
GLB = os.path.join(ROOT, "game/public/assets/env", ID + ".glb")
REPORT = os.path.join(ROOT, "out/blender/reimport-" + ID + ".txt")
L = 8.0; DECK_HALF = 2.2; HALF_W = 2.5; DECK_BOT = -0.3; RAIL_TOP = 0.1; LANE = 1.4

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.unit_settings.system = "METRIC"; sc.unit_settings.scale_length = 1.0
rng = np.random.default_rng(7)

# ---------------- textures (pixel values are sRGB, rows bottom→top) ----------------
def make_image(name, arr):
    h, w, _ = arr.shape
    img = bpy.data.images.new(name, w, h, alpha=False)
    rgba = np.concatenate([arr, np.ones((h, w, 1), np.float32)], axis=2)
    img.pixels.foreach_set(rgba.astype(np.float32).ravel())
    img.pack()
    return img

def track_texture(w=512, h=1024):
    # u: x −2.2..+2.2, v: z 0..8 (v = 0 at the tile start)
    xs = (np.arange(w) + 0.5) / w * (2 * DECK_HALF) - DECK_HALF
    zs = (np.arange(h) + 0.5) / h * L
    X, Z = np.meshgrid(xs, zs)
    base = np.array([0.66, 0.58, 0.53], np.float32)  # warm beige steel (D under dusk)
    img = np.broadcast_to(base, (h, w, 3)).copy()
    # plate-to-plate colour variation: plates 1.4 m across (lane), 2 m along Z
    lane_i = np.clip(np.floor((X + 2.1) / LANE), 0, 2).astype(int)
    plate_j = np.floor(Z / 2.0).astype(int) % 4
    var = rng.uniform(-0.035, 0.035, (3, 4))
    img += var[lane_i, plate_j][..., None]
    # low-frequency wear + fine grain
    grain = rng.normal(0, 0.006, (h, w)).astype(np.float32)
    wear = (np.sin(X * 3.1 + Z * 0.9) * np.sin(Z * 1.7 - X * 0.6)).astype(np.float32) * 0.025
    img += (grain + wear)[..., None]
    dark = np.array([0.22, 0.19, 0.18], np.float32)
    def line(mask, col=dark, k=1.0):
        img[mask] = img[mask] * (1 - k) + col * k
    # seams: across every 2 m (incl. both tile edges), lengthwise at lane edges and deck edge
    line((np.abs(((Z + 1.0) % 2.0) - 1.0) < 0.018))
    for sx in (-2.1, -0.7, 0.7, 2.1):
        line(np.abs(X - sx) < 0.016)
    # bevel highlight beside seams
    hl = np.array([0.80, 0.72, 0.66], np.float32)
    line(((Z % 2.0) > 0.018) & ((Z % 2.0) < 0.03), hl, 0.6)
    # rivets along the across seams and lane seams
    for zr in np.arange(0.0, L + 0.01, 2.0):
        for xr in np.arange(-2.0, 2.01, 0.35):
            for dz in (-0.07, 0.07):
                d = np.hypot(X - xr, Z - (zr + dz))
                line(d < 0.032, dark, 0.8); line(d < 0.02, hl, 0.9)
    for sx in (-0.7, 0.7):
        for zr in np.arange(0.25, L, 0.5):
            for dx in (-0.07, 0.07):
                d = np.hypot(X - (sx + dx), Z - zr)
                line(d < 0.028, dark, 0.8); line(d < 0.017, hl, 0.9)
    # edge shade near the rails
    shade = np.clip((np.abs(X) - 1.9) / 0.3, 0, 1)[..., None] * 0.18
    img = img * (1 - shade)
    return np.clip(img, 0, 1)

def hazard_texture(n=256, period=64):
    # 45° stripes, tileable (period divides n). u/v cover 0.6 m.
    i, j = np.meshgrid(np.arange(n), np.arange(n))
    s = ((i + j) % period) < period // 2
    yellow = np.array([0.98, 0.78, 0.12], np.float32); black = np.array([0.09, 0.08, 0.08], np.float32)
    img = np.where(s[..., None], yellow, black).astype(np.float32)
    img += rng.normal(0, 0.015, (n, n, 1)).astype(np.float32)  # a little paint grain
    return np.clip(img, 0, 1)

def material(name, img=None, color=(1, 1, 1, 1), rough=0.7, metal=0.0, emit=None, emit_strength=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; b = nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = color
    b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    if img is not None:
        t = nt.nodes.new("ShaderNodeTexImage"); t.image = img; t.extension = "REPEAT"; t.interpolation = "Linear"
        nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
    if emit:
        b.inputs["Emission Color"].default_value = emit
        b.inputs["Emission Strength"].default_value = emit_strength
    return m

mats = [
    material("mat_track", make_image("tex_track", track_texture()), rough=0.75, metal=0.0),
    material("mat_rail_hazard", make_image("tex_rail_hazard", hazard_texture()), rough=0.55),
    material("mat_neon_sign", color=(1.0, 0.55, 0.15, 1), rough=0.3, emit=(1.0, 0.5, 0.12, 1), emit_strength=3.0),
]
TRACK, HAZ, NEON = 0, 1, 2

# ---------------- geometry (author in glTF coords, store as Blender x, -z, y) ----------------
bm = bmesh.new()
uv_layer = bm.loops.layers.uv.new("UVMap")
def B(x, y, z):
    return (x, -z, y)

def uv_for(mat, normal_axis, x, y, z):
    if mat == TRACK:
        if normal_axis == 1:  # top / bottom
            return ((x + DECK_HALF) / (2 * DECK_HALF), z / L)
        if normal_axis == 0:  # sides: dark strip near a seam column
            return ((-0.7 + DECK_HALF) / (2 * DECK_HALF) + y * 0.01, z / L)
        return ((x + DECK_HALF) / (2 * DECK_HALF), 1.0 / 1024 * 0.5 + y * 0.01)
    if mat == HAZ:
        if normal_axis == 0:
            return (z / 0.6, y / 0.6)
        if normal_axis == 1:
            return (x / 0.6, z / 0.6)
        return (x / 0.6, y / 0.6)
    return (0.5, 0.5)

def box(x0, x1, y0, y1, z0, z1, mat, skip=()):
    c = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    vs = [bm.verts.new(B(*p)) for p in c]
    faces = {  # outward winding in glTF space, tagged with normal axis
        "-z": ([0, 3, 2, 1], 2), "+z": ([4, 5, 6, 7], 2), "-y": ([0, 1, 5, 4], 1),
        "+y": ([3, 7, 6, 2], 1), "-x": ([0, 4, 7, 3], 0), "+x": ([1, 2, 6, 5], 0),
    }
    for key, (idx, ax) in faces.items():
        if key in skip:
            continue
        f = bm.faces.new([vs[i] for i in idx]); f.material_index = mat
        for loop, i in zip(f.loops, idx):
            loop[uv_layer].uv = uv_for(mat, ax, *c[i])

# deck (ends kept so gaps show a clean edge)
box(-DECK_HALF, DECK_HALF, DECK_BOT, 0.0, 0.0, L, TRACK)
# lane dividers
for sx in (-0.5 * LANE, 0.5 * LANE):
    box(sx - 0.04, sx + 0.04, 0.0, 0.02, 0.0, L, TRACK, skip=("-y",))
# rails, lamps, neon foot strips
for s in (-1, 1):
    xi, xo = s * DECK_HALF, s * HALF_W
    box(min(xi, xo), max(xi, xo), DECK_BOT, RAIL_TOP, 0.0, L, HAZ)
    xc = s * (DECK_HALF + HALF_W) / 2
    for zl in (2.0, 6.0):
        box(xc - 0.05, xc + 0.05, RAIL_TOP, RAIL_TOP + 0.1, zl - 0.05, zl + 0.05, NEON, skip=("-y",))
    xf = s * (DECK_HALF - 0.02)
    box(min(xf, xi), max(xf, xi), 0.0, 0.03, 0.0, L, NEON, skip=("-y",))

bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
me = bpy.data.meshes.new(ID); bm.to_mesh(me); bm.free()
for m in mats:
    me.materials.append(m)
obj = bpy.data.objects.new(ID, me)
col = bpy.data.collections.new("export_" + ID); sc.collection.children.link(col); col.objects.link(obj)
bpy.context.view_layer.objects.active = obj
bev = obj.modifiers.new("bevel", "BEVEL"); bev.width = 0.012; bev.segments = 1; bev.limit_method = "ANGLE"; bev.angle_limit = math.radians(40)
bpy.ops.object.modifier_apply(modifier=bev.name)
for p in me.polygons:
    p.use_smooth = False

def bounds(objs):
    vs = [o.matrix_world @ v.co for o in objs if o.type == "MESH" for v in o.data.vertices]
    return (Vector((min(v[i] for v in vs) for i in range(3))), Vector((max(v[i] for v in vs) for i in range(3))))

report = []
mn, mx = bounds([obj])
report.append(f"blender bounds min {tuple(round(c, 4) for c in mn)} max {tuple(round(c, 4) for c in mx)}")
report.append(f"tris {sum(len(p.vertices) - 2 for p in me.polygons)}")
report.append(f"textures: tex_track {tuple(bpy.data.images['tex_track'].size)} (~{512 / 4.4:.0f} px/m across, {1024 / L:.0f} px/m along); tex_rail_hazard 256² over 0.6 m (~427 px/m)")

os.makedirs(os.path.dirname(BLEND), exist_ok=True); os.makedirs(os.path.dirname(GLB), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=BLEND)
bpy.ops.object.select_all(action="DESELECT"); obj.select_set(True)
bpy.ops.export_scene.gltf(filepath=GLB, export_format="GLB", use_selection=True, export_yup=True,
                          export_apply=True, export_animations=False, export_extras=False,
                          export_image_format="AUTO")

# ---- reimport check ----
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)
objs = list(bpy.data.objects)
mn, mx = bounds(objs)
gmn = (mn.x, mn.z, -mx.y); gmx = (mx.x, mx.z, -mn.y)
size = [gmx[i] - gmn[i] for i in range(3)]
o = objs[0]
hits = []
for lx in (-1.4, 0.0, 1.4):  # ray down onto each lane centre at mid-tile (Blender y = −4)
    ok, loc, *_ = o.ray_cast(o.matrix_world.inverted() @ Vector((lx, -4.0, 5.0)), Vector((0, 0, -1)))
    hits.append(round((o.matrix_world @ loc).z, 4) if ok else None)
top = hits
report.append(f"reimport glTF bounds min {tuple(round(c, 4) for c in gmn)} max {tuple(round(c, 4) for c in gmx)}")
report.append(f"reimport size glTF W×H×D = {size[0]:.3f} × {size[1]:.3f} × {size[2]:.3f} m; deck top at lane centres x=−1.4/0/+1.4 → y = {top}")
report.append(f"reimport objects: {[(o.name, o.type, tuple(round(s, 4) for s in o.scale)) for o in objs]}")
report.append(f"reimport materials: {sorted(m.name for m in bpy.data.materials)}")
report.append(f"reimport images: {sorted((i.name, tuple(i.size)) for i in bpy.data.images)}")
report.append(f"glb bytes: {os.path.getsize(GLB)}")
os.makedirs(os.path.dirname(REPORT), exist_ok=True)
open(REPORT, "w").write("\n".join(report) + "\n")
print("\n".join(report))
