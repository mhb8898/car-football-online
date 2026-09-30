"""
Builds the stadium and exports it to assets/arena.glb (+ assets/field.jpg).

Run inside Blender (Text Editor, or over the MCP bridge with
`runpy.run_path(".../arena.py", run_name="__main__")`). Re-running replaces
the "Arena" collection.

Conventions (the game code depends on these exactly):
  - 1 Blender unit = 1 metre = 1 game unit. Blender +X = field length axis,
    Y = field width, Z up; glTF export (export_yup) maps (x, y, z) -> three
    (x, z, -y). -X is the blue half, +X the orange half
  - playable floor x in [-46, 46], y in [-32, 32], corners chamfered at 45
    degrees from (+-38, +-32) to (+-46, +-24); goal mouths in the end walls
    for |y| < 9, 0 <= z < 7.5; goal boxes 7 m deep (x 46..53), |y| < 9,
    z < 7.5; ceiling at z = 20 (no geometry, a glowing rim marks it)
  - every inner wall face lies exactly on those planes (y = +-32, x = +-46,
    the chamfers, the goal box interior); all decoration is outside the play
    volume. Goal posts / crossbar (r 0.25) are tangent to the mouth edges
    from the outside
  - objects (one merged multi-material mesh each) under the root "arena":
      field        chamfered floor, UV u = (x+46)/92, v = (y+32)/64, material
                   "field" with an embedded JPEG (also saved as field.jpg)
      goal_floor   floor planes inside both goal boxes
      walls        lower walls 0..3.5 (+ header over each goal mouth),
                   wall_glow_blue on -X, wall_glow_orange on +X
      glass        panels 3.5..20 (8.6..20 above the goal mouths), "glass"
      frame        struts and top rim (frame, rim_glow)
      goal_blue / goal_orange   posts, crossbar, net rods ("net"), shell
      stands       tiers, seats, crowd (crowd_0..crowd_5), railings, apron
      towers       floodlight pylons (flood_glow) and end screens (screen_glow)
  - "_glow" materials are drawn unlit by the game, "glass" transparent,
    "net" semi-transparent; everything else is flat Principled values
"""

import importlib
import math
import os
import random
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
importlib.reload(common)
from common import MeshBuilder, mat  # noqa: E402

L, W, CH = 46.0, 32.0, 8.0            # half length, half width, chamfer
GOAL_W, GOAL_H, GOAL_D = 9.0, 7.5, 7.0
CEIL, WALL_H, WALL_T = 20.0, 3.5, 0.6
POST_R = 0.25
GAP = GOAL_W + 2 * POST_R            # lower wall / glass stop here beside the goal (post fills the rest)
HEADER_Z = 8.0                       # front face of the header starts above the crossbar
HEADER_TOP = 8.6
IMG = (2048, 1424)


def M():
    return dict(
        field=mat("field", "#ffffff", rough=0.9),
        goal_floor=mat("goal_floor", "#1c2a22", rough=0.9),
        wall=mat("wall_panel", "#1b2233", rough=0.7, metal=0.2),
        glow_b=mat("wall_glow_blue", "#3a8bff", rough=0.4, emit=3.0),
        glow_o=mat("wall_glow_orange", "#ff8a1f", rough=0.4, emit=3.0),
        glass=mat("glass", "#0e1624", rough=0.08, metal=0.6, alpha=0.35),
        frame=mat("frame", "#2a3142", rough=0.4, metal=0.7),
        rim=mat("rim_glow", "#cfe6ff", rough=0.4, emit=2.0),
        goal_b=mat("goal_glow_blue", "#3a8bff", rough=0.4, emit=3.0),
        goal_o=mat("goal_glow_orange", "#ff8a1f", rough=0.4, emit=3.0),
        net=mat("net", "#d0d8e8", rough=0.5, alpha=0.6),
        shell=mat("goal_shell", "#11151d", rough=0.8),
        stand=mat("stand_concrete", "#2a2f3b", rough=0.9),
        seat=mat("seat", "#1a1f2b", rough=0.7),
        rail=mat("railing", "#8a93a6", rough=0.35, metal=0.8),
        apron=mat("apron", "#0d1016", rough=0.9),
        crowd=[mat(f"crowd_{i}", c, rough=0.8) for i, c in
               enumerate(("#2f6bff", "#59c8ff", "#e9edf5", "#ff7a1a", "#ffd33d", "#ff4a6e"))],
        tower=mat("tower_steel", "#3a4152", rough=0.5, metal=0.7),
        flood=mat("flood_glow", "#fff6e0", rough=0.3, emit=5.0),
        screen_frame=mat("screen_frame", "#141925", rough=0.6, metal=0.4),
        screen=mat("screen_glow", "#1e3a6e", rough=0.3, emit=1.0),
    )


# --------------------------------------------------------------------------
# 2D helpers
# --------------------------------------------------------------------------
def octagon(hx, hy, c):
    """Counter-clockwise chamfered rectangle."""
    return [(hx, -(hy - c)), (hx, hy - c), (hx - c, hy), (-(hx - c), hy),
            (-hx, hy - c), (-hx, -(hy - c)), (-(hx - c), -hy), (hx - c, -hy)]


def edge_normal(a, b):
    ex, ey = b[0] - a[0], b[1] - a[1]
    n = math.hypot(ex, ey)
    return (ey / n, -ex / n)   # outward for a counter-clockwise outline


def offsets(pts, closed):
    """Unit miter offset vectors (outward) at every vertex."""
    out = []
    n = len(pts)
    for i in range(n):
        ns = []
        if closed or i > 0:
            ns.append(edge_normal(pts[i - 1], pts[i]))
        if closed or i < n - 1:
            ns.append(edge_normal(pts[i], pts[(i + 1) % n]))
        if len(ns) == 1:
            out.append(ns[0])
        else:
            (ax, ay), (bx, by) = ns
            k = 1.0 / (1.0 + ax * bx + ay * by)
            out.append(((ax + bx) * k, (ay + by) * k))
    return out


def offset_poly(pts, d, closed=True):
    return [(p[0] + o[0] * d, p[1] + o[1] * d) for p, o in zip(pts, offsets(pts, closed))]


def slab(mb, p, q, op, oq, d0, d1, z0, z1, m):
    """Solid between the lines p->q offset by d0 and d1 (along op/oq), z0..z1."""
    pts = []
    for d in (d0, d1):
        pts.append((p[0] + op[0] * d, p[1] + op[1] * d))
        pts.append((q[0] + oq[0] * d, q[1] + oq[1] * d))
    a0, b0, a1, b1 = pts
    ring = [a0, b0, b1, a1]
    verts = [(x, y, z0) for x, y in ring] + [(x, y, z1) for x, y in ring]
    faces = [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    mb.add(verts, faces, m, recalc=True)


def lerp2(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


# The lower wall runs as two polylines (the goal mouths are gaps); split at
# x = 0 so each piece belongs to one team half.
POLY_N = [(L, GAP), (L, W - CH), (L - CH, W), (0.0, W), (-(L - CH), W), (-L, W - CH), (-L, GAP)]
POLY_S = [(-L, -GAP), (-L, -(W - CH)), (-(L - CH), -W), (0.0, -W), (L - CH, -W), (L, -(W - CH)), (L, -GAP)]


def segments():
    """(p, q, offset_p, offset_q) for every wall segment, inner face on the plane."""
    out = []
    for poly in (POLY_N, POLY_S):
        offs = offsets(poly, closed=False)
        for i in range(len(poly) - 1):
            out.append((poly[i], poly[i + 1], offs[i], offs[i + 1]))
    return out


def strut_params(p, q, spacing=8.0):
    n = max(1, round(math.dist(p, q) / spacing))
    return [i / n for i in range(n + 1)]


# --------------------------------------------------------------------------
# Field texture
# --------------------------------------------------------------------------
def smooth(edge0, edge1, x):
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def field_image():
    w, h = IMG
    rng = np.random.default_rng(3)
    xs = (np.arange(w) + 0.5) / w * 2 * L - L
    ys = (np.arange(h) + 0.5) / h * 2 * W - W
    X, Y = np.meshgrid(xs, ys)              # row 0 = bottom = y -32 (Blender image order)
    px = 2 * L / w
    band = (np.floor((X + L) / (2 * L / 12)) % 2)[..., None]
    a = np.array([0.15, 0.37, 0.17])
    b = np.array([0.19, 0.44, 0.21])
    col = a * (1 - band) + b * band
    # low-frequency blotches + fine grain
    lo = rng.random((46, 66))
    lo_img = np.kron(lo, np.ones((h // 46 + 1, w // 66 + 1)))[:h, :w]
    k = 25
    ker = np.ones(k) / k
    lo_img = np.apply_along_axis(lambda r: np.convolve(r, ker, mode="same"), 1, lo_img)
    lo_img = np.apply_along_axis(lambda r: np.convolve(r, ker, mode="same"), 0, lo_img)
    col = col * (0.93 + 0.12 * lo_img[..., None]) + rng.normal(0, 0.012, (h, w, 1))
    # team tints
    tb = (1 - smooth(-1.0, 1.0, X))[..., None]
    col = col * (1 - 0.22 * tb) + np.array([0.12, 0.28, 0.65]) * 0.22 * tb
    to = smooth(-1.0, 1.0, X)[..., None]
    col = col * (1 - 0.18 * to) + np.array([0.8, 0.42, 0.1]) * 0.18 * to
    # lines
    hw = 0.15

    def line(d):
        return 1 - smooth(hw - px, hw + px, np.abs(d))
    s2 = 1 / math.sqrt(2)
    diag = (L + W - CH) * s2
    sd = np.maximum.reduce([np.abs(X) - L, np.abs(Y) - W, (np.abs(X) + np.abs(Y)) * s2 - diag])
    m = line(sd + 0.6)
    m = np.maximum(m, line(X))
    r = np.hypot(X, Y)
    m = np.maximum(m, line(r - 9.0))
    m = np.maximum(m, 1 - smooth(0.5 - px, 0.5 + px, r))
    box_x = L - 8.0
    inbox_y = (np.abs(Y) < 15 + hw)
    m = np.maximum(m, line(np.abs(X) - box_x) * inbox_y)
    along = (np.abs(X) > box_x - hw) & (np.abs(X) < L - 0.6)
    m = np.maximum(m, line(np.abs(Y) - 15) * along)
    white = np.array([0.93, 0.95, 0.97])
    col = col * (1 - 0.92 * m[..., None]) + white * 0.92 * m[..., None]
    outside = smooth(-0.05, 0.05, sd)[..., None]
    col = col * (1 - outside) + np.array([0.05, 0.08, 0.06]) * outside
    rgba = np.concatenate([np.clip(col, 0, 1), np.ones((h, w, 1))], axis=2).astype(np.float32)

    path = os.path.join(common.ASSETS, "field.jpg")
    os.makedirs(common.ASSETS, exist_ok=True)
    src = bpy.data.images.get("_field_src") or bpy.data.images.new("_field_src", w, h, alpha=False)
    if tuple(src.size) != (w, h):
        src.scale(w, h)
    src.pixels.foreach_set(rgba.ravel())
    src.filepath_raw = path
    src.file_format = "JPEG"
    src.save(filepath=path, quality=90)
    img = bpy.data.images.get("field.jpg")
    if img is None:
        img = bpy.data.images.load(path)
    else:
        img.filepath = path
        img.reload()
    bpy.data.images.remove(src)
    return img, path


def field_material(m, img):
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tex = next((n for n in nt.nodes if n.type == "TEX_IMAGE"), None) or nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.location = (-400, 200)
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    return m


# --------------------------------------------------------------------------
# Pieces
# --------------------------------------------------------------------------
def build_field(root, mm):
    pts = octagon(L, W, CH)
    me = bpy.data.meshes.new("field")
    me.from_pydata([(x, y, 0.0) for x, y in pts], [], [tuple(range(len(pts)))])
    uv = me.uv_layers.new(name="UVMap")
    for loop in me.loops:
        x, y, _ = me.vertices[loop.vertex_index].co
        uv.data[loop.index].uv = ((x + L) / (2 * L), (y + W) / (2 * W))
    me.materials.append(mm["field"])
    ob = bpy.data.objects.new("field", me)
    common.COLL.objects.link(ob)
    ob.parent = root

    mb = MeshBuilder()
    for s in (1, -1):
        x0, x1 = sorted((s * L, s * (L + GOAL_D + 0.6)))
        mb.add([(x0, -GOAL_W - 0.6, 0), (x1, -GOAL_W - 0.6, 0), (x1, GOAL_W + 0.6, 0), (x0, GOAL_W + 0.6, 0)],
               [(0, 1, 2, 3)], mm["goal_floor"])
    mb.finish("goal_floor", root)


def build_walls(root, mm):
    mb = MeshBuilder()
    bands = [(0.0, 0.22, "glow"), (0.22, WALL_H - 0.22, "wall"), (WALL_H - 0.22, WALL_H, "glow")]
    for p, q, op, oq in segments():
        glow = mm["glow_b"] if (p[0] + q[0]) < 0 else mm["glow_o"]
        # panels with frame-coloured seams at the strut positions
        ts = strut_params(p, q)
        seg_len = math.dist(p, q)
        hs = 0.12 / seg_len
        cuts = []
        for t in ts:
            cuts += [max(0.0, t - hs), min(1.0, t + hs)]
        cuts = sorted(set([0.0, 1.0] + cuts))
        for t0, t1 in zip(cuts, cuts[1:]):
            if t1 - t0 < 1e-6:
                continue
            seam = any(abs((t0 + t1) / 2 - t) < hs + 1e-9 for t in ts)
            a, b = lerp2(p, q, t0), lerp2(p, q, t1)
            oa = lerp2(op, oq, t0)
            ob_ = lerp2(op, oq, t1)
            for z0, z1, kind in bands:
                m = glow if kind == "glow" else (mm["frame"] if seam else mm["wall"])
                slab(mb, a, b, oa, ob_, 0.0, WALL_T, z0, z1, m)
    # header over each goal mouth: front face on x = +-46 from HEADER_Z up,
    # set back behind the crossbar below that
    for s in (1, -1):
        glow = mm["glow_o"] if s > 0 else mm["glow_b"]
        x0, x1 = sorted((s * L, s * (L + WALL_T)))
        mb.box((x0, -GAP, HEADER_Z), (x1, GAP, HEADER_TOP - 0.18), mm["wall"])
        mb.box((x0, -GAP, HEADER_TOP - 0.18), (x1, GAP, HEADER_TOP), glow)
        xb0, xb1 = sorted((s * (L + 2 * POST_R), s * (L + WALL_T)))
        mb.box((xb0, -GAP, GOAL_H), (xb1, GAP, HEADER_Z), mm["wall"])
    mb.finish("walls", root)


def build_glass_frame(root, mm):
    g, f = MeshBuilder(), MeshBuilder()
    t_glass = 0.06
    for p, q, op, oq in segments():
        slab(g, p, q, op, oq, 0.0, t_glass, WALL_H, CEIL, mm["glass"])
        for t in strut_params(p, q):
            a = lerp2(p, q, t)
            o = lerp2(op, oq, t)
            ex, ey = q[0] - p[0], q[1] - p[1]
            n = math.hypot(ex, ey)
            ex, ey = ex / n * 0.15, ey / n * 0.15
            slab(f, (a[0] - ex, a[1] - ey), (a[0] + ex, a[1] + ey), o, o, t_glass, 0.4, WALL_H, CEIL, mm["frame"])
    for s in (1, -1):
        p, q = (s * L, -GAP), (s * L, GAP)
        o = (s, 0.0)
        pp, qq = (p, q) if s > 0 else (q, p)
        slab(g, pp, qq, o, o, 0.0, t_glass, HEADER_TOP, CEIL, mm["glass"])
        for y in (-GAP, 0.0, GAP):
            slab(f, (s * L, y - 0.15), (s * L, y + 0.15), o, o, t_glass, 0.4, HEADER_TOP if y == 0.0 else WALL_H,
                 CEIL, mm["frame"])
    # top rim around the whole perimeter, just above the ceiling height
    oc = octagon(L, W, CH)
    offs = offsets(oc, closed=True)
    for i in range(len(oc)):
        j = (i + 1) % len(oc)
        slab(f, oc[i], oc[j], offs[i], offs[j], 0.0, 1.0, CEIL, CEIL + 0.18, mm["rim"])
        slab(f, oc[i], oc[j], offs[i], offs[j], 0.0, 1.0, CEIL + 0.18, CEIL + 0.6, mm["frame"])
    g.finish("glass", root)
    f.finish("frame", root)


def build_goal(root, mm, s, name, glow):
    mb = MeshBuilder()
    xo = s * (L + POST_R)
    for y in (-1, 1):
        mb.cyl((xo, y * (GOAL_W + POST_R), 0.0), (xo, y * (GOAL_W + POST_R), GOAL_H + 2 * POST_R), POST_R, glow, segs=14)
    mb.cyl((xo, -(GOAL_W + 2 * POST_R), GOAL_H + POST_R), (xo, GOAL_W + 2 * POST_R, GOAL_H + POST_R), POST_R, glow,
           segs=14)
    # glowing back edges of the box
    xb = s * (L + GOAL_D + 0.1)
    for y in (-1, 1):
        mb.cyl((xb, y * (GOAL_W + 0.1), 0.0), (xb, y * (GOAL_W + 0.1), GOAL_H + 0.1), 0.09, glow, segs=6)
        mb.cyl((s * (L + 0.5), y * (GOAL_W + 0.1), GOAL_H + 0.1), (xb, y * (GOAL_W + 0.1), GOAL_H + 0.1), 0.09, glow, segs=6)
    mb.cyl((xb, -(GOAL_W + 0.1), GOAL_H + 0.1), (xb, GOAL_W + 0.1, GOAL_H + 0.1), 0.09, glow, segs=6)
    # net: square rods just outside the interior planes, grid ~0.7 m
    r = 0.03

    def rod(lo, hi):
        mb.box(lo, hi, mm["net"])

    def xs_between(a, b, step=0.7):
        n = max(1, round(abs(b - a) / step))
        return [a + (b - a) * i / n for i in range(1, n)]
    x_in, x_back = s * L, s * (L + GOAL_D)
    xlo, xhi = sorted((x_in, x_back))
    xs = xs_between(x_in + s * 0.5, x_back) + [x_back]
    zs = xs_between(0.0, GOAL_H) + [GOAL_H]
    ys = xs_between(-GOAL_W, GOAL_W) + [-GOAL_W, GOAL_W]
    for y in (-1, 1):                         # side nets on y = +-9
        yy = sorted((y * GOAL_W, y * (GOAL_W + 2 * r)))
        for x in xs:
            rod((x - r, yy[0], 0.0), (x + r, yy[1], GOAL_H), )
        for z in zs:
            rod((xlo, yy[0], z - r), (xhi, yy[1], z + r))
    xx = sorted((x_back, x_back + s * 2 * r))  # back net on x = +-53
    for y in ys:
        rod((xx[0], y - r, 0.0), (xx[1], y + r, GOAL_H))
    for z in zs:
        rod((xx[0], -GOAL_W, z - r), (xx[1], GOAL_W, z + r))
    for x in xs:                              # roof net on z = 7.5
        rod((x - r, -GOAL_W, GOAL_H), (x + r, GOAL_W, GOAL_H + 2 * r))
    for y in ys:
        rod((xlo, y - r, GOAL_H), (xhi, y + r, GOAL_H + 2 * r))
    # dark shell behind the net
    xs0, xs1 = sorted((s * (L + WALL_T), s * (L + GOAL_D + 0.9)))
    xb0, xb1 = sorted((s * (L + GOAL_D + 0.6), s * (L + GOAL_D + 0.9)))
    for y in (-1, 1):
        yy = sorted((y * (GOAL_W + 0.6), y * (GOAL_W + 0.9)))
        mb.box((xs0, yy[0], 0.0), (xs1, yy[1], GOAL_H + 0.9), mm["shell"])
    mb.box((xb0, -(GOAL_W + 0.6), 0.0), (xb1, GOAL_W + 0.6, GOAL_H + 0.9), mm["shell"])
    mb.box((xs0, -(GOAL_W + 0.9), GOAL_H + 0.6), (xs1, GOAL_W + 0.9, GOAL_H + 0.9), mm["shell"])
    mb.finish(name, root, sharp_angle=40)


# stands --------------------------------------------------------------------
SX, SY, SC = 57.0, 35.0, 13.0
TIERS, DEPTH, RISE, Z0 = 12, 1.3, 1.2, 1.2
CROWD_MAX = 4000


def ring_top(mb, inner, outer, z, m):
    n = len(inner)
    for k in range(n):
        k2 = (k + 1) % n
        mb.add([(*inner[k], z), (*outer[k], z), (*outer[k2], z), (*inner[k2], z)], [(0, 1, 2, 3)], m)


def ring_wall(mb, poly, z0, z1, m, inward=True):
    n = len(poly)
    for k in range(n):
        k2 = (k + 1) % n
        a, b = poly[k], poly[k2]
        if inward:
            mb.add([(*a, z0), (*a, z1), (*b, z1), (*b, z0)], [(0, 1, 2, 3)], m)
        else:
            mb.add([(*a, z0), (*b, z0), (*b, z1), (*a, z1)], [(0, 1, 2, 3)], m)


def person(mb, c, a, h, m, hw=0.22, hd=0.17):
    """Box standing at c (x, y, z), width along unit a; no bottom face."""
    b = (-a[1], a[0])     # inward (towards the field) so a x b = +Z
    cs = []
    for sz in (0, h):
        for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            cs.append((c[0] + a[0] * sx * hw + b[0] * sy * hd, c[1] + a[1] * sx * hw + b[1] * sy * hd, c[2] + sz))
    mb.add(cs, common.BOX_FACES[1:], m)


def build_stands(root, mm, rng):
    mb = MeshBuilder()
    base = octagon(SX, SY, SC)
    mb.add([(-95, -75, -0.05), (95, -75, -0.05), (95, 75, -0.05), (-95, 75, -0.05)], [(0, 1, 2, 3)], mm["apron"])
    zs = [Z0 + i * RISE for i in range(TIERS)]
    for i in range(TIERS):
        inner = offset_poly(base, i * DEPTH)
        outer = offset_poly(base, (i + 1) * DEPTH)
        ring_top(mb, inner, outer, zs[i], mm["stand"])
        ring_wall(mb, inner, 0.0 if i == 0 else zs[i - 1], zs[i], mm["stand"])
        s0 = offset_poly(base, i * DEPTH + 0.9)
        s1 = offset_poly(base, i * DEPTH + 1.22)
        ring_top(mb, s0, s1, zs[i] + 0.45, mm["seat"])
        ring_wall(mb, s0, zs[i], zs[i] + 0.45, mm["seat"])
    top = zs[-1] + 2.4
    back0 = offset_poly(base, TIERS * DEPTH)
    back1 = offset_poly(base, TIERS * DEPTH + 0.6)
    ring_wall(mb, back0, zs[-1], top, mm["stand"])
    ring_wall(mb, back1, 0.0, top, mm["stand"], inward=False)
    ring_top(mb, back0, back1, top, mm["frame"])
    # railings: along the front of the stands and the top of the back wall
    for poly, z in ((offset_poly(base, 0.15), Z0 + 1.0), (offset_poly(base, TIERS * DEPTH - 0.2), top - 1.3)):
        n = len(poly)
        for k in range(n):
            a, b = poly[k], poly[(k + 1) % n]
            mb.cyl((*a, z), (*b, z), 0.05, mm["rail"], segs=4, smooth=False, caps=False)
            seg = math.dist(a, b)
            for t in range(int(seg // 4) + 1):
                p = lerp2(a, b, min(1.0, t * 4 / seg))
                mb.box((p[0] - 0.04, p[1] - 0.04, z - 1.0), (p[0] + 0.04, p[1] + 0.04, z), mm["rail"])
    # crowd
    slots = []
    for i in range(TIERS):
        poly = offset_poly(base, i * DEPTH + 0.55)
        n = len(poly)
        for k in range(n):
            a, b = poly[k], poly[(k + 1) % n]
            seg = math.dist(a, b)
            u = ((b[0] - a[0]) / seg, (b[1] - a[1]) / seg)
            cnt = int(seg / 0.7)
            for j in range(cnt):
                d = (j + 0.5) * seg / cnt
                if (d % 15.0) < 1.3 or d < 0.6 or seg - d < 0.6:    # aisles
                    continue
                slots.append((a[0] + u[0] * d, a[1] + u[1] * d, zs[i], u))
    rng.shuffle(slots)
    slots = slots[:CROWD_MAX]
    for x, y, z, u in slots:
        t = max(-1.0, min(1.0, x / SX))
        wts = [1.0, 1.0, 1.2, 1.0, 1.0, 0.8]
        if t < 0:
            wts[0] += 6 * -t
            wts[1] += 3 * -t
        else:
            wts[3] += 6 * t
            wts[4] += 3 * t
        m = rng.choices(mm["crowd"], weights=wts)[0]
        h = rng.uniform(0.62, 0.95)
        jx, jy = rng.uniform(-0.08, 0.08), rng.uniform(-0.06, 0.06)
        person(mb, (x + jx, y + jy, z), u, h, m)
    mb.finish("stands", root)
    return len(slots)


def build_towers(root, mm):
    mb = MeshBuilder()
    for sx in (1, -1):
        for sy in (1, -1):
            bx, by = sx * 64.0, sy * 50.0
            h = 33.0
            legs = []
            for lx, ly in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
                a = (bx + lx * 1.6, by + ly * 1.6, 0.0)
                b = (bx + lx * 0.6, by + ly * 0.6, h)
                legs.append((a, b))
                mb.cyl(a, b, 0.22, mm["tower"], segs=6)
            for k in range(4):
                (a0, b0), (a1, b1) = legs[k], legs[(k + 1) % 4]
                for z in range(0, int(h) - 4, 6):
                    t0, t1 = z / h, (z + 6) / h
                    p0 = Vector(a0).lerp(Vector(b0), t0)
                    p1 = Vector(a1).lerp(Vector(b1), t1)
                    mb.cyl(p0, p1, 0.08, mm["tower"], segs=4, smooth=False)
            head = Vector((bx, by, h + 2.2))
            d = (Vector((0.0, 0.0, 0.0)) - head).normalized()
            rot = d.to_track_quat("X", "Z").to_matrix().to_4x4()
            mt = Matrix.Translation(head) @ rot
            mb.obox((0, 0, 0), (0.35, 4.2, 2.6), mm["tower"], matrix=mt)
            for iy in range(4):
                for iz in range(3):
                    c = Vector((0.38, -3.15 + iy * 2.1, -1.7 + iz * 1.7))
                    mb.obox((0, 0, 0), (0.05, 0.9, 0.7), mm["flood"], matrix=mt @ Matrix.Translation(c))
    # big screens above the end stands
    xs = SX + TIERS * DEPTH + 1.6
    for s in (1, -1):
        x0, x1 = sorted((s * xs, s * (xs + 1.2)))
        mb.box((x0, -14.0, 18.0), (x1, 14.0, 30.0), mm["screen_frame"])
        xf = s * (xs - 0.06)
        f0, f1 = sorted((xf, s * xs))
        mb.box((f0, -13.2, 18.8), (f1, 13.2, 29.2), mm["screen"])
        for y in (-9.0, 9.0):
            mb.box((min(x0, x1) + 0.2, y - 0.5, 0.0), (max(x0, x1) - 0.2, y + 0.5, 18.0), mm["screen_frame"])
    mb.finish("towers", root, sharp_angle=40)


# --------------------------------------------------------------------------
def build(seed=11):
    common.use_collection("Arena")
    rng = random.Random(seed)
    mm = M()
    img, _ = field_image()
    field_material(mm["field"], img)
    r = common.root("arena", (0, 0, 0))
    build_field(r, mm)
    build_walls(r, mm)
    build_glass_frame(r, mm)
    build_goal(r, mm, -1, "goal_blue", mm["goal_b"])
    build_goal(r, mm, 1, "goal_orange", mm["goal_o"])
    crowd = build_stands(r, mm, rng)
    build_towers(r, mm)
    r["crowd"] = crowd
    return [r]


def export(roots=None):
    roots = roots or [bpy.data.objects["arena"]]
    return common.export_glb("arena.glb", roots, bpy.data.collections["Arena"], at_origin=False)


def render_previews():
    coll = bpy.data.collections["Arena"]
    R = common.RENDERS
    kw = dict(sun_rot=(50, 0, 40), sun_energy=2.5, world=(0.12, 0.14, 0.2), clip_end=2000)
    return [
        common.preview(os.path.join(R, "arena_overview.png"), [coll], (-88, -92, 62), (0, 0, 0), lens=28, **kw),
        common.preview(os.path.join(R, "arena_top.png"), [coll], (0, 0, 150), (0, 0, 0), ortho=125, **kw),
        common.preview(os.path.join(R, "arena_goal.png"), [coll], (28, -14, 4.5), (46, 0, 4), lens=30, **kw),
    ]


if __name__ == "__main__":
    build()
    export()
