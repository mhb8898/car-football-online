"""
Builds the boost pads and exports them to assets/pads.glb.

Run inside Blender (Text Editor, or over the MCP bridge with
`runpy.run_path(".../pads.py", run_name="__main__")`). Re-running replaces
the "Pads" collection.

Conventions (the game code depends on these exactly):
  - 1 Blender unit = 1 metre = 1 game unit, Z up; glTF export (export_yup)
    maps (x, y, z) -> three (x, z, -y)
  - roots sit on the ground: origin at the centre of the base, z = 0 is the
    ground. Laid out side by side here, exported at the origin
  - pad_big:   child pad_big_base (merged hexagonal plinth, radius 1.6,
               height 0.15: pad_metal / pad_dark + pad_glow ring) and a
               SEPARATE child pad_big_orb (sphere radius 0.65, object origin
               at its centre, z = 1.1; material pad_orb_glow)
  - pad_small: child pad_small_base (disc radius 0.9, height 0.08) and a
               SEPARATE child pad_small_orb (puck radius 0.45, origin at its
               centre, z = 0.25; material pad_orb_glow)
  - "_glow" materials are drawn unlit/emissive by the game (so the game
    can hide the orb while the pad recharges)
"""

import importlib
import math
import os
import sys

import bpy  # noqa: F401

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
importlib.reload(common)
from common import MeshBuilder, mat  # noqa: E402


def circle(r, n, phase=0.0):
    return [(r * math.cos(phase + 2 * math.pi * i / n), r * math.sin(phase + 2 * math.pi * i / n)) for i in range(n)]


def annulus(mb, r0, r1, z, m, n=32, phase=0.0):
    """Flat ring facing +Z."""
    inner, outer = circle(r0, n, phase), circle(r1, n, phase)
    verts = [(x, y, z) for x, y in outer] + [(x, y, z) for x, y in inner]
    faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    mb.add(verts, faces, m)


def lathe(mb, prof, m, n=24, z0=0.0, smooth=True):
    """Revolve a (r, z) profile running from the bottom axis to the top axis."""
    verts, faces = [], []
    rows = []
    for r, z in prof:
        if r < 1e-6:
            verts.append((0, 0, z + z0))
            rows.append([len(verts) - 1] * n)
        else:
            base = len(verts)
            verts += [(x, y, z + z0) for x, y in circle(r, n)]
            rows.append([base + i for i in range(n)])
    for a, b in zip(rows, rows[1:]):
        for i in range(n):
            i2 = (i + 1) % n
            q = [a[i], a[i2], b[i2], b[i]]
            f = []
            for v in q:
                if v not in f:
                    f.append(v)
            faces.append(tuple(f))
    mb.add(verts, faces, m, smooth, recalc=True)


def big_pad(root, M):
    mb = MeshBuilder()
    hexa = circle(1.6, 6, math.pi / 6)
    mb.prism(hexa, 0.0, 0.1, M["metal"], bottom=False)
    mb.prism(circle(1.64, 6, math.pi / 6), 0.035, 0.065, M["glow"], top=True, bottom=True)   # side glow band
    mb.prism(circle(1.45, 6, math.pi / 6), 0.1, 0.15, M["metal"], bottom=False)
    mb.prism(circle(1.02, 32), 0.15, 0.17, M["dark"], bottom=False)
    annulus(mb, 1.06, 1.26, 0.152, M["glow"], n=36)
    for i in range(6):   # little glowing chevrons pointing at the centre
        a = math.pi / 6 + i * math.pi / 3
        for side in (-1, 1):
            b = a + side * 0.12
            x0, y0 = 1.38 * math.cos(a), 1.38 * math.sin(a)
            x1, y1 = 1.3 * math.cos(b), 1.3 * math.sin(b)
            mb.cyl((x0, y0, 0.158), (x1, y1, 0.158), 0.018, M["glow"], segs=4, smooth=False)
    mb.finish("pad_big_base", root, sharp_angle=40)
    orb = MeshBuilder()
    orb.uvsphere((0, 0, 0), 0.65, M["orb"], segs=(20, 12))
    orb.finish("pad_big_orb", root, loc=(0, 0, 1.1))


def small_pad(root, M):
    mb = MeshBuilder()
    mb.prism(circle(0.9, 28), 0.0, 0.08, M["metal"], bottom=False)
    mb.prism(circle(0.55, 24), 0.08, 0.095, M["dark"], bottom=False)
    annulus(mb, 0.6, 0.72, 0.082, M["glow"], n=28)
    mb.finish("pad_small_base", root, sharp_angle=40)
    orb = MeshBuilder()
    lathe(orb, [(0, -0.06), (0.4, -0.06), (0.44, -0.045), (0.45, 0.0), (0.44, 0.045), (0.4, 0.06), (0, 0.06)],
          M["orb"], n=24)
    orb.finish("pad_small_orb", root, sharp_angle=50, loc=(0, 0, 0.25))


def build():
    common.use_collection("Pads")
    M = dict(
        metal=mat("pad_metal", "#2a2f3a", rough=0.4, metal=0.7),
        dark=mat("pad_dark", "#15181f", rough=0.6, metal=0.3),
        glow=mat("pad_glow", "#ff9a1a", rough=0.4, emit=3.0),
        orb=mat("pad_orb_glow", "#ffb020", rough=0.3, emit=4.0),
    )
    big = common.root("pad_big", (0, -2.2, 0))
    small = common.root("pad_small", (0, 2.2, 0))
    big_pad(big, M)
    small_pad(small, M)
    return [big, small]


def export(roots=None):
    roots = roots or [bpy.data.objects["pad_big"], bpy.data.objects["pad_small"]]
    return common.export_glb("pads.glb", roots, bpy.data.collections["Pads"])


def render_previews():
    coll = bpy.data.collections["Pads"]
    return [common.preview(os.path.join(common.RENDERS, "pads.png"), [coll], (6.5, -5.5, 4.0), (0, 0, 0.4),
                           lens=40, sun_rot=(45, 10, 35), world=(0.3, 0.33, 0.4))]


if __name__ == "__main__":
    build()
    export()
