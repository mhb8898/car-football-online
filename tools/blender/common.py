"""
Shared helpers for the asset scripts in tools/blender/ (cars, ball, pads, arena).

Everything is built with bmesh and the data API rather than bpy.ops, so a
script behaves the same from the Text Editor, over the MCP bridge, or in
`blender --background --python`.

Game conventions every script follows:
  - 1 Blender unit = 1 metre = 1 game unit
  - forward / field length is +X and up is +Z in Blender; the glTF exporter
    (export_yup=True) maps Blender (x, y, z) to three.js (x, z, -y)
  - materials only carry flat Principled values (base colour, roughness,
    metallic, emission); the one exception is the arena field, which uses
    an image texture. Names matter: "_glow" in a material name = drawn
    unlit/emissive, "paint" = replaced by the team colour, "glass" =
    transparent, "net" = semi-transparent
  - static parts are merged into one multi-material mesh per object
    (MeshBuilder below, or join_children) to keep draw calls low
"""

import contextlib
import io
import math
import os

import bmesh
import bpy
from mathutils import Vector

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ASSETS = os.path.join(REPO, "assets")

COLL = None   # collection new objects are linked into; set by use_collection()


# --------------------------------------------------------------------------
# Collections
# --------------------------------------------------------------------------
def use_collection(name):
    """Empty (or create) a top-level collection and make it the build target."""
    global COLL
    coll = bpy.data.collections.get(name)
    if coll:
        for ob in list(coll.all_objects):
            data = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            if isinstance(data, bpy.types.Mesh) and data.users == 0:
                bpy.data.meshes.remove(data)
    else:
        coll = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(coll)
    COLL = coll
    return coll


def root(name, loc=(0, 0, 0), **props):
    """An empty that one exported model hangs off."""
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = "PLAIN_AXES"
    ob.empty_display_size = 0.4
    for k, v in props.items():
        ob[k] = v
    COLL.objects.link(ob)
    ob.location = loc
    return ob


def marker(name, parent, loc):
    """An empty the game reads back by name, e.g. a muzzle point."""
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = "SPHERE"
    ob.empty_display_size = 0.06
    COLL.objects.link(ob)
    ob.parent = parent
    ob.location = loc
    return ob


# --------------------------------------------------------------------------
# Materials
# --------------------------------------------------------------------------
def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(srgb_to_linear(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4))


def shade(color, k):
    h = color.lstrip("#")
    return "#" + "".join(f"{max(0, min(255, int(int(h[i:i + 2], 16) * k))):02x}" for i in (0, 2, 4))


def mat(name, color, rough=0.6, metal=0.0, emit=0.0, alpha=1.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    rgb = hex_rgb(color)
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    bsdf.inputs["Emission Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Emission Strength"].default_value = emit
    bsdf.inputs["Alpha"].default_value = alpha
    if hasattr(m, "surface_render_method"):
        m.surface_render_method = "BLENDED" if alpha < 1.0 else "DITHERED"
    m.diffuse_color = (*rgb, alpha)
    return m


# --------------------------------------------------------------------------
# Primitives
# --------------------------------------------------------------------------
def mesh_object(name, bm, material, parent, loc=(0, 0, 0), rot=(0, 0, 0), scale=1.0, smooth=True):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = smooth
    me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    COLL.objects.link(ob)
    ob.parent = parent
    ob.location = loc
    ob.rotation_euler = [math.radians(a) for a in rot]
    ob.scale = scale if hasattr(scale, "__len__") else (scale, scale, scale)
    return ob


def sphere(name, material, parent, loc, scale=1.0, rot=(0, 0, 0), segs=(20, 12), cut_below=None, smooth=True):
    """UV sphere; cut_below drops the vertices under that local z (a dome)."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs[0], v_segments=segs[1], radius=1.0)
    if cut_below is not None:
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < cut_below - 1e-4], context="VERTS")
    return mesh_object(name, bm, material, parent, loc, rot, scale, smooth)


def ico(name, material, parent, loc, scale=1.0, rot=(0, 0, 0), subdiv=1, smooth=False):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
    return mesh_object(name, bm, material, parent, loc, rot, scale, smooth)


def cone(name, material, parent, loc, r1, r2, depth, rot=(0, 0, 0), scale=1.0, segs=16, smooth=True, caps=True):
    """Cylinder/cone along local Z, centred on loc."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=segs,
                          radius1=r1, radius2=r2, depth=depth)
    return mesh_object(name, bm, material, parent, loc, rot, scale, smooth)


def rod(name, material, parent, a, b, r1, r2=None, segs=12, smooth=True):
    """Cylinder from point a to point b."""
    a, b = Vector(a), Vector(b)
    d = b - a
    q = Vector((0, 0, 1)).rotation_difference(d.normalized())
    rot = [math.degrees(x) for x in q.to_euler()]
    return cone(name, material, parent, (a + b) / 2, r1, r1 if r2 is None else r2, d.length,
                rot=rot, segs=segs, smooth=smooth)


def box(name, material, parent, loc, scale, rot=(0, 0, 0), bevel=0.25):
    """Box with half-extents `scale`; bevel is relative to the unit cube."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)
    if bevel:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=2,
                        profile=0.5, affect="EDGES", clamp_overlap=True)
    return mesh_object(name, bm, material, parent, loc, rot, scale, bevel > 0)


def torus(name, material, parent, loc, major, minor, rot=(0, 0, 0), scale=1.0, segs=(28, 8), arc=360.0):
    bm = bmesh.new()
    n_maj, n_min = segs
    full = arc >= 360.0
    rings = n_maj if full else n_maj + 1
    grid = []
    for i in range(rings):
        a = math.radians(arc) * i / n_maj
        centre = Vector((math.cos(a) * major, math.sin(a) * major, 0.0))
        out = Vector((math.cos(a), math.sin(a), 0.0))
        grid.append([bm.verts.new(centre + out * math.cos(b) * minor + Vector((0, 0, math.sin(b) * minor)))
                     for b in (2 * math.pi * j / n_min for j in range(n_min))])
    for i in range(n_maj if full else rings - 1):
        r0, r1 = grid[i], grid[(i + 1) % rings]
        for j in range(n_min):
            bm.faces.new((r0[j], r1[j], r1[(j + 1) % n_min], r0[(j + 1) % n_min]))
    if not full:
        bm.faces.new(grid[0][::-1])
        bm.faces.new(grid[-1])
    return mesh_object(name, bm, material, parent, loc, rot, scale, True)


def prism(name, material, parent, loc, outline, depth, rot=(0, 0, 0), scale=1.0, smooth=False):
    """Extrude a 2D outline [(x, y), ...] (counter-clockwise) along Z by depth."""
    bm = bmesh.new()
    lo = [bm.verts.new((x, y, -depth / 2)) for x, y in outline]
    hi = [bm.verts.new((x, y, depth / 2)) for x, y in outline]
    bm.faces.new(lo[::-1])
    bm.faces.new(hi)
    n = len(outline)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_object(name, bm, material, parent, loc, rot, scale, smooth)


def star_outline(points, r_out, r_in, phase=0.0):
    out = []
    for i in range(points * 2):
        a = phase + math.pi * i / points
        r = r_out if i % 2 == 0 else r_in
        out.append((math.cos(a) * r, math.sin(a) * r))
    return out


def face_rot(x, y, z):
    """Euler (degrees) turning local +Z to point along (x, y, z)."""
    q = Vector((0, 0, 1)).rotation_difference(Vector((x, y, z)).normalized())
    return [math.degrees(a) for a in q.to_euler()]


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------
def export_glb(filename, roots, coll=None, at_origin=True):
    """Export everything under `roots` to assets/<filename>.

    Only the active scene is written (use_active_scene), so the "_preview"
    scene that links the same collections does not duplicate the nodes.

    Roots are moved to the origin for the export (they are laid out side by
    side in the scene only so they can be looked at) and put back afterwards.
    """
    coll = coll or COLL
    path = os.path.join(ASSETS, filename)
    os.makedirs(ASSETS, exist_ok=True)
    saved = [r.location.copy() for r in roots]
    if at_origin:
        for r in roots:
            r.location = (0, 0, 0)
    for ob in bpy.context.view_layer.objects:
        ob.select_set(False)
    for ob in coll.all_objects:
        ob.select_set(True)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                                      export_apply=True, export_yup=True, use_active_scene=True)
    finally:
        for r, loc in zip(roots, saved):
            r.location = loc
    return path, os.path.getsize(path)


def join_children(parent, name, keep=lambda ob: False):
    """Merge every mesh under `parent` into one mesh object `name`, one material slot per material.

    Objects for which keep(ob) is true are merged into a second object
    "<name>_glow" instead (used to keep emissive parts separable by name).
    Transforms are baked relative to `parent`, and the originals are removed.
    """
    # Parts made through the data API have stale world matrices until the view
    # layer is evaluated. Without this every part was baked at its parent's
    # origin and the whole arena collapsed into one lump the size of a brazier.
    bpy.context.view_layer.update()
    groups = {False: [], True: []}
    for ob in parent.children_recursive:
        if ob.type == "MESH":
            groups[bool(keep(ob))].append(ob)
    inv = parent.matrix_world.inverted()
    made = []
    for glowing, obs in groups.items():
        if not obs:
            continue
        bm = bmesh.new()
        mats = []
        for ob in obs:
            n0 = len(bm.faces)
            v0 = len(bm.verts)
            bm.from_mesh(ob.data)
            bm.verts.ensure_lookup_table()
            bm.faces.ensure_lookup_table()
            bmesh.ops.transform(bm, matrix=inv @ ob.matrix_world, verts=bm.verts[v0:])
            src = list(ob.data.materials)
            for f in bm.faces[n0:]:
                m = src[f.material_index] if f.material_index < len(src) else src[0]
                if m not in mats:
                    mats.append(m)
                f.material_index = mats.index(m)
        me = bpy.data.meshes.new(name + ("_glow" if glowing else ""))
        bm.to_mesh(me)
        bm.free()
        for m in mats:
            me.materials.append(m)
        out = bpy.data.objects.new(me.name, me)
        COLL.objects.link(out)
        out.parent = parent
        made.append(out)
        for ob in obs:
            data = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            if data.users == 0:
                bpy.data.meshes.remove(data)
    return made


# --------------------------------------------------------------------------
# MeshBuilder: many primitives straight into one multi-material mesh
# --------------------------------------------------------------------------
BOX_FACES = ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7))


def box_corners(lo, hi):
    """The 8 corners of an axis-aligned box, in the order BOX_FACES expects."""
    (x0, y0, z0), (x1, y1, z1) = lo, hi
    return [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
            (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]


class MeshBuilder:
    """Accumulates geometry in one bmesh with one material slot per material.

    Faces keep the winding they are given (outward = counter-clockwise seen
    from outside) unless recalc=True, which recomputes normals for that
    closed piece on its own before it is merged in.
    """

    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []
        self.uv = None

    def slot(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def add(self, verts, faces, m, smooth=False, recalc=False, matrix=None):
        """verts: points; faces: index tuples; m: a material or one per face."""
        if matrix is not None:
            verts = [matrix @ Vector(v) for v in verts]
        per_face = isinstance(m, (list, tuple))
        if recalc:
            tmp = bmesh.new()
            vs = [tmp.verts.new(v) for v in verts]
            for i, f in enumerate(faces):
                tf = tmp.faces.new([vs[j] for j in f])
                tf.material_index = self.slot(m[i] if per_face else m)
            bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces)
            self.add_bm(tmp, None, smooth=smooth)
            tmp.free()
            return
        bm = self.bm
        vs = [bm.verts.new(v) for v in verts]
        for i, f in enumerate(faces):
            face = bm.faces.new([vs[j] for j in f])
            face.material_index = self.slot(m[i] if per_face else m)
            face.smooth = smooth

    def add_bm(self, src, m, matrix=None, smooth=False):
        """Copy a bmesh in. m=None keeps src material indices as slot numbers
        (only meaningful when src was filled through this builder's slots)."""
        vmap = {}
        for v in src.verts:
            co = matrix @ v.co if matrix is not None else v.co.copy()
            vmap[v] = self.bm.verts.new(co)
        for f in src.faces:
            face = self.bm.faces.new([vmap[v] for v in f.verts])
            face.material_index = f.material_index if m is None else self.slot(m)
            face.smooth = smooth

    def box(self, lo, hi, m, smooth=False):
        self.add(box_corners(lo, hi), BOX_FACES, m, smooth)

    def obox(self, centre, half, m, matrix=None, bevel=0.0, segments=1, smooth=False):
        """Box with half-extents `half` around the origin, optionally bevelled
        (absolute offset), then moved by `matrix` (or translated to centre)."""
        from mathutils import Matrix
        tmp = bmesh.new()
        bmesh.ops.create_cube(tmp, size=2.0)
        for v in tmp.verts:
            v.co = Vector((v.co.x * half[0], v.co.y * half[1], v.co.z * half[2]))
        if bevel:
            bmesh.ops.bevel(tmp, geom=list(tmp.edges), offset=bevel, segments=segments,
                            profile=0.5, affect="EDGES", clamp_overlap=True)
        mt = Matrix.Translation(Vector(centre))
        if matrix is not None:
            mt = mt @ matrix
        self.add_bm(tmp, m, mt, smooth)
        tmp.free()

    def cyl(self, a, b, r, m, segs=12, smooth=True, caps=True, r2=None):
        """Cylinder / cone from point a to point b."""
        from mathutils import Matrix
        a, b = Vector(a), Vector(b)
        d = b - a
        q = Vector((0, 0, 1)).rotation_difference(d.normalized())
        tmp = bmesh.new()
        bmesh.ops.create_cone(tmp, cap_ends=caps, cap_tris=False, segments=segs,
                              radius1=r, radius2=r if r2 is None else r2, depth=d.length)
        mt = Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4()
        self.add_bm(tmp, m, mt, smooth)
        tmp.free()

    def uvsphere(self, centre, r, m, segs=(16, 10), smooth=True, scale=(1, 1, 1)):
        from mathutils import Matrix
        tmp = bmesh.new()
        bmesh.ops.create_uvsphere(tmp, u_segments=segs[0], v_segments=segs[1], radius=1.0)
        mt = Matrix.Translation(Vector(centre)) @ Matrix.Diagonal((r * scale[0], r * scale[1], r * scale[2], 1))
        self.add_bm(tmp, m, mt, smooth)
        tmp.free()

    def prism(self, outline, z0, z1, m, smooth=False, top=True, bottom=True):
        """Extrude a counter-clockwise 2D outline from z0 to z1."""
        n = len(outline)
        verts = [(x, y, z0) for x, y in outline] + [(x, y, z1) for x, y in outline]
        faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
        if bottom:
            faces.append(tuple(range(n - 1, -1, -1)))
        if top:
            faces.append(tuple(range(n, 2 * n)))
        self.add(verts, faces, m, smooth)

    def finish(self, name, parent=None, sharp_angle=None, loc=(0, 0, 0)):
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        if sharp_angle is not None:
            me.set_sharp_from_angle(angle=math.radians(sharp_angle))
        ob = bpy.data.objects.new(name, me)
        COLL.objects.link(ob)
        ob.parent = parent
        ob.location = loc
        return ob


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


# --------------------------------------------------------------------------
# glTF post-processing
# --------------------------------------------------------------------------
def strip_name_suffixes(path):
    """Blender forces unique object names ("body", "body.001", ...). The game
    looks children up by their plain name under each root, so drop the
    ".NNN" suffixes from node and mesh names inside the GLB."""
    import json
    import re
    import struct
    with open(path, "rb") as f:
        data = f.read()
    magic, version, _ = struct.unpack_from("<III", data, 0)
    jlen, jtype = struct.unpack_from("<II", data, 12)
    doc = json.loads(data[20:20 + jlen])
    rest = data[20 + jlen:]
    for key in ("nodes", "meshes"):
        for item in doc.get(key, []):
            if "name" in item:
                item["name"] = re.sub(r"\.\d{3}$", "", item["name"])
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    out = struct.pack("<III", magic, version, 12 + 8 + len(js) + len(rest)) + struct.pack("<II", len(js), jtype) + js + rest
    with open(path, "wb") as f:
        f.write(out)
    return os.path.getsize(path)


# --------------------------------------------------------------------------
# Preview renders (own scene, so the user's scene and settings are untouched)
# --------------------------------------------------------------------------
def preview(path, collections, cam_loc, target, lens=50.0, res=(960, 540), ortho=None,
            sun_rot=(50, 0, 30), sun_energy=3.0, world=(0.05, 0.06, 0.08), world_strength=1.0,
            exposure=0.0, clip_end=1000.0):
    """Render `collections` from cam_loc looking at target into path (PNG).

    Uses a throwaway scene "_preview" holding the given collections plus a
    "_preview" collection with the camera and a sun.
    """
    scn = bpy.data.scenes.get("_preview") or bpy.data.scenes.new("_preview")
    for c in list(scn.collection.children):
        scn.collection.children.unlink(c)
    pcoll = bpy.data.collections.get("_preview") or bpy.data.collections.new("_preview")
    for c in list(collections) + [pcoll]:
        scn.collection.children.link(c)
    cam = bpy.data.objects.get("_preview_cam")
    if cam is None:
        cam = bpy.data.objects.new("_preview_cam", bpy.data.cameras.new("_preview_cam"))
        pcoll.objects.link(cam)
    sun = bpy.data.objects.get("_preview_sun")
    if sun is None:
        sun = bpy.data.objects.new("_preview_sun", bpy.data.lights.new("_preview_sun", "SUN"))
        pcoll.objects.link(sun)
    cam.location = cam_loc
    d = Vector(target) - Vector(cam_loc)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = lens
    cam.data.clip_end = clip_end
    if ortho:
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = ortho
    else:
        cam.data.type = "PERSP"
    sun.rotation_euler = [math.radians(a) for a in sun_rot]
    sun.data.energy = sun_energy
    scn.camera = cam
    w = bpy.data.worlds.get("_preview_world") or bpy.data.worlds.new("_preview_world")
    w.use_nodes = True
    bg = next(n for n in w.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (*world, 1.0)
    bg.inputs["Strength"].default_value = world_strength
    scn.world = w
    r = scn.render
    r.engine = "BLENDER_EEVEE"
    r.resolution_x, r.resolution_y, r.resolution_percentage = res[0], res[1], 100
    r.image_settings.file_format = "PNG"
    r.filepath = path
    scn.view_settings.view_transform = "AgX"
    scn.view_settings.exposure = exposure
    try:
        scn.eevee.taa_render_samples = 16
    except AttributeError:
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with contextlib.redirect_stdout(io.StringIO()):
        bpy.ops.render.render(write_still=True, scene=scn.name)
    return path


RENDERS = os.path.join(REPO, "tools", "renders")
