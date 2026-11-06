"""Shared Blender helper: normalise an unrigged Tripo GLB into a runtime GLB.

Used by normalize_char_junk_mech.py, normalize_prop_oil_barrel.py and
normalize_prop_scrap_car.py. Never edits the provider download.

  * rotate so the Tripo front (+X in Blender) faces Blender −Y (= glTF +Z)
  * scale: uniform to a target height, or per-axis fit into the contract box
  * pivot: ground-contact centre (bbox centre x/y of the lowest slice, min z → 0)
  * rename object/mesh/material per the contract, optional emissive face split
  * save .blend, export GLB (+Y up), reimport and write a measurement report
"""
import bpy, os, math
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _bounds(obj):
    ws = [obj.matrix_world @ v.co for v in obj.data.vertices]
    return (Vector([min(w[i] for w in ws) for i in range(3)]),
            Vector([max(w[i] for w in ws) for i in range(3)]))


def _base_image(mat):
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    link = bsdf.inputs["Base Color"].links
    if link and link[0].from_node.type == "TEX_IMAGE":
        return bsdf, link[0].from_node
    return bsdf, next(n for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and "Color" in n.image.name)


def run(asset_id, src_rel, kind, mat_name, *, target_h=None, fit_box=None,
        emissive=None, rot_z=-math.pi / 2):
    """kind: 'characters' | 'props'. fit_box: glTF (W, H, D) metres for per-axis fit.
    emissive: list of dict(name, color, strength, desc, pick(h,s,v,hz)->bool); matching
    faces move to that flat-emissive material (runtime has no emissiveTexture)."""
    src = os.path.join(ROOT, src_rel)
    blend = os.path.join(ROOT, f"assets/blender/{kind}/{asset_id}.blend")
    glb = os.path.join(ROOT, f"game/public/assets/{kind}/{asset_id}.glb")
    report_p = os.path.join(ROOT, f"out/blender/reimport-{asset_id}.txt")
    rep = [f"source {src_rel}"]

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    assert len(meshes) == 1, meshes
    ob = meshes[0]
    for o in list(bpy.data.objects):
        if o is not ob:
            bpy.data.objects.remove(o)
    ob.parent = None
    ob.name = asset_id; ob.data.name = f"{asset_id}_mesh"
    bpy.context.view_layer.objects.active = ob; ob.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    mn, mx = _bounds(ob)
    rep.append(f"source bounds (Blender) min {tuple(round(c,4) for c in mn)} max {tuple(round(c,4) for c in mx)}; faces {len(ob.data.polygons)}")

    ob.rotation_mode = "XYZ"; ob.rotation_euler = (0, 0, rot_z)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    mn, mx = _bounds(ob); size = mx - mn  # Blender x=W, y=D, z=H
    if target_h is not None:
        s = target_h / size.z; sc = (s, s, s)
    else:
        W, H, D = fit_box
        sc = (W / size.x, D / size.y, H / size.z)
    ob.scale = sc
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    rep.append(f"scale (Blender x,y,z) = {tuple(round(c,4) for c in sc)}" + (" (uniform)" if target_h else " (per-axis fit to contract box)"))

    mn, mx = _bounds(ob)
    z0 = mn.z; band = z0 + 0.04 * (mx.z - mn.z)
    low = [ob.matrix_world @ v.co for v in ob.data.vertices if (ob.matrix_world @ v.co).z <= band]
    cx = (min(p.x for p in low) + max(p.x for p in low)) / 2
    cy = (min(p.y for p in low) + max(p.y for p in low)) / 2
    for v in ob.data.vertices:
        v.co -= Vector((cx, cy, z0))
    ob.data.update()
    rep.append(f"pivot: ground-contact centre moved by ({-cx:.3f}, {-cy:.3f}, {-z0:.3f}) (lowest 4% slice, {len(low)} verts)")

    mat = ob.data.materials[0]; mat.name = mat_name
    if emissive:
        # The runtime loader (src/gltf/glb.ts) reads emissiveFactor + strength per
        # material but not emissiveTexture, so glowing texels become their own
        # material: faces whose UV-centroid texel passes a pick get a flat emissive.
        import colorsys
        bsdf, tex = _base_image(mat)
        img = tex.image; Wp, Hp = img.size; px = img.pixels[:]
        uvl = ob.data.uv_layers.active.data
        zs = [v.co.z for v in ob.data.vertices]; zmin, zmax = min(zs), max(zs)
        slots = []
        for spec in emissive:
            em = mat.copy(); em.name = spec["name"]
            eb, _ = _base_image(em)
            eb.inputs["Emission Color"].default_value = (*spec["color"], 1.0)
            eb.inputs["Emission Strength"].default_value = spec.get("strength", 1.0)
            ob.data.materials.append(em); slots.append([spec, len(ob.data.materials) - 1, 0])
        for poly in ob.data.polygons:
            u = sum(uvl[li].uv.x for li in poly.loop_indices) / poly.loop_total
            v = sum(uvl[li].uv.y for li in poly.loop_indices) / poly.loop_total
            x = min(Wp - 1, max(0, int((u % 1) * Wp))); y = min(Hp - 1, max(0, int((v % 1) * Hp)))
            i = (y * Wp + x) * 4
            h, sat, val = colorsys.rgb_to_hsv(px[i], px[i + 1], px[i + 2])
            hz = (poly.center.z - zmin) / (zmax - zmin)
            for sl in slots:
                if sl[0]["pick"](h, sat, val, hz):
                    poly.material_index = sl[1]; sl[2] += 1; break
        # optional disc fill: an eye is a flat disc whose texture varies across
        # faces, so every front-facing face inside spec['disc'] = (x, z, r)
        # (Blender metres, after scale/pivot) whose texel passes spec['disc_pick'] joins it.
        for sl in slots:
            spec, idx = sl[0], sl[1]
            if not spec.get("disc"):
                continue
            cx, cz, r = spec["disc"]  # explicit disc on the front (Blender x, z, radius in metres)
            seeds = 0
            for poly in ob.data.polygons:
                if poly.material_index != 0 or poly.normal.y > -0.5:
                    continue
                if any(((ob.data.vertices[vi].co.x - cx) ** 2 + (ob.data.vertices[vi].co.z - cz) ** 2) ** 0.5 > r
                       for vi in poly.vertices):
                    continue  # whole face must sit inside the disc
                u = sum(uvl[li].uv.x for li in poly.loop_indices) / poly.loop_total
                v = sum(uvl[li].uv.y for li in poly.loop_indices) / poly.loop_total
                x = min(Wp - 1, max(0, int((u % 1) * Wp))); y = min(Hp - 1, max(0, int((v % 1) * Hp)))
                i = (y * Wp + x) * 4
                h, sat, val = colorsys.rgb_to_hsv(px[i], px[i + 1], px[i + 2])
                if not spec.get("disc_pick", lambda h, s, v: v >= 0.3)(h, sat, val):
                    continue
                poly.material_index = idx; sl[2] += 1
            rep.append(f"disc fill {spec['name']}: centre ({cx:.3f}, {cz:.3f}) r {r:.3f}")
        for spec, _, n in slots:
            rep.append(f"emissive faces {spec['name']}: {n} / {len(ob.data.polygons)} "
                       f"(emissive {spec['color']} x{spec.get('strength', 1.0)}; {spec.get('desc','')})")

    os.makedirs(os.path.dirname(blend), exist_ok=True)
    os.makedirs(os.path.dirname(glb), exist_ok=True)
    col = bpy.data.collections.new(f"export_{asset_id}")
    bpy.context.scene.collection.children.link(col)
    for c in list(ob.users_collection):
        c.objects.unlink(ob)
    col.objects.link(ob)
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    bpy.ops.object.select_all(action="DESELECT"); ob.select_set(True)
    bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True,
                              export_yup=True, export_apply=True, export_animations=False,
                              export_image_format="AUTO", export_extras=False)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb)
    o2 = next(o for o in bpy.data.objects if o.type == "MESH")
    mn, mx = _bounds(o2)
    rep.append(f"reimport size glTF W×H×D = {mx.x-mn.x:.3f} × {mx.z-mn.z:.3f} × {mx.y-mn.y:.3f} m; "
               f"y_min {mn.z:.3f}; centre x {((mn.x+mx.x)/2):.3f} z {(-(mn.y+mx.y)/2):.3f}")
    rep.append(f"reimport objects: {[(o.name, o.type, tuple(round(s,4) for s in o.scale)) for o in bpy.data.objects]}")
    rep.append(f"reimport materials: {sorted(m.name for m in bpy.data.materials)}; tris {sum(len(p.vertices)-2 for p in o2.data.polygons)}")
    rep.append(f"glb bytes: {os.path.getsize(glb)}")
    os.makedirs(os.path.dirname(report_p), exist_ok=True)
    open(report_p, "w").write("\n".join(rep) + "\n")
    print("\n".join(rep))
