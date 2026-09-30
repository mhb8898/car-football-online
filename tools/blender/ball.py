"""
Builds the ball and exports it to assets/ball.glb.

Run inside Blender (Text Editor, or over the MCP bridge with
`runpy.run_path(".../ball.py", run_name="__main__")`). Re-running replaces
the "Ball" collection.

Conventions (the game code depends on these exactly):
  - 1 Blender unit = 1 metre = 1 game unit, Z up; glTF export (export_yup)
    maps (x, y, z) -> three (x, z, -y)
  - root empty "ball" with one child mesh "ball_mesh"; both origins at the
    ball centre; the outermost vertices sit at radius exactly 1.9 (RADIUS)
  - truncated-icosahedron panelling: 12 pentagons (ball_pent) and 20
    hexagons (ball_panel), each subdivided and projected onto the sphere,
    inset from thin recessed seam strips (ball_seam_glow, drawn unlit by the
    game because of "_glow" in its name)
  - flat Principled materials only
"""

import importlib
import math
import os
import sys

import bpy  # noqa: F401
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
importlib.reload(common)
from common import MeshBuilder, mat  # noqa: E402

RADIUS = 1.9
SEAM_R = 1.855      # radius of the recessed seam floor
SEAM_K = 0.95       # panel border inset (fraction of centre->edge) where the seam wall starts
TOP_K = 0.925       # inset where the wall reaches the panel surface
EDGE_SUB = 2        # boundary subdivisions per panel edge
RINGS = 3           # interior rings from the panel edge to its centre


def truncated_icosahedron():
    """The 32 flat faces (lists of Vectors, counter-clockwise from outside)."""
    phi = (1 + 5 ** 0.5) / 2
    verts = []
    for a in (-1, 1):
        for b in (-phi, phi):
            verts += [Vector((0, a, b)), Vector((a, b, 0)), Vector((b, 0, a))]
    edge = 2.0
    nbr = {i: [j for j in range(12) if j != i and abs((verts[i] - verts[j]).length - edge) < 1e-6]
           for i in range(12)}

    def cut(a, b):
        return verts[a] + (verts[b] - verts[a]) / 3

    def ccw(pts):
        c = sum(pts, Vector()) / len(pts)
        n = c.normalized()
        u = (pts[0] - c).normalized()
        v = n.cross(u)
        return sorted(pts, key=lambda p: math.atan2((p - c).dot(v), (p - c).dot(u)))

    pents = [ccw([cut(i, j) for j in nbr[i]]) for i in range(12)]
    tris = set()
    for i in range(12):
        for j in nbr[i]:
            for k in nbr[j]:
                if k in nbr[i]:
                    tris.add(tuple(sorted((i, j, k))))
    hexes = [ccw([cut(a, b), cut(b, a), cut(b, c), cut(c, b), cut(c, a), cut(a, c)]) for a, b, c in tris]
    return pents, hexes


def panel(mb, poly, m_panel, m_seam):
    c = sum(poly, Vector()) / len(poly)
    border = []
    for k, a in enumerate(poly):
        b = poly[(k + 1) % len(poly)]
        for s in range(EDGE_SUB):
            border.append(a + (b - a) * (s / EDGE_SUB))

    def ring(k, r):
        return [(c + (p - c) * k).normalized() * r for p in border]

    rings = [ring(1.0, SEAM_R), ring(SEAM_K, SEAM_R), ring(TOP_K, RADIUS)]
    rings += [ring(TOP_K * (1 - i / RINGS), RADIUS) for i in range(1, RINGS)]
    mats = [m_seam, m_panel] + [m_panel] * (len(rings) - 2)
    n = len(border)
    verts = [p for r in rings for p in r] + [c.normalized() * RADIUS]
    faces, fm = [], []
    for ri in range(len(rings) - 1):
        for j in range(n):
            j2 = (j + 1) % n
            faces.append((ri * n + j, ri * n + j2, (ri + 1) * n + j2, (ri + 1) * n + j))
            fm.append(mats[ri])
    last, centre = (len(rings) - 1) * n, len(verts) - 1
    for j in range(n):
        faces.append((last + j, last + (j + 1) % n, centre))
        fm.append(m_panel)
    mb.add(verts, faces, fm, smooth=True)


def build():
    common.use_collection("Ball")
    white = mat("ball_panel", "#d9dde6", rough=0.45)
    dark = mat("ball_pent", "#2a2f3a", rough=0.45)
    seam = mat("ball_seam_glow", "#7fe8ff", rough=0.4, emit=2.0)
    r = common.root("ball", (0, 0, 0))
    mb = MeshBuilder()
    pents, hexes = truncated_icosahedron()
    for p in hexes:
        panel(mb, p, white, seam)
    for p in pents:
        panel(mb, p, dark, seam)
    mb.bm.verts.ensure_lookup_table()
    ob = mb.finish("ball_mesh", r, sharp_angle=30)
    return [r]


def export(roots=None):
    roots = roots or [bpy.data.objects["ball"]]
    return common.export_glb("ball.glb", roots, bpy.data.collections["Ball"])


def render_previews():
    coll = bpy.data.collections["Ball"]
    return [common.preview(os.path.join(common.RENDERS, "ball.png"), [coll], (7.0, -9.0, 4.5), (0, 0, 0),
                           lens=60, sun_rot=(45, 10, 35), world=(0.3, 0.33, 0.4))]


if __name__ == "__main__":
    build()
    export()
