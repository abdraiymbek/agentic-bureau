# Omen Flow STEP converter: an OpenSCAD CSG tree rebuilt as an exact B-rep with OpenCASCADE.
# Copyright 2026 Omen Flow contributors. Licensed under the Apache License, Version 2.0.
# SPDX-License-Identifier: Apache-2.0
#
# The Omen Flow core writes this file to a private temporary folder and runs
#     <python> -E csg_to_step.py request.json
# It needs only the Python standard library and OCP, the OpenCASCADE bindings CadQuery uses
# (`pip install cadquery-ocp-novtk==7.9.3.1.1`, Python 3.11 to 3.14). OpenCASCADE is not part
# of Omen Flow.
#
# request.json: {"protocol": 1, "csg": path, "step": path, "answer": path, "product": name,
#                "samples": [[x, y, z], ...],
#                "probes": {"offsets": [mm, ...], "trusted": mm, "margin": mm, "pairs", "maxPairs",
#                           "perFace", "tries"}}
# The samples are points the core has classified against its render: points spread through
# the bounding box, and pairs just inside and just outside the render's faces. The probes say
# how to place such pairs on the exact solid's own faces, for the core to classify against
# its render in turn.
# The one answer is written to "answer" (and printed as the last line of this script's own
# output; OpenCASCADE prints to the same stream):
#   {"protocol": 1, "ok": true, "ocp", "python", "volume", "bboxMin", "bboxMax", "solids",
#    "faces", "valid", "openShells", "freeEdges", "unmeshedFaces",
#    "inside": "0120..." (per sample: 1 inside, 0 outside, 2 on the surface),
#    "solidProbes": [[inner x, y, z, outer x, y, z, face], ...], "solidFaces", "solidUnprobed",
#    "solidSlivers", "bytes",
#    "approximations": [...], "interpretations": [{"kind", "facets", "count"}], "seconds"},
#   measured on the STEP file as read back, or
#   {"protocol": 1, "ok": false, "stage": "import|parse|build|write|check", "reason", ...}.
# The core compares the answer with the render it checked and decides whether the STEP is
# used; nothing here decides that.
from __future__ import annotations

import ast
import bisect
import json
import math
import sys
import time

PROTOCOL = 1
STARTED = time.time()
ANSWER_PATH = None
APPROXIMATIONS: list[str] = []
# Curved primitives OpenSCAD rendered with few facets that are rebuilt here as true circles,
# spheres or revolutions: (kind, facets) -> count. The core reports them.
INTERPRETED: dict = {}


def answer(fields: dict) -> None:
    """The one answer: written to the request's answer file, then printed as a single line.

    OpenCASCADE prints its own messages to the same stdout from C++, possibly after this line,
    so the core reads the file."""
    fields = {"protocol": PROTOCOL, **fields, "seconds": round(time.time() - STARTED, 3)}
    text = json.dumps(fields)
    if ANSWER_PATH:
        with open(ANSWER_PATH + ".tmp", "w") as out:
            out.write(text)
        import os

        os.replace(ANSWER_PATH + ".tmp", ANSWER_PATH)
    sys.stdout.write(text + "\n")
    sys.stdout.flush()


try:
    ANSWER_PATH = json.load(open(sys.argv[1])).get("answer")
except Exception:
    ANSWER_PATH = None


try:
    import OCP
    from OCP.BRep import BRep_Builder, BRep_Tool
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepBuilderAPI import (
        BRepBuilderAPI_GTransform,
        BRepBuilderAPI_MakeEdge,
        BRepBuilderAPI_MakeFace,
        BRepBuilderAPI_MakePolygon,
        BRepBuilderAPI_MakeSolid,
        BRepBuilderAPI_MakeVertex,
        BRepBuilderAPI_MakeWire,
        BRepBuilderAPI_Sewing,
        BRepBuilderAPI_Transform,
    )
    from OCP.BRepCheck import BRepCheck_Analyzer, BRepCheck_NoError, BRepCheck_Shell
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.BRepGProp import BRepGProp, BRepGProp_Face
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRepOffsetAPI import BRepOffsetAPI_MakeOffset, BRepOffsetAPI_ThruSections
    from OCP.BRepPrimAPI import (
        BRepPrimAPI_MakeBox,
        BRepPrimAPI_MakeCone,
        BRepPrimAPI_MakeCylinder,
        BRepPrimAPI_MakePrism,
        BRepPrimAPI_MakeRevol,
        BRepPrimAPI_MakeSphere,
    )
    from OCP.Bnd import Bnd_Box
    from OCP.GeomAbs import GeomAbs_Arc, GeomAbs_Intersection
    from OCP.GProp import GProp_GProps
    from OCP.gp import gp_Ax1, gp_Ax2, gp_Circ, gp_Dir, gp_GTrsf, gp_Mat, gp_Pnt, gp_Trsf, gp_Vec, gp_XYZ
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.ShapeFix import ShapeFix_Solid
    from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Reader, STEPControl_Writer
    from OCP.Interface import Interface_Static
    from OCP.ShapeAnalysis import ShapeAnalysis_FreeBounds
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_IN, TopAbs_ON, TopAbs_REVERSED, TopAbs_SHELL, TopAbs_SOLID, TopAbs_WIRE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS, TopoDS_Compound
except Exception as error:  # no OCP in this Python: the core falls back to a faceted STEP
    answer({"ok": False, "stage": "import", "reason": f"{type(error).__name__}: {error}"[:300], "python": sys.version.split()[0]})
    sys.exit(0)

OCP_VERSION = getattr(OCP, "__version__", "unknown")


def _downcast(name: str):
    # OCP before 7.8 names the downcasts Face_s, Shell_s, ...; later versions Face, Shell, ...
    return getattr(TopoDS, name + "_s", None) or getattr(TopoDS, name)


as_face, as_shell, as_wire = _downcast("Face"), _downcast("Shell"), _downcast("Wire")


class Unsupported(Exception):
    pass


# ---------------------------------------------------------------- CSG parser


def parse(text: str) -> list[dict]:
    pos = 0

    def skip() -> None:
        nonlocal pos
        while pos < len(text) and text[pos].isspace():
            pos += 1

    def statements(until: str | None) -> list[dict]:
        nonlocal pos
        nodes = []
        while True:
            skip()
            if pos >= len(text):
                return nodes
            if until and text[pos] == until:
                pos += 1
                return nodes
            if text[pos] == ";":
                pos += 1
                continue
            nodes.append(statement())

    def statement() -> dict:
        nonlocal pos
        start = pos
        while pos < len(text) and (text[pos].isalnum() or text[pos] in "_$"):
            pos += 1
        name = text[start:pos]
        skip()
        if pos >= len(text) or text[pos] != "(":
            raise Unsupported(f"unreadable CSG near character {pos}")
        depth, i, in_str = 0, pos, False
        while True:
            if i >= len(text):
                raise Unsupported("unterminated argument list in CSG")
            c = text[i]
            if in_str:
                if c == "\\":
                    i += 1
                elif c == '"':
                    in_str = False
            elif c == '"':
                in_str = True
            elif c in "([":
                depth += 1
            elif c in ")]":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        args = arguments(text[pos + 1 : i])
        pos = i + 1
        skip()
        children: list[dict] = []
        if pos < len(text) and text[pos] == "{":
            pos += 1
            children = statements("}")
        elif pos < len(text) and text[pos] == ";":
            pos += 1
        return {"name": name, "args": args, "children": children}

    return statements(None)


def arguments(raw: str) -> dict:
    parts, depth, current, in_str = [], 0, "", False
    for c in raw:
        if in_str:
            current += c
            if c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        if c == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += c
    if current.strip():
        parts.append(current)
    args: dict = {}
    for index, part in enumerate(parts):
        key, value = part.split("=", 1) if "=" in part.split("[")[0].split('"')[0] else (str(index), part)
        value = value.strip().replace("true", "True").replace("false", "False").replace("undef", "None")
        try:
            args[key.strip()] = ast.literal_eval(value)
        except (ValueError, SyntaxError):
            args[key.strip()] = value
    return args


# ---------------------------------------------------------------- small linear algebra

IDENTITY = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]


def matrix(value) -> list[list[float]]:
    rows = [[float(x) for x in row] for row in value]
    if len(rows) == 3:
        rows.append([0.0, 0.0, 0.0, 1.0])
    if len(rows) != 4 or any(len(row) != 4 for row in rows):
        raise Unsupported("multmatrix is not 4x4")
    return rows


def matmul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def close(a, b, tol=1e-9) -> bool:
    return all(abs(x - y) <= tol * (1 + abs(y)) for ra, rb in zip(a, b) for x, y in zip(ra, rb))


def det3(m) -> float:
    return (
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    )


def rotation_part(m):
    return [row[:3] for row in m[:3]]


# ---------------------------------------------------------------- geometry helpers


def compound(shapes):
    result = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(result)
    for shape in shapes:
        builder.Add(result, shape)
    return result


def fuse(shapes):
    shapes = [s for s in shapes if s is not None]
    if not shapes:
        return None
    result = shapes[0]
    for shape in shapes[1:]:
        op = BRepAlgoAPI_Fuse(result, shape)
        if not op.IsDone():
            raise Unsupported("fuse failed")
        result = op.Shape()
    return result


def region(shapes):
    """A 2D outline as one region: a 2D boolean leaves coplanar pieces split along its
    intersection edges, which a sweep would make into solids that touch."""
    base = fuse(shapes)
    if base is None:
        return None
    merged = ShapeUpgrade_UnifySameDomain(base, True, True, True)
    merged.Build()
    return merged.Shape()


def fragments(r: float, args: dict) -> int:
    """How many facets OpenSCAD gives a circle of radius r (its get_fragments_from_r)."""
    fn, fs, fa = float(args.get("$fn") or 0), float(args.get("$fs") or 2), float(args.get("$fa") or 12)
    if r < 0.00000095367431640625:
        return 3
    if fn > 0:
        return int(fn) if fn >= 3 else 3
    return int(math.ceil(max(min(360.0 / fa, r * 2 * math.pi / fs), 5)))


def polygonal(args: dict, r: float) -> int | None:
    """The polygon count when OpenSCAD's faceting is clearly intended (a hexagon nut, a square peg)."""
    n = fragments(r, args)
    return n if 3 <= n <= 8 else None


def interpreted(kind: str, n: int) -> None:
    """A primitive OpenSCAD rendered with n facets, rebuilt here as an exact surface."""
    if n < 32:
        INTERPRETED[(kind, n)] = INTERPRETED.get((kind, n), 0) + 1


def polygon_face(points, z: float = 0.0):
    poly = BRepBuilderAPI_MakePolygon()
    for x, y in points:
        poly.Add(gp_Pnt(float(x), float(y), z))
    poly.Close()
    face = BRepBuilderAPI_MakeFace(poly.Wire(), True)
    if not face.IsDone():
        raise Unsupported("polygon face")
    return face.Face()


def polygon_face_3d(points):
    poly = BRepBuilderAPI_MakePolygon()
    for p in points:
        poly.Add(gp_Pnt(*map(float, p)))
    poly.Close()
    return BRepBuilderAPI_MakeFace(poly.Wire(), True).Face()


def circle_face(r: float, cx: float = 0.0, cy: float = 0.0):
    edge = BRepBuilderAPI_MakeEdge(gp_Circ(gp_Ax2(gp_Pnt(cx, cy, 0), gp_Dir(0, 0, 1)), r)).Edge()
    wire = BRepBuilderAPI_MakeWire(edge).Wire()
    return BRepBuilderAPI_MakeFace(wire, True).Face()


def ngon(n: int, r: float, cx: float = 0.0, cy: float = 0.0):
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]


def convex_hull_2d(points):
    """Andrew's monotone chain; counter-clockwise, no repeated or collinear points."""
    pts = sorted(set((round(x, 9), round(y, 9)) for x, y in points))
    if len(pts) < 3:
        return pts

    def turn(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and turn(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and turn(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def disc_hull(discs):
    """Exact 2D convex hull of discs (cx, cy, r) of any radii: arcs joined by common tangents."""
    discs = sorted(set((round(float(x), 9), round(float(y), 9), round(float(r), 9)) for x, y, r in discs))
    # A disc inside another adds nothing.
    discs = [d for d in discs if not any(o != d and math.dist(d[:2], o[:2]) + d[2] <= o[2] + 1e-9 for o in discs)]
    if len(discs) == 1:
        return circle_face(discs[0][2], discs[0][0], discs[0][1])
    tol = 1e-9 * (1 + max(abs(v) for d in discs for v in d))
    support = lambda d, n: d[0] * n[0] + d[1] * n[1] + d[2]
    turns = []  # (angle, from disc, to disc): the support passes from one disc to the next here
    for i, a in enumerate(discs):
        for j, b in enumerate(discs):
            if i == j:
                continue
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dy)
            if length < 1e-12 or abs(a[2] - b[2]) > length:
                continue
            phi = math.atan2(dy, dx)
            for sign in (1.0, -1.0):
                theta = phi + sign * math.acos(max(-1.0, min(1.0, (a[2] - b[2]) / length)))
                n = (math.cos(theta), math.sin(theta))
                h = support(a, n)
                if all(support(d, n) <= h + tol for d in discs):
                    t = (-n[1], n[0])
                    pa = (a[0] + a[2] * n[0], a[1] + a[2] * n[1])
                    pb = (b[0] + b[2] * n[0], b[1] + b[2] * n[1])
                    if pa[0] * t[0] + pa[1] * t[1] < pb[0] * t[0] + pb[1] * t[1]:
                        turns.append((theta % (2 * math.pi), i, j))
    # Several discs on one tangent line: the line runs from the first to the last of them.
    grouped: dict = {}
    for th, i, j in turns:
        grouped.setdefault(round(th, 10), set()).update((i, j))
    turns = []
    for th, members in sorted(grouped.items()):
        n = (math.cos(th), math.sin(th))
        t = (-n[1], n[0])
        along = sorted(members, key=lambda k: (discs[k][0] + discs[k][2] * n[0]) * t[0] + (discs[k][1] + discs[k][2] * n[1]) * t[1])
        turns.append((th, along[0], along[-1]))
    if len(turns) < 2 or any(turns[k][2] != turns[(k + 1) % len(turns)][1] for k in range(len(turns))):
        raise Unsupported("hull of discs")
    wire = BRepBuilderAPI_MakeWire()
    for k, (theta, i, j) in enumerate(turns):
        a, b = discs[i], discs[j]
        n = (math.cos(theta), math.sin(theta))
        pa = gp_Pnt(a[0] + a[2] * n[0], a[1] + a[2] * n[1], 0)
        pb = gp_Pnt(b[0] + b[2] * n[0], b[1] + b[2] * n[1], 0)
        if pa.Distance(pb) > 1e-9:
            wire.Add(BRepBuilderAPI_MakeEdge(pa, pb).Edge())
        following = turns[(k + 1) % len(turns)][0]
        if following <= theta:
            following += 2 * math.pi
        circle = gp_Circ(gp_Ax2(gp_Pnt(b[0], b[1], 0), gp_Dir(0, 0, 1)), b[2])
        if following - theta > 1e-12:
            wire.Add(BRepBuilderAPI_MakeEdge(circle, theta, following).Edge())
    if not wire.IsDone():
        raise Unsupported("hull of discs")
    face = BRepBuilderAPI_MakeFace(wire.Wire(), True)
    if not face.IsDone():
        raise Unsupported("hull of discs")
    return face.Face()


def convex_hull_3d(points, eps):
    """Pure-Python incremental hull: triangles (i, j, k) wound outward."""
    pts = [tuple(p) for p in points]
    if len(pts) < 4:
        raise Unsupported("hull of fewer than four points")
    sub = lambda a, b: (a[0] - b[0], a[1] - b[1], a[2] - b[2])
    cross = lambda a, b: (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
    dot = lambda a, b: a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    i0 = min(range(len(pts)), key=lambda i: pts[i])
    i1 = max(range(len(pts)), key=lambda i: dot(sub(pts[i], pts[i0]), sub(pts[i], pts[i0])))
    line = sub(pts[i1], pts[i0])
    i2 = max(range(len(pts)), key=lambda i: dot(cross(line, sub(pts[i], pts[i0])), cross(line, sub(pts[i], pts[i0]))))
    normal = cross(line, sub(pts[i2], pts[i0]))
    i3 = max(range(len(pts)), key=lambda i: abs(dot(normal, sub(pts[i], pts[i0]))))
    if abs(dot(normal, sub(pts[i3], pts[i0]))) <= eps * math.sqrt(dot(normal, normal)):
        raise Unsupported("flat hull")
    centre = tuple(sum(pts[i][a] for i in (i0, i1, i2, i3)) / 4 for a in range(3))

    def plane(f):
        n = cross(sub(pts[f[1]], pts[f[0]]), sub(pts[f[2]], pts[f[0]]))
        length = math.sqrt(dot(n, n)) or 1.0
        n = (n[0] / length, n[1] / length, n[2] / length)
        return n, dot(n, pts[f[0]])

    faces = []
    for f in ((i0, i1, i2), (i0, i1, i3), (i0, i2, i3), (i1, i2, i3)):
        n, d = plane(f)
        if dot(n, centre) - d > 0:
            f = (f[0], f[2], f[1])
        faces.append((f, *plane(f)))
    order = sorted(set(range(len(pts))) - {i0, i1, i2, i3}, key=lambda i: -dot(sub(pts[i], centre), sub(pts[i], centre)))
    for i in order:
        p = pts[i]
        visible = [f for f in faces if dot(f[1], p) - f[2] > eps]
        if not visible:
            continue
        edges = {(f[0][k], f[0][(k + 1) % 3]) for f in visible for k in range(3)}
        horizon = [(u, v) for u, v in edges if (v, u) not in edges]
        keep = [f for f in faces if f not in visible]
        faces = keep + [((u, v, i), *plane((u, v, i))) for u, v in horizon]
    return [f[0] for f in faces], pts


def volume_of(shape) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    return props.Mass()


def outward(solid):
    """A sweep of a face whose normal points the other way comes out inside out."""
    return solid.Reversed() if volume_of(solid) < 0 else solid


def transform(shape, m):
    if close(m, IDENTITY):
        return shape
    rot = rotation_part(m)
    scale = abs(det3(rot)) ** (1 / 3)
    rrt = [[sum(rot[i][k] * rot[j][k] for k in range(3)) for j in range(3)] for i in range(3)]
    similar = scale > 1e-12 and all(
        abs(rrt[i][j] - (scale * scale if i == j else 0.0)) <= 1e-5 * scale * scale for i in range(3) for j in range(3)
    )
    if similar:
        # Rotation, mirror and uniform scale (OpenSCAD prints matrices to about six digits):
        # gp_Trsf re-orthogonalises them and keeps planes, cylinders and spheres analytic.
        trsf = gp_Trsf()
        trsf.SetValues(*m[0], *m[1], *m[2])
        return BRepBuilderAPI_Transform(shape, trsf, True).Shape()
    gtrsf = gp_GTrsf()
    gtrsf.SetVectorialPart(gp_Mat(*[v for row in rot for v in row]))
    gtrsf.SetTranslationPart(gp_XYZ(m[0][3], m[1][3], m[2][3]))
    op = BRepBuilderAPI_GTransform(shape, gtrsf, True)
    if not op.IsDone():
        raise Unsupported("non-uniform scale")
    result = op.Shape()
    # A non-uniform scale with a mirror leaves solids inside out.
    return result.Reversed() if volume_of(result) < 0 else result


def area(shape) -> float:
    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, props)
    return props.Mass()


# ---------------------------------------------------------------- tree evaluation

TWO_D = {"square", "circle", "polygon", "text", "projection"}
HULLS = {"cylinders": 0, "circles": 0, "general2d": 0, "general3d": 0}


def build(node: dict):
    name, args = node["name"], node["args"]
    built = [build(child) for child in node["children"]]
    kids = [k for k in built if k[1] is not None]
    dim = kids[0][0] if kids else (2 if name in TWO_D else 3)

    if name in ("group", "union", "render", "color", "children"):
        return dim, fuse([k[1] for k in kids])
    if name in ("difference", "intersection"):
        # As OpenSCAD: an empty child (a false if(), cube(0)) is still an operand. A
        # difference from nothing is nothing, and so is an intersection with nothing;
        # an empty cutter cuts nothing.
        if not built or built[0][1] is None:
            return dim, None
        if name == "intersection" and len(kids) < len(built):
            return dim, None
        base = kids[0][1]
        for _, tool in kids[1:]:
            op = (BRepAlgoAPI_Cut if name == "difference" else BRepAlgoAPI_Common)(base, tool)
            if not op.IsDone():
                raise Unsupported(f"{name} failed")
            base = op.Shape()
        return dim, base
    if name == "multmatrix":
        shape = fuse([k[1] for k in kids])
        return dim, transform(shape, matrix(args["0"] if "0" in args else args["m"])) if shape is not None else None
    if name == "cube":
        size = args.get("size", args.get("0", 1))
        x, y, z = (size, size, size) if isinstance(size, (int, float)) else size
        if min(x, y, z) <= 0:
            return 3, None
        o = (-x / 2, -y / 2, -z / 2) if args.get("center") else (0, 0, 0)
        return 3, BRepPrimAPI_MakeBox(gp_Pnt(*map(float, o)), float(x), float(y), float(z)).Shape()
    if name == "cylinder":
        h = float(args.get("h", 1))
        r1, r2 = float(args.get("r1", args.get("r", 1))), float(args.get("r2", args.get("r", 1)))
        z0 = -h / 2 if args.get("center") else 0.0
        if h <= 0 or (r1 <= 0 and r2 <= 0):
            return 3, None
        n = polygonal(args, max(r1, r2))
        if n:
            loft = BRepOffsetAPI_ThruSections(True, True)
            for r, z in ((r1, z0), (r2, z0 + h)):
                if r <= 0:
                    loft.AddVertex(BRepBuilderAPI_MakeVertex(gp_Pnt(0, 0, z)).Vertex())
                else:
                    poly = BRepBuilderAPI_MakePolygon()
                    for x, y in ngon(n, r):
                        poly.Add(gp_Pnt(x, y, z))
                    poly.Close()
                    loft.AddWire(poly.Wire())
            loft.Build()
            return 3, loft.Shape()
        interpreted("cylinder", fragments(max(r1, r2), args))
        axis = gp_Ax2(gp_Pnt(0, 0, z0), gp_Dir(0, 0, 1))
        if abs(r1 - r2) < 1e-12:
            return 3, BRepPrimAPI_MakeCylinder(axis, r1, h).Shape()
        return 3, BRepPrimAPI_MakeCone(axis, r1, r2, h).Shape()
    if name == "sphere":
        r = float(args.get("r", args.get("0", 1)))
        if r <= 0:
            return 3, None
        interpreted("sphere", fragments(r, args))
        return 3, BRepPrimAPI_MakeSphere(r).Shape()
    if name == "polyhedron":
        pts = args["points"]
        faces = args.get("faces") or args.get("triangles")
        sewing = BRepBuilderAPI_Sewing(1e-6)
        for face in faces:
            sewing.Add(polygon_face_3d([pts[i] for i in face]))
        sewing.Perform()
        explorer = TopExp_Explorer(sewing.SewedShape(), TopAbs_SHELL)
        solids = []
        while explorer.More():
            fix = ShapeFix_Solid(BRepBuilderAPI_MakeSolid(as_shell(explorer.Current())).Solid())
            fix.Perform()
            solids.append(fix.Solid())
            explorer.Next()
        return 3, fuse(solids)
    if name == "square":
        size = args.get("size", args.get("0", 1))
        x, y = (size, size) if isinstance(size, (int, float)) else size
        if x <= 0 or y <= 0:
            return 2, None
        o = (-x / 2, -y / 2) if args.get("center") else (0, 0)
        return 2, polygon_face([(o[0], o[1]), (o[0] + x, o[1]), (o[0] + x, o[1] + y), (o[0], o[1] + y)])
    if name == "circle":
        r = float(args.get("r", args.get("0", 1)))
        if r <= 0:
            return 2, None
        n = polygonal(args, r)
        if n:
            return 2, polygon_face(ngon(n, r))
        interpreted("circle", fragments(r, args))
        return 2, circle_face(r)
    if name == "polygon":
        pts = [tuple(p[:2]) for p in args["points"]]
        paths = args.get("paths")
        if not paths:
            return 2, polygon_face(pts)
        outer = polygon_face([pts[i] for i in paths[0]])
        for path in paths[1:]:
            outer = BRepAlgoAPI_Cut(outer, polygon_face([pts[i] for i in path])).Shape()
        return 2, outer
    if name == "linear_extrude":
        if (args.get("twist") or 0) != 0 or args.get("scale", [1, 1]) not in ([1, 1], 1, [1.0, 1.0], 1.0):
            raise Unsupported("linear_extrude twist/scale")
        h = float(args.get("height", args.get("0", 1)))
        base = region([k[1] for k in kids])
        if base is None or h <= 0:
            return 3, None
        solid = outward(BRepPrimAPI_MakePrism(base, gp_Vec(0, 0, h)).Shape())
        if args.get("center"):
            trsf = gp_Trsf()
            trsf.SetTranslation(gp_Vec(0, 0, -h / 2))
            solid = BRepBuilderAPI_Transform(solid, trsf, True).Shape()
        return 3, solid
    if name == "rotate_extrude":
        base = region([k[1] for k in kids])
        if base is None:
            return 3, None
        reach = Bnd_Box()
        BRepBndLib.Add_s(base, reach)
        interpreted("rotate_extrude", fragments(max(abs(reach.CornerMin().X()), abs(reach.CornerMax().X())), args))
        trsf = gp_Trsf()
        trsf.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(1, 0, 0)), math.pi / 2)
        profile = BRepBuilderAPI_Transform(base, trsf, True).Shape()
        angle = float(args.get("angle", 360))
        axis = gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1))
        solid = outward(BRepPrimAPI_MakeRevol(profile, axis, math.radians(angle)).Shape())
        # Recent OpenSCAD sweeps from `start` degrees, counter-clockwise from +x.
        start = float(args.get("start") or 0)
        if start % 360 != 0:
            turn = gp_Trsf()
            turn.SetRotation(axis, math.radians(start))
            solid = BRepBuilderAPI_Transform(solid, turn, True).Shape()
        return 3, solid
    if name == "offset":
        # Offset the merged region, not the pieces a 2D boolean left.
        base = region([k[1] for k in kids])
        if base is None:
            return 2, None
        r = args.get("r")
        delta = args.get("delta")
        amount = float(r if r is not None else delta if delta is not None else 1)
        join = GeomAbs_Arc if r is not None else GeomAbs_Intersection
        if r is None and args.get("chamfer"):
            raise Unsupported("offset chamfer")
        out = []
        explorer = TopExp_Explorer(base, TopAbs_FACE)
        while explorer.More():
            op = BRepOffsetAPI_MakeOffset(as_face(explorer.Current()), join)
            op.Perform(amount)
            if not op.IsDone():
                raise Unsupported("offset failed")
            wexp = TopExp_Explorer(op.Shape(), TopAbs_WIRE)
            ws = []
            while wexp.More():
                ws.append(as_wire(wexp.Current()))
                wexp.Next()
            if ws:
                faces = [BRepBuilderAPI_MakeFace(w, True).Face() for w in ws]
                faces.sort(key=lambda f: -area(f))
                face = faces[0]
                for hole in faces[1:]:
                    face = BRepAlgoAPI_Cut(face, hole).Shape()
                out.append(face)
            explorer.Next()
        return 2, fuse(out)
    if name == "hull":
        return dim, hull(node, kids, dim)
    raise Unsupported(name)


def radius(args: dict) -> float:
    """The largest radius of a cylinder or circle node."""
    r = float(args.get("r", args.get("0", 1)))
    return max(float(args.get("r1", r)), float(args.get("r2", r)))


def leaves(node: dict, m):
    """Primitive nodes under groups and transforms, with their accumulated matrix."""
    if node["name"] in ("group", "union", "render", "color"):
        return [leaf for child in node["children"] for leaf in leaves(child, m)]
    if node["name"] == "multmatrix":
        mm = matmul(m, matrix(node["args"].get("0", node["args"].get("m"))))
        return [leaf for child in node["children"] for leaf in leaves(child, mm)]
    return [(node, m)]


def hull(node: dict, kids: list, dim: int):
    prims = [leaf for child in node["children"] for leaf in leaves(child, IDENTITY)]
    translations = all(close(rotation_part(m), [row[:3] for row in IDENTITY[:3]]) for _, m in prims)
    if translations and prims:
        if dim == 3 and all(p["name"] == "cylinder" and not polygonal(p["args"], radius(p["args"])) for p, _ in prims):
            spans, discs, straight = set(), [], True
            for p, m in prims:
                a = p["args"]
                h = float(a.get("h", 1))
                r1, r2 = float(a.get("r1", a.get("r", 1))), float(a.get("r2", a.get("r", 1)))
                z0 = (-h / 2 if a.get("center") else 0.0) + m[2][3]
                spans.add((round(z0, 9), round(z0 + h, 9)))
                straight = straight and abs(r1 - r2) < 1e-12
                discs.append((m[0][3], m[1][3], r1))
            if len(spans) == 1 and straight:
                z0, z1 = next(iter(spans))
                solid = BRepPrimAPI_MakePrism(disc_hull(discs), gp_Vec(0, 0, z1 - z0)).Shape()
                trsf = gp_Trsf()
                trsf.SetTranslation(gp_Vec(0, 0, z0))
                HULLS["cylinders"] += 1
                return BRepBuilderAPI_Transform(solid, trsf, True).Shape()
        if dim == 2 and all(p["name"] == "circle" and not polygonal(p["args"], radius(p["args"])) for p, _ in prims):
            HULLS["circles"] += 1
            return disc_hull([(m[0][3], m[1][3], float(p["args"].get("r", p["args"].get("0", 1)))) for p, m in prims])
    # General case: the convex hull of the children's finely meshed points, as planar facets.
    shape = fuse([k[1] for k in kids])
    if shape is None:
        return None
    BRepMesh_IncrementalMesh(shape, 0.01, False, 0.05, True)
    points = mesh_points(shape)
    if dim == 2:
        HULLS["general2d"] += 1
        APPROXIMATIONS.append("a hull() of 2D shapes other than circles is a polygon through points within 0.01 mm of their outlines")
        return polygon_face(convex_hull_2d([(x, y) for x, y, _ in points]))
    HULLS["general3d"] += 1
    APPROXIMATIONS.append("a hull() of 3D shapes other than upright cylinders is planar facets through points within 0.01 mm of their surfaces")
    triangles, pts = convex_hull_3d(points, 1e-7)
    sewing = BRepBuilderAPI_Sewing(1e-6)
    for a, b, c in triangles:
        sewing.Add(polygon_face_3d([pts[a], pts[b], pts[c]]))
    sewing.Perform()
    explorer = TopExp_Explorer(sewing.SewedShape(), TopAbs_SHELL)
    if not explorer.More():
        raise Unsupported("hull did not close")
    fix = ShapeFix_Solid(BRepBuilderAPI_MakeSolid(as_shell(explorer.Current())).Solid())
    fix.Perform()
    unify = ShapeUpgrade_UnifySameDomain(outward(fix.Solid()), True, True, True)
    unify.Build()
    return unify.Shape()


def mesh_points(shape):
    pts = set()
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(as_face(explorer.Current()), loc)
        if tri is not None:
            t = loc.Transformation()
            for i in range(1, tri.NbNodes() + 1):
                p = tri.Node(i).Transformed(t)
                pts.add((round(p.X(), 9), round(p.Y(), 9), round(p.Z(), 9)))
        explorer.Next()
    return sorted(pts)


# ---------------------------------------------------------------- checks and output


def solids_only(shape):
    found = []
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        found.append(explorer.Current())
        explorer.Next()
    return (compound(found) if len(found) != 1 else found[0]), len(found)


def count(shape, kind) -> int:
    n, explorer = 0, TopExp_Explorer(shape, kind)
    while explorer.More():
        n += 1
        explorer.Next()
    return n


def unmeshed_faces(shape, diagonal: float) -> int:
    """Faces OpenCASCADE's mesher leaves without triangles at a deflection scaled to the part."""
    BRepMesh_IncrementalMesh(shape, min(0.5, max(0.005, 0.001 * diagonal)), False, 0.5, True)
    missing, explorer = 0, TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        loc = TopLoc_Location()
        if BRep_Tool.Triangulation_s(as_face(explorer.Current()), loc) is None:
            missing += 1
        explorer.Next()
    return missing


def open_shells(shape) -> int:
    """Shells whose oriented faces do not close (BRepCheck_Shell), as the validity of a solid needs."""
    found, explorer = 0, TopExp_Explorer(shape, TopAbs_SHELL)
    while explorer.More():
        if BRepCheck_Shell(as_shell(explorer.Current())).Closed() != BRepCheck_NoError:
            found += 1
        explorer.Next()
    return found


def halton(index: int, base: int) -> float:
    fraction, result = 1.0, 0.0
    while index > 0:
        fraction /= base
        result += fraction * (index % base)
        index //= base
    return result


def own_probes(shape, classify, probes: dict):
    """Pairs just inside and just outside the solid's own faces, as the core places them on the render's.

    Every face gets some, the rest go by area. A pair keeps as far from the edges of its mesh
    triangle as from the face, since OpenCASCADE's mesh has slivers along a face's edges. One the
    solid itself does not see as inside then outside, also a margin further out, is tried at the
    core's smaller offsets, first those it trusts at every place on the face, then nearer ones. Returns the pairs
    [inner xyz, outer xyz, face], the faces asked, those left with fewer than two pairs and the
    slivers left out."""
    offsets = [float(o) for o in probes.get("offsets") or []]
    trusted = float(probes.get("trusted") or 0)
    margin = float(probes.get("margin") or 0)
    groups = [[o for o in offsets if o >= trusted], [o for o in offsets if o < trusted]]
    faces, slivers = [], 0
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = as_face(explorer.Current())
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        triangles, cumulative, total = [], [], 0.0
        if tri is not None and tri.HasUVNodes():
            place = loc.Transformation()
            for i in range(1, tri.NbTriangles() + 1):
                corners = tri.Triangle(i).Get()
                p = [tri.Node(k).Transformed(place) for k in corners]
                size = 0.5 * gp_Vec(p[0], p[1]).Crossed(gp_Vec(p[0], p[2])).Magnitude()
                if size > 0:
                    # Heights over the edges opposite each corner.
                    heights = [2 * size / max(p[(k + 1) % 3].Distance(p[(k + 2) % 3]), 1e-300) for k in range(3)]
                    total += size
                    triangles.append(([tri.UVNode(k) for k in corners], heights))
                    cumulative.append(total)
        # A sliver a boolean left, narrower across than the smallest offset (twice its area over
        # its perimeter), is not probed, as the core does not probe the render's.
        edges = GProp_GProps()
        BRepGProp.LinearProperties_s(face, edges)
        if not offsets or 2 * area(face) >= offsets[-1] * edges.Mass():
            faces.append((face, triangles, cumulative, total))
        else:
            slivers += 1
        explorer.Next()
    if not faces or not offsets:
        return [], len(faces), len(faces), slivers
    budget = min(max(int(probes.get("pairs", 2048)), 2 * len(faces)), int(probes.get("maxPairs", 8192)))
    each = min(int(probes.get("perFace", 4)), budget // len(faces))
    if each >= 2:
        spare = budget - each * len(faces)
        whole = sum(f[3] for f in faces) or 1.0
        counts = [each + int(spare * f[3] / whole) for f in faces]
    else:
        counts = [0] * len(faces)
        for index in sorted(range(len(faces)), key=lambda i: (-faces[i][3], i))[: budget // 2]:
            counts[index] = 2
    tries = int(probes.get("tries", 4))
    pairs, unprobed, sequence = [], 0, 0
    for index, ((face, triangles, cumulative, total), wanted) in enumerate(zip(faces, counts)):
        surface = BRepGProp_Face(face)
        # Places on the face, the first evenly by area, the others between them: the point on
        # the surface, its outward normal and its distance from its triangle's edges.
        places = []
        for attempt in range(wanted * tries if triangles else 0):
            sequence += 1
            fraction = (attempt + 0.5) / wanted if attempt < wanted else halton(attempt - wanted + 1, 2)
            uv, heights = triangles[min(bisect.bisect_left(cumulative, fraction * total), len(triangles) - 1)]
            r, s = halton(sequence, 3), halton(sequence, 5)
            if r + s > 1:
                r, s = 1 - r, 1 - s
            # Barycentric weights, kept away from the triangle's edges.
            weights = [1 / 3 + 0.8 * (w - 1 / 3) for w in (1 - r - s, r, s)]
            u = sum(w * q.X() for w, q in zip(weights, uv))
            v = sum(w * q.Y() for w, q in zip(weights, uv))
            point, normal = gp_Pnt(), gp_Vec()
            surface.Normal(u, v, point, normal)  # outward, as the face is oriented in its solid
            length = normal.Magnitude()
            if length > 1e-12:
                n = (normal.X() / length, normal.Y() / length, normal.Z() / length)
                places.append(((point.X(), point.Y(), point.Z()), n, min(w * h for w, h in zip(weights, heights))))
        used = [False] * len(places)
        found = 0
        for group in groups:
            for k, (c, n, room) in enumerate(places):
                if found == wanted:
                    break
                if used[k]:
                    continue
                for offset in group:
                    if offset > room:
                        continue
                    inner = tuple(c[i] - offset * n[i] for i in range(3))
                    outer = tuple(c[i] + offset * n[i] for i in range(3))
                    # Guards a margin further out keep both points clear of any other face.
                    if (
                        classify(inner) == "1"
                        and classify(outer) == "0"
                        and classify(tuple(c[i] - (offset + margin) * n[i] for i in range(3))) == "1"
                        and classify(tuple(c[i] + (offset + margin) * n[i] for i in range(3))) == "0"
                    ):
                        pairs.append([*inner, *outer, index])
                        used[k] = True
                        found += 1
                        break
        if found < 2:
            unprobed += 1
    return pairs, len(faces), unprobed, slivers


def measure(shape, samples, probes: dict):
    """What the core compares with the render, measured on the shape as a reader gets it."""
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    # Corners, not Get(): OCP 8 cannot convert the struct Get() returns.
    low, high = box.CornerMin(), box.CornerMax()
    pieces = []
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        pieces.append(explorer.Current())
        explorer.Next()
    # One classifier per solid, asked about every point; a point outside a solid's box is
    # outside that solid.
    classifiers = []
    for piece in pieces:
        reach = Bnd_Box()
        BRepBndLib.Add_s(piece, reach)
        reach.Enlarge(1e-3)
        classifiers.append((BRepClass3d_SolidClassifier(piece), reach))

    def classify(xyz) -> str:
        point, state = gp_Pnt(*map(float, xyz)), "0"
        for classifier, reach in classifiers:
            if reach.IsOut(point):
                continue
            classifier.Perform(point, 1e-6)
            found = classifier.State()
            if found == TopAbs_IN:
                return "1"
            if found == TopAbs_ON:
                state = "2"
        return state

    free = ShapeAnalysis_FreeBounds(shape)
    result = {
        "volume": volume_of(shape),
        "bboxMin": [low.X(), low.Y(), low.Z()],
        "bboxMax": [high.X(), high.Y(), high.Z()],
        "solids": len(pieces),
        "faces": count(shape, TopAbs_FACE),
        "valid": bool(BRepCheck_Analyzer(shape).IsValid()),
        "freeEdges": count(free.GetClosedWires(), TopAbs_EDGE) + count(free.GetOpenWires(), TopAbs_EDGE),
        "openShells": open_shells(shape),
        # Meshes the faces, which the probes of its own faces sample.
        "unmeshedFaces": unmeshed_faces(shape, math.dist((low.X(), low.Y(), low.Z()), (high.X(), high.Y(), high.Z()))),
        "inside": "".join(classify(sample) for sample in samples),
    }
    probed = own_probes(shape, classify, probes)
    result["solidProbes"], result["solidFaces"], result["solidUnprobed"], result["solidSlivers"] = probed
    return result


def main() -> None:
    request = json.load(open(sys.argv[1]))
    base = {"ocp": OCP_VERSION, "python": sys.version.split()[0]}
    stage = "parse"
    try:
        nodes = parse(open(request["csg"]).read())
        stage = "build"
        _, shape = build({"name": "group", "args": {}, "children": nodes})
        if shape is None:
            raise Unsupported("the CSG tree is empty")
        unify = ShapeUpgrade_UnifySameDomain(shape, True, True, True)
        unify.Build()
        shape, solids = solids_only(unify.Shape())
        if solids == 0:
            raise Unsupported("no solid in the result")
        stage = "write"
        writer = STEPControl_Writer()  # registers the write.step.* parameters set below
        Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
        Interface_Static.SetCVal_s("write.step.unit", "MM")
        if request.get("product"):
            Interface_Static.SetCVal_s("write.step.product.name", str(request["product"])[:120])
        writer.Transfer(shape, STEPControl_AsIs)
        if writer.Write(request["step"]) != IFSelect_RetDone:
            raise Unsupported("the STEP writer failed")
        stage = "check"
        reader = STEPControl_Reader()
        if reader.ReadFile(request["step"]) != IFSelect_RetDone or reader.TransferRoots() == 0:
            raise Unsupported("the written STEP file does not read back")
        import os

        interpretations = [{"kind": kind, "facets": n, "count": c} for (kind, n), c in sorted(INTERPRETED.items())]
        answer({"ok": True, **base, **measure(reader.OneShape(), request.get("samples", []), request.get("probes") or {}),
                "bytes": os.path.getsize(request["step"]), "hull": HULLS, "approximations": sorted(set(APPROXIMATIONS)),
                "interpretations": interpretations})
    except Exception as error:  # every failure is an answer; the core falls back to a faceted STEP
        answer({"ok": False, **base, "stage": stage, "reason": f"{type(error).__name__}: {error}"[:300], "hull": HULLS})


if __name__ == "__main__":
    main()
