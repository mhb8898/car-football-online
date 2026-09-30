"""
Builds the three playable cars and exports them to assets/cars.glb.

Run inside Blender (Text Editor, or over the MCP bridge with
`runpy.run_path(".../cars.py", run_name="__main__")`). Re-running replaces
the "Cars" collection, so edit and re-run freely.

Conventions (the game code depends on these exactly):
  - 1 Blender unit = 1 metre = 1 game unit; +X is forward, +Z is up, +Y is
    the car's left. glTF export (export_yup) maps (x, y, z) -> three (x, z, -y)
  - three roots (empties) car_comet, car_stinger, car_bulldog, laid out side
    by side here but exported at the origin. A root's origin is the centre
    of the gameplay hitbox: half-extents 1.75 (X) x 1.05 (Y) x 0.6 (Z).
    The ground is at z = -0.9 relative to the root (wheel bottoms touch it)
  - children of each root:
      body      one merged mesh; materials paint (swapped for the team
                colour at runtime), trim, glass, accent, head_glow, tail_glow
      wheel_fl, wheel_fr, wheel_rl, wheel_rr
                separate meshes, origin at the wheel centre, axle along local
                Y (spin about Y, steer the front pair about Z); materials
                tire and rim. fl/rl are on +Y (left), fr/rr on -Y
      exhaust   empty at the rear centre where the boost flame comes out
                (the flame points -X)
  - "_glow" materials are drawn unlit by the game, "glass" transparent
  - Blender suffixes duplicate object names ("body.001"); export() strips
    those suffixes inside the GLB so every car has plain child names
"""

import importlib
import math
import os
import sys

import bmesh  # noqa: F401
import bpy  # noqa: F401
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
importlib.reload(common)
from common import MeshBuilder, mat  # noqa: E402

GROUND = -0.9
SPACING = 3.6


def materials():
    return dict(
        paint=mat("paint", "#3a7bff", rough=0.35, metal=0.3),
        trim=mat("trim", "#1a1c22", rough=0.6),
        glass=mat("glass", "#0e1624", rough=0.08, metal=0.6, alpha=0.35),
        accent=mat("accent", "#e6e8ee", rough=0.4, metal=0.1),
        head=mat("head_glow", "#fff2c8", rough=0.3, emit=3.0),
        tail=mat("tail_glow", "#ff2a2a", rough=0.3, emit=3.0),
        tire=mat("tire", "#121316", rough=0.9),
        rim=mat("rim", "#b9bec8", rough=0.3, metal=0.85),
    )


# --------------------------------------------------------------------------
# Profiles and lofts
# --------------------------------------------------------------------------
def interp(keys, x):
    """Piecewise-linear lookup in [(x, value), ...] (sorted by x)."""
    if x <= keys[0][0]:
        return keys[0][1]
    for (x0, v0), (x1, v1) in zip(keys, keys[1:]):
        if x <= x1:
            t = (x - x0) / (x1 - x0) if x1 > x0 else 0.0
            return v0 + (v1 - v0) * t
    return keys[-1][1]


class Station:
    """One cross-section: a superellipse |y/w|^p + |cz|^p = 1 whose width
    goes from wb at the bottom to wt at the top (tumblehome)."""

    def __init__(self, x, wb, wt, zb, zt, p):
        self.x, self.wb, self.wt, self.zb, self.zt, self.p = x, wb, wt, zb, zt, p

    @property
    def zc(self):
        return (self.zb + self.zt) / 2

    @property
    def hh(self):
        return (self.zt - self.zb) / 2

    def w(self, cz):
        return self.wb + (self.wt - self.wb) * (cz + 1) / 2

    def ring(self, m):
        e = 2.0 / self.p
        pts = []
        for k in range(m):
            t = 2 * math.pi * k / m
            c, s = math.cos(t), math.sin(t)
            cy = math.copysign(abs(c) ** e, c)
            cz = math.copysign(abs(s) ** e, s)
            pts.append(Vector((self.x, cy * self.w(cz), self.zc + cz * self.hh)))
        return pts

    def top_z(self, y):
        """Height of the upper surface above lateral offset y."""
        y = abs(y)
        lo, hi = 0.0, 1.0
        for _ in range(30):
            cz = (lo + hi) / 2
            if (min(1.0, y / self.w(cz))) ** self.p + cz ** self.p > 1.0:
                hi = cz
            else:
                lo = cz
        return self.zc + lo * self.hh

    def side_y(self, z):
        """Half width of the section at height z."""
        cz = max(-1.0, min(1.0, (z - self.zc) / self.hh))
        cy = max(0.0, 1.0 - abs(cz) ** self.p) ** (1.0 / self.p)
        return cy * self.w(cz)


def newell(pts):
    n = Vector((0, 0, 0))
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        n.x += (a.y - b.y) * (a.z + b.z)
        n.y += (a.z - b.z) * (a.x + b.x)
        n.z += (a.x - b.x) * (a.y + b.y)
    return n.normalized() if n.length > 1e-12 else Vector((0, 0, 1))


def loft(mb, stations, m, matfn):
    """Skin the stations (sorted by x) with quads and cap both ends.
    matfn(centre, normal) picks each face's material."""
    rings = [st.ring(m) for st in stations]
    verts = [p for r in rings for p in r]
    n = len(rings)
    faces = []
    for i in range(n - 1):
        for k in range(m):
            faces.append((i * m + k, i * m + (k + 1) % m, (i + 1) * m + (k + 1) % m, (i + 1) * m + k))
    faces.append(tuple(reversed(range(m))))          # rear cap, normal -X
    faces.append(tuple(range((n - 1) * m, n * m)))   # front cap, normal +X
    mats = []
    for f in faces:
        pts = [verts[j] for j in f]
        c = sum(pts, Vector()) / len(pts)
        mats.append(matfn(c, newell(pts)))
    mb.add(verts, faces, mats, smooth=True)


def strip(mb, pts_a, pts_b, m, smooth=True):
    """Quad strip between two point rows; winding a->b across, rows along."""
    n = len(pts_a)
    verts = list(pts_a) + list(pts_b)
    faces = [(i, i + 1, n + i + 1, n + i) for i in range(n - 1)]
    mb.add(verts, faces, m, smooth)


def top_strip(mb, st_at, x0, x1, y0, y1, m, lift=0.02, n=8):
    """Decal strip lying on a loft's upper surface (y0 < y1)."""
    xs = [x0 + (x1 - x0) * i / (n - 1) for i in range(n)]
    a, b = [], []
    for x in xs:
        st = st_at(x)
        a.append(Vector((x, y0, st.top_z(y0) + lift)))
        b.append(Vector((x, y1, st.top_z(y1) + lift)))
    # rows along +X, across +Y: normal = X x Y = +Z
    strip(mb, a, b, m)


def side_strip(mb, st_at, x0, x1, dz0, dz1, m, lift=0.02, n=10):
    """Decal band on both sides at heights zt+dz0 .. zt+dz1 (dz < 0)."""
    xs = [x0 + (x1 - x0) * i / (n - 1) for i in range(n)]
    for s in (1, -1):
        lo, hi = [], []
        for x in xs:
            st = st_at(x)
            for z, row in ((st.zt + dz0, lo), (st.zt + dz1, hi)):
                row.append(Vector((x, s * (st.side_y(z) + lift), z)))
        if s > 0:   # left side faces +Y: rows along +X then up: X x Z = -Y, so swap
            strip(mb, hi, lo, m)
        else:
            strip(mb, lo, hi, m)


def fender(mb, wx, wz, r_in, r_out, y0, y1, m, a0=0.0, a1=180.0, segs=9, smooth=True):
    """Arc band over a wheel: angles measured from +X going over the top."""
    verts, faces = [], []
    for j in range(segs + 1):
        a = math.radians(a0 + (a1 - a0) * j / segs)
        for r, y in ((r_in, y0), (r_out, y0), (r_out, y1), (r_in, y1)):
            verts.append((wx + r * math.cos(a), y, wz + r * math.sin(a)))
    for j in range(segs):
        for q in range(4):
            a, b = j * 4 + q, j * 4 + (q + 1) % 4
            faces.append((a, b, b + 4, a + 4))
    faces.append((0, 1, 2, 3))
    faces.append(tuple(segs * 4 + q for q in (3, 2, 1, 0)))
    mb.add(verts, faces, m, smooth, recalc=True)


def rotated_box(mb, centre, half, m, pitch=0.0, yaw=0.0, roll=0.0, bevel=0.0):
    rot = (Matrix.Rotation(math.radians(yaw), 4, "Z") @ Matrix.Rotation(math.radians(pitch), 4, "Y")
           @ Matrix.Rotation(math.radians(roll), 4, "X"))
    mb.obox(centre, half, m, matrix=rot, bevel=bevel)


# --------------------------------------------------------------------------
# Wheels
# --------------------------------------------------------------------------
def wheel(name, parent, loc, spec, side, M):
    """Chunky tyre with chevron lugs and a spoked rim; outer face on side*Y."""
    R, hw, rr, n_spokes = spec["R"], spec["hw"], spec["rim"], spec["spokes"]
    segs, lug = 20, 0.035
    mb = MeshBuilder()
    # tyre: closed lathe profile (r, y) going around the tyre's cross-section
    prof = [(rr, -hw * 0.82), (R - 0.1, -hw), (R - 0.03, -hw * 0.94), (R, -hw * 0.6), (R, 0.0),
            (R, hw * 0.6), (R - 0.03, hw * 0.94), (R - 0.1, hw), (rr, hw * 0.82)]
    verts, faces = [], []
    np_ = len(prof)
    for j in range(segs):
        phi = 2 * math.pi * j / segs
        for i, (r, y) in enumerate(prof):
            if i in (3, 5):
                r = r if j % 2 == 0 else r - lug        # shoulder lugs
            elif i == 4:
                r = r - lug * 0.3 if j % 2 == 0 else r - lug * 0.7   # centre rib, offset
            verts.append((r * math.sin(phi), side * y, -r * math.cos(phi)))
    for j in range(segs):
        j2 = (j + 1) % segs
        for i in range(np_):
            i2 = (i + 1) % np_
            faces.append((j * np_ + i, j * np_ + i2, j2 * np_ + i2, j2 * np_ + i))
    mb.add(verts, faces, M["tire"], smooth=True, recalc=True)

    rseg = 12
    # rim lip
    lip = [(rr + 0.012, hw * 0.78), (rr + 0.012, hw * 0.9), (rr - 0.04, hw * 0.9), (rr - 0.04, hw * 0.74)]
    verts, faces = [], []
    for j in range(rseg):
        phi = 2 * math.pi * j / rseg
        for r, y in lip:
            verts.append((r * math.sin(phi), side * y, -r * math.cos(phi)))
    for j in range(rseg):
        j2 = (j + 1) % rseg
        for i in range(4):
            i2 = (i + 1) % 4
            faces.append((j * 4 + i, j * 4 + i2, j2 * 4 + i2, j2 * 4 + i))
    mb.add(verts, faces, M["rim"], smooth=True, recalc=True)
    # dark dish behind the spokes, hub, spokes
    mb.cyl((0, side * hw * 0.2, 0), (0, side * hw * 0.34, 0), rr - 0.01, M["tire"], segs=rseg)
    mb.cyl((0, side * hw * 0.3, 0), (0, side * hw * 0.98, 0), 0.085, M["rim"], segs=10, r2=0.06)
    span = rr - 0.03 - 0.06
    for k in range(n_spokes):
        a = 2 * math.pi * k / n_spokes
        rot = Matrix.Rotation(-a, 4, "Y")
        centre = rot @ Vector((0.06 + span / 2, side * hw * 0.62, 0))
        mb.obox(centre, (span / 2, hw * 0.2, 0.038), M["rim"], matrix=rot)
    return mb.finish(name, parent, sharp_angle=40, loc=loc)


# --------------------------------------------------------------------------
# Car body
# --------------------------------------------------------------------------
def tub_stations(spec):
    w = spec["wheels"]
    R = w["R"]
    wz = GROUND + R
    ra = R + spec.get("arch_gap", 0.07)
    arches = [(w["xf"], spec.get("arch_front", True)), (w["xr"], spec.get("arch_rear", True))]
    xs = set()
    n = int((spec["x1"] - spec["x0"]) / 0.13)
    for i in range(n + 1):
        xs.add(round(spec["x0"] + (spec["x1"] - spec["x0"]) * i / n, 4))
    for wx, on in arches:
        if on:
            for a in range(0, 181, 20):
                xs.add(round(wx + ra * math.cos(math.radians(a)), 4))
    xs = sorted(x for x in xs if spec["x0"] <= x <= spec["x1"])
    pruned = [xs[0]]
    for x in xs[1:]:
        if x - pruned[-1] > 0.035:
            pruned.append(x)
    if pruned[-1] != xs[-1]:
        pruned[-1] = xs[-1]

    def at(x):
        hw = interp(spec["hw"], x)
        zt = interp(spec["zt"], x)
        zb = interp(spec["zb"], x)
        for wx, on in arches:
            dx = x - wx
            if on and abs(dx) < ra:
                zb = max(zb, wz + math.sqrt(ra * ra - dx * dx))
        zb = min(zb, zt - 0.12)
        return Station(x, hw, hw * spec["top_ratio"], zb, zt, spec["p"])
    return [at(x) for x in pruned], at


def cabin_stations(spec, tub_at):
    c = spec["cabin"]
    x0, x1 = c["keys"][0][0], c["keys"][-1][0]
    n = c["n"]
    sts = []
    for i in range(n):
        x = x0 + (x1 - x0) * i / (n - 1)
        hw = tub_at(x).wb
        sts.append(Station(x, hw * c["wb"], hw * c["wt"], c["zb"], interp(c["keys"], x), c["p"]))

    def at(x):
        hw = tub_at(x).wb
        return Station(x, hw * c["wb"], hw * c["wt"], c["zb"], interp(c["keys"], x), c["p"])
    return sts, at


def build_body(spec, root, M):
    mb = MeshBuilder()
    sts, tub_at = tub_stations(spec)
    skirt = spec.get("skirt_z", -0.3)

    def tub_mat(c, n):
        if n.z < -0.55:
            return M["trim"]
        if c.z < skirt and abs(n.y) > 0.45:
            return M["trim"]
        return M["paint"]
    loft(mb, sts, 20, tub_mat)

    # cabin: glass greenhouse with painted roof and pillars
    c = spec["cabin"]
    csts, cab_at = cabin_stations(spec, tub_at)
    canopy = c.get("canopy", False)

    def cab_mat(ctr, n):
        belt = tub_at(ctr.x).zt
        if ctr.z < belt + 0.04 or n.z < -0.3:
            return M["paint"]
        if not canopy:
            if n.z > 0.78:
                return M["paint"]
            for px in c.get("pillars", []):
                if abs(ctr.x - px) < 0.07 and abs(n.y) > 0.35:
                    return M["paint"]
            if abs(n.y) > 0.3 and abs(n.x) > 0.4:
                return M["paint"]
        return M["glass"]
    loft(mb, csts, 18, cab_mat)
    # dark interior seen through the glass
    inner = [Station(s.x, s.wb * 0.86, s.wt * 0.86, s.zb, max(s.zb + 0.05, s.zt - 0.07), s.p) for s in csts[1:-1]]
    loft(mb, inner, 10, lambda ctr, n: M["trim"])

    # chassis block under the body: fills the wheel wells, dark
    w = spec["wheels"]
    mb.box((spec["x0"] + 0.22, -(w["y"] - w["hw"] - 0.05), -0.62),
           (spec.get("chassis_x1", spec["x1"] - 0.22), w["y"] - w["hw"] - 0.05, spec.get("chassis_top", 0.05)), M["trim"])

    # arch flares
    R = w["R"]
    wz = GROUND + R
    ra = R + spec.get("arch_gap", 0.07)
    for wx, on in ((w["xf"], spec.get("arch_front", True)), (w["xr"], spec.get("arch_rear", True))):
        if not on:
            continue
        hw = tub_at(wx).wb
        for s in (1, -1):
            y0, y1 = hw - 0.1, hw + spec.get("flare", 0.05)
            fender(mb, wx, wz, ra - 0.01, ra + 0.07, *(sorted((s * y0, s * y1))), M[spec.get("flare_mat", "trim")],
                   a0=-8, a1=188, segs=10)

    spec["extras"](mb, M, tub_at, cab_at)
    ob = mb.finish("body", root, sharp_angle=38)
    return ob


# --------------------------------------------------------------------------
# The three designs
# --------------------------------------------------------------------------
def comet_extras(mb, M, tub_at, cab_at):
    """Octane-like: round headlights, twin stripes, hatch spoiler."""
    # front: bumper, grille, round headlights
    mb.obox((1.8, 0, -0.44), (0.09, 0.9, 0.09), M["trim"], bevel=0.035)
    mb.obox((1.84, 0, -0.2), (0.03, 0.36, 0.07), M["trim"], bevel=0.015)
    for y in (-0.1, 0.0, 0.1):
        mb.box((1.865, y - 0.012, -0.25), (1.875, y + 0.012, -0.15), M["accent"])
    for s in (1, -1):
        mb.cyl((1.81, s * 0.6, -0.13), (1.875, s * 0.6, -0.13), 0.1, M["head"], segs=12)
        mb.cyl((1.79, s * 0.6, -0.13), (1.86, s * 0.6, -0.13), 0.125, M["trim"], segs=12)
    # rear: bumper, tail lights, exhausts
    mb.obox((-1.8, 0, -0.42), (0.08, 0.88, 0.1), M["trim"], bevel=0.035)
    for s in (1, -1):
        mb.obox((-1.83, s * 0.6, 0.04), (0.03, 0.17, 0.06), M["tail"], bevel=0.015)
        mb.cyl((-1.93, s * 0.2, -0.3), (-1.78, s * 0.2, -0.3), 0.065, M["trim"], segs=10)
        mb.cyl((-1.935, s * 0.2, -0.3), (-1.925, s * 0.2, -0.3), 0.045, M["accent"], segs=10)
    # stripes: hood, roof, beltline
    for s in (1, -1):
        y0, y1 = sorted((s * 0.08, s * 0.2))
        top_strip(mb, tub_at, 0.55, 1.78, y0, y1, M["accent"])
        top_strip(mb, cab_at, -1.4, -0.1, y0, y1, M["accent"], lift=0.015)
    side_strip(mb, tub_at, -1.55, 1.55, -0.13, -0.07, M["accent"])
    # hatch spoiler
    rotated_box(mb, (-1.56, 0, 0.8), (0.17, 0.78, 0.025), M["paint"], pitch=10, bevel=0.012)
    for s in (1, -1):
        mb.obox((-1.55, s * 0.77, 0.77), (0.15, 0.02, 0.06), M["trim"])


def stinger_extras(mb, M, tub_at, cab_at):
    """Breakout-like: long nose, front fender pods, big rear wing."""
    w = STINGER["wheels"]
    wz = GROUND + w["R"]
    for s in (1, -1):
        y0, y1 = sorted((s * 0.66, s * 1.19))
        fender(mb, w["xf"], wz, w["R"] + 0.05, w["R"] + 0.11, y0, y1, M["paint"], a0=-10, a1=175, segs=10)
        y0, y1 = sorted((s * 0.62, s * 0.7))
        fender(mb, w["xf"], wz, w["R"] + 0.05, w["R"] + 0.11, y0, y1, M["trim"], a0=-10, a1=175, segs=10)
    # splitter and diffuser
    mb.obox((1.78, 0, -0.53), (0.2, 0.55, 0.03), M["trim"])
    mb.obox((-1.8, 0, -0.42), (0.08, 0.82, 0.09), M["trim"], bevel=0.03)
    # headlights: slits lying on the nose
    for s in (1, -1):
        y0, y1 = sorted((s * 0.2, s * 0.42))
        top_strip(mb, tub_at, 1.42, 1.72, y0, y1, M["head"], lift=0.018, n=4)
        mb.obox((-1.855, s * 0.5, -0.03), (0.025, 0.24, 0.035), M["tail"])
        mb.obox((0.45, s * 0.93, -0.18), (0.1, 0.1, 0.1), M["trim"], bevel=0.03)     # side intakes
        mb.cyl((-1.93, s * 0.16, -0.26), (-1.78, s * 0.16, -0.26), 0.06, M["trim"], segs=10)
        mb.cyl((-1.935, s * 0.16, -0.26), (-1.925, s * 0.16, -0.26), 0.04, M["accent"], segs=10)
    # accent: wide centre stripe on the nose and the deck
    top_strip(mb, tub_at, 0.72, 1.9, -0.12, 0.12, M["accent"])
    top_strip(mb, tub_at, -1.75, -1.0, -0.12, 0.12, M["accent"])
    side_strip(mb, tub_at, -1.6, 0.3, -0.12, -0.07, M["accent"])
    # rear wing
    for s in (1, -1):
        rotated_box(mb, (-1.62, s * 0.5, 0.4), (0.09, 0.03, 0.2), M["trim"], pitch=-12)
        mb.obox((-1.68, s * 1.03, 0.6), (0.3, 0.025, 0.13), M["trim"], bevel=0.015)
    rotated_box(mb, (-1.68, 0, 0.64), (0.26, 1.0, 0.035), M["paint"], pitch=8, bevel=0.015)
    rotated_box(mb, (-1.92, 0, 0.68), (0.03, 1.0, 0.03), M["accent"], pitch=8)


def bulldog_extras(mb, M, tub_at, cab_at):
    """Merc-like: boxy van, bull bar, roof light bar."""
    # bumpers and grille
    mb.obox((1.8, 0, -0.42), (0.1, 1.0, 0.12), M["trim"], bevel=0.04)
    mb.obox((-1.83, 0, -0.42), (0.1, 1.0, 0.12), M["trim"], bevel=0.04)
    mb.obox((1.815, 0, -0.06), (0.03, 0.5, 0.16), M["trim"], bevel=0.015)
    for z in (-0.14, -0.06, 0.02):
        mb.box((1.84, -0.46, z - 0.018), (1.85, 0.46, z + 0.018), M["accent"])
    for s in (1, -1):
        mb.obox((1.83, s * 0.76, -0.04), (0.03, 0.15, 0.09), M["head"], bevel=0.01)
        mb.obox((1.82, s * 0.76, -0.04), (0.03, 0.19, 0.12), M["trim"], bevel=0.01)
        mb.obox((-1.87, s * 0.82, 0.02), (0.03, 0.09, 0.17), M["tail"], bevel=0.01)
        # bull bar uprights and mounts
        mb.cyl((1.95, s * 0.52, -0.5), (1.95, s * 0.52, 0.14), 0.045, M["accent"], segs=8)
        mb.cyl((1.86, s * 0.52, -0.3), (1.95, s * 0.52, -0.3), 0.04, M["accent"], segs=8)
        # side steps between the arches
        mb.obox((0.0, s * 1.07, -0.47), (0.5, 0.06, 0.04), M["trim"])
        # roof rails
        mb.obox((-0.6, s * 0.74, 0.8), (0.95, 0.03, 0.03), M["trim"])
        mb.cyl((-1.93, s * 0.3, -0.36), (-1.8, s * 0.3, -0.36), 0.07, M["trim"], segs=10)
        mb.cyl((-1.935, s * 0.3, -0.36), (-1.925, s * 0.3, -0.36), 0.05, M["accent"], segs=10)
    mb.cyl((1.95, -0.6, 0.14), (1.95, 0.6, 0.14), 0.045, M["accent"], segs=8)
    mb.cyl((1.95, -0.6, -0.2), (1.95, 0.6, -0.2), 0.04, M["accent"], segs=8)
    # roof light bar
    mb.obox((0.32, 0, 0.84), (0.1, 0.72, 0.05), M["trim"], bevel=0.02)
    for y in (-0.54, -0.18, 0.18, 0.54):
        mb.obox((0.42, y, 0.84), (0.012, 0.13, 0.035), M["head"])
    # stripes: twin hood stripes, a fat beltline band
    for s in (1, -1):
        y0, y1 = sorted((s * 0.12, s * 0.28))
        top_strip(mb, tub_at, 1.05, 1.8, y0, y1, M["accent"], n=5)
    side_strip(mb, tub_at, -1.7, 1.7, -0.16, -0.06, M["accent"])


COMET = dict(
    name="car_comet", x0=-1.82, x1=1.85, p=3.0, top_ratio=0.9,
    hw=[(-1.82, 0.88), (-1.7, 0.98), (-1.5, 1.02), (1.45, 1.02), (1.7, 0.96), (1.85, 0.86)],
    zt=[(-1.82, 0.2), (-1.7, 0.36), (-1.55, 0.4), (0.4, 0.36), (1.1, 0.28), (1.5, 0.2), (1.72, 0.1), (1.85, -0.02)],
    zb=[(-1.82, -0.32), (-1.7, -0.48), (-1.5, -0.52), (1.5, -0.52), (1.7, -0.48), (1.85, -0.34)],
    wheels=dict(xf=1.15, xr=-1.15, y=0.95, R=0.46, hw=0.2, rim=0.29, spokes=5),
    cabin=dict(keys=[(-1.62, 0.3), (-1.55, 0.6), (-1.42, 0.76), (-0.4, 0.82), (-0.05, 0.78), (0.6, 0.3)],
               zb=0.1, wb=0.9, wt=0.72, p=3.0, n=14, pillars=[-0.62]),
    extras=comet_extras,
)

STINGER = dict(
    name="car_stinger", x0=-1.85, x1=1.95, p=3.5, top_ratio=0.85, skirt_z=-0.32,
    hw=[(-1.85, 0.9), (-1.72, 1.0), (-1.5, 1.03), (0.3, 1.0), (0.7, 0.77), (1.7, 0.64), (1.95, 0.42)],
    zt=[(-1.85, 0.08), (-1.72, 0.2), (-1.5, 0.24), (-0.6, 0.18), (0.4, 0.02), (1.2, -0.12), (1.95, -0.32)],
    zb=[(-1.85, -0.3), (-1.72, -0.48), (-1.5, -0.52), (1.6, -0.52), (1.95, -0.46)],
    wheels=dict(xf=1.22, xr=-1.2, y=0.97, R=0.44, hw=0.19, rim=0.27, spokes=6),
    arch_front=False, arch_gap=0.07, chassis_top=-0.3, chassis_x1=0.7,
    cabin=dict(keys=[(-1.0, 0.1), (-0.85, 0.3), (-0.55, 0.45), (-0.15, 0.46), (0.2, 0.36), (0.68, 0.04)],
               zb=-0.05, wb=0.74, wt=0.5, p=2.6, n=14, canopy=True),
    extras=stinger_extras,
)

BULLDOG = dict(
    name="car_bulldog", x0=-1.85, x1=1.82, p=5.0, top_ratio=0.96, skirt_z=-0.25,
    hw=[(-1.85, 0.98), (-1.76, 1.06), (1.7, 1.06), (1.82, 0.98)],
    zt=[(-1.85, 0.24), (-1.76, 0.34), (0.8, 0.36), (1.68, 0.32), (1.82, 0.2)],
    zb=[(-1.85, -0.36), (-1.76, -0.5), (1.7, -0.5), (1.82, -0.38)],
    wheels=dict(xf=1.12, xr=-1.12, y=0.95, R=0.5, hw=0.22, rim=0.3, spokes=5),
    arch_gap=0.07, flare=0.07,
    cabin=dict(keys=[(-1.8, 0.28), (-1.74, 0.68), (-1.6, 0.78), (0.45, 0.78), (0.6, 0.74), (1.02, 0.34)],
               zb=0.15, wb=0.97, wt=0.88, p=5.0, n=16, pillars=[-0.45, -1.15]),
    extras=bulldog_extras,
)

CARS = [COMET, STINGER, BULLDOG]


# --------------------------------------------------------------------------
# Build / export
# --------------------------------------------------------------------------
def build():
    common.use_collection("Cars")
    M = materials()
    roots = []
    for i, spec in enumerate(CARS):
        r = common.root(spec["name"], (0, (i - 1) * SPACING, 0), car_id=i)
        build_body(spec, r, M)
        w = spec["wheels"]
        wz = GROUND + w["R"]
        for tag, x, s in (("fl", w["xf"], 1), ("fr", w["xf"], -1), ("rl", w["xr"], 1), ("rr", w["xr"], -1)):
            wheel("wheel_" + tag, r, (x, s * w["y"], wz), w, s, M)
        common.marker("exhaust", r, (-1.8, 0, -0.2))
        roots.append(r)
    return roots


def export(roots=None):
    if roots is None:
        roots = [bpy.data.objects[s["name"]] for s in CARS]
    path, _ = common.export_glb("cars.glb", roots, bpy.data.collections["Cars"])
    return path, common.strip_name_suffixes(path)


def render_previews():
    coll = bpy.data.collections["Cars"]
    out = []
    for tag, cam in (("cars_front", (7.5, -8.5, 3.6)), ("cars_rear", (-8.0, -7.5, 3.2))):
        out.append(common.preview(os.path.join(common.RENDERS, tag + ".png"), [coll], cam, (0, 0, -0.3),
                                  lens=40, sun_rot=(45, 10, 35), world=(0.35, 0.38, 0.45)))
    return out


if __name__ == "__main__":
    build()
    export()
