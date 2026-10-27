"""OpenSCAD part -> exact B-rep STEP, for benchmarks that grade STEP.

    python -I evals/bench/csg_to_step.py <output.scad> <output.stl> <output.step>

OpenSCAD exports its evaluated CSG tree (`openscad -o part.csg`); every node is rebuilt
in OpenCASCADE with analytic geometry (boxes, cylinders, cones, spheres, prisms, revolutions,
booleans, exact hulls of equal-radius circles), so a hole is a true cylinder rather than a
96-gon. Cylinders and circles with $fn of 3-8 stay polygons, as OpenSCAD draws them.

The result must agree with the part Bureau rendered (`output.stl`): volume within 2 % and
bounding box within 0.5 mm (or 0.5 %). Otherwise, or when the tree uses a node this converter
does not rebuild, the STL is sewn into a faceted solid instead. Prints one JSON line.
"""

from __future__ import annotations

import ast
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from OCP.BRep import BRep_Builder
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_GTransform,
    BRepBuilderAPI_MakeEdge,
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakePolygon,
    BRepBuilderAPI_MakeWire,
    BRepBuilderAPI_Transform,
)
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
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
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Shape


class Unsupported(Exception):
    pass


# ---------------------------------------------------------------- CSG parser


def parse(text: str) -> list[dict]:
    pos = 0

    def skip() -> None:
        nonlocal pos
        while pos < len(text) and (text[pos].isspace()):
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
        while text[pos].isalnum() or text[pos] in "_$":
            pos += 1
        name = text[start:pos]
        skip()
        assert text[pos] == "(", f"expected ( after {name!r} at {pos}"
        depth, i, in_str = 0, pos, False
        while True:
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
        key, value = (part.split("=", 1) if "=" in part.split("[")[0].split('"')[0] else (str(index), part))
        value = value.strip().replace("true", "True").replace("false", "False").replace("undef", "None")
        try:
            args[key.strip()] = ast.literal_eval(value)
        except (ValueError, SyntaxError):
            args[key.strip()] = value
    return args


# ---------------------------------------------------------------- geometry helpers


def compound(shapes: list[TopoDS_Shape]) -> TopoDS_Shape:
    result = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(result)
    for shape in shapes:
        builder.Add(result, shape)
    return result


def fuse(shapes: list[TopoDS_Shape]) -> TopoDS_Shape | None:
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


def fragments(args: dict, r: float) -> int:
    fn = args.get("$fn") or 0
    if fn > 0:
        return max(int(fn), 3)
    fa, fs = args.get("$fa", 12) or 12, args.get("$fs", 2) or 2
    return int(math.ceil(max(min(360.0 / fa, r * 2 * math.pi / fs), 5)))


def polygonal(args: dict) -> int | None:
    """The polygon count when OpenSCAD's faceting is clearly intended (a hexagon nut, a square peg)."""
    fn = args.get("$fn") or 0
    return int(fn) if 3 <= fn <= 8 else None


def polygon_face(points: list[tuple[float, float]], z: float = 0.0) -> TopoDS_Shape:
    poly = BRepBuilderAPI_MakePolygon()
    for x, y in points:
        poly.Add(gp_Pnt(float(x), float(y), z))
    poly.Close()
    face = BRepBuilderAPI_MakeFace(poly.Wire(), True)
    if not face.IsDone():
        raise Unsupported("polygon face")
    return face.Face()


def circle_face(r: float, cx: float = 0.0, cy: float = 0.0) -> TopoDS_Shape:
    edge = BRepBuilderAPI_MakeEdge(gp_Circ(gp_Ax2(gp_Pnt(cx, cy, 0), gp_Dir(0, 0, 1)), r)).Edge()
    wire = BRepBuilderAPI_MakeWire(edge).Wire()
    return BRepBuilderAPI_MakeFace(wire, True).Face()


def ngon(n: int, r: float, cx: float = 0.0, cy: float = 0.0) -> list[tuple[float, float]]:
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]


def convex_hull_2d(points: np.ndarray) -> np.ndarray:
    from scipy.spatial import ConvexHull

    hull = ConvexHull(points)
    return points[hull.vertices]


def equal_circle_hull(centers: list[tuple[float, float]], r: float) -> TopoDS_Shape:
    """Exact 2D hull of equal circles: hull polygon of the centres, discs at its corners, strips along its edges."""
    pts = np.unique(np.round(np.array(centers, dtype=float), 9), axis=0)
    if len(pts) == 1:
        return circle_face(r, *pts[0])
    corners = convex_hull_2d(pts) if len(pts) >= 3 and np.linalg.matrix_rank(pts - pts[0]) == 2 else pts[[0, -1]] if len(pts) == 2 else _extremes(pts)
    pieces = [circle_face(r, float(x), float(y)) for x, y in corners]
    if len(corners) >= 3:
        pieces.append(polygon_face([tuple(p) for p in corners]))
    for a, b in zip(corners, np.roll(corners, -1, axis=0)) if len(corners) >= 3 else [(corners[0], corners[1])]:
        d = b - a
        length = float(np.hypot(*d))
        if length < 1e-9:
            continue
        n = np.array([-d[1], d[0]]) / length * r
        pieces.append(polygon_face([tuple(a + n), tuple(b + n), tuple(b - n), tuple(a - n)]))
    return fuse(pieces)


def _extremes(pts: np.ndarray) -> np.ndarray:
    # Collinear points: the two farthest apart.
    d = np.linalg.norm(pts[:, None] - pts[None], axis=-1)
    i, j = np.unravel_index(np.argmax(d), d.shape)
    return pts[[i, j]]


def transform(shape: TopoDS_Shape, m: list[list[float]]) -> TopoDS_Shape:
    a = np.array(m, dtype=float)
    if np.allclose(a, np.eye(4)):
        return shape
    rot = a[:3, :3]
    if np.allclose(rot @ rot.T, np.eye(3), atol=1e-9) and np.linalg.det(rot) > 0:
        trsf = gp_Trsf()
        trsf.SetValues(*a[0, :4], *a[1, :4], *a[2, :4])
        return BRepBuilderAPI_Transform(shape, trsf, True).Shape()
    gtrsf = gp_GTrsf()
    gtrsf.SetVectorialPart(gp_Mat(*rot.flatten()))
    gtrsf.SetTranslationPart(gp_XYZ(*a[:3, 3]))
    op = BRepBuilderAPI_GTransform(shape, gtrsf, True)
    if not op.IsDone():
        raise Unsupported("general transform")
    result = op.Shape()
    # A mirror (negative determinant) leaves solids inside out.
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(result, props)
    return result.Reversed() if props.Mass() < 0 else result


# ---------------------------------------------------------------- tree evaluation

TWO_D = {"square", "circle", "polygon", "text", "projection"}


def build(node: dict) -> tuple[int, TopoDS_Shape | None]:
    name, args = node["name"], node["args"]
    kids = [build(child) for child in node["children"]]
    kids = [k for k in kids if k[1] is not None]
    dim = kids[0][0] if kids else (2 if name in TWO_D else 3)

    if name in ("group", "union", "render", "color", "children"):
        return dim, fuse([k[1] for k in kids])
    if name == "difference":
        if not kids:
            return dim, None
        base = kids[0][1]
        for _, tool in kids[1:]:
            op = BRepAlgoAPI_Cut(base, tool)
            if not op.IsDone():
                raise Unsupported("cut failed")
            base = op.Shape()
        return dim, base
    if name == "intersection":
        if not kids:
            return dim, None
        base = kids[0][1]
        for _, tool in kids[1:]:
            op = BRepAlgoAPI_Common(base, tool)
            if not op.IsDone():
                raise Unsupported("common failed")
            base = op.Shape()
        return dim, base
    if name == "multmatrix":
        shape = fuse([k[1] for k in kids])
        return dim, transform(shape, args["0"] if "0" in args else args["m"]) if shape is not None else None
    if name == "cube":
        size = args.get("size", args.get("0", 1))
        x, y, z = (size, size, size) if isinstance(size, (int, float)) else size
        if min(x, y, z) <= 0:
            return 3, None
        o = (-x / 2, -y / 2, -z / 2) if args.get("center") else (0, 0, 0)
        return 3, BRepPrimAPI_MakeBox(gp_Pnt(*o), float(x), float(y), float(z)).Shape()
    if name == "cylinder":
        h = float(args.get("h", 1))
        r1, r2 = float(args.get("r1", args.get("r", 1))), float(args.get("r2", args.get("r", 1)))
        z0 = -h / 2 if args.get("center") else 0.0
        if h <= 0 or (r1 <= 0 and r2 <= 0):
            return 3, None
        n = polygonal(args)
        if n:
            loft = BRepOffsetAPI_ThruSections(True, True)
            for r, z in ((r1, z0), (r2, z0 + h)):
                if r <= 0:
                    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex

                    loft.AddVertex(BRepBuilderAPI_MakeVertex(gp_Pnt(0, 0, z)).Vertex())
                else:
                    poly = BRepBuilderAPI_MakePolygon()
                    for x, y in ngon(n, r):
                        poly.Add(gp_Pnt(x, y, z))
                    poly.Close()
                    loft.AddWire(poly.Wire())
            loft.Build()
            return 3, loft.Shape()
        axis = gp_Ax2(gp_Pnt(0, 0, z0), gp_Dir(0, 0, 1))
        if abs(r1 - r2) < 1e-12:
            return 3, BRepPrimAPI_MakeCylinder(axis, r1, h).Shape()
        return 3, BRepPrimAPI_MakeCone(axis, r1, r2, h).Shape()
    if name == "sphere":
        r = float(args.get("r", args.get("0", 1)))
        return 3, BRepPrimAPI_MakeSphere(r).Shape() if r > 0 else None
    if name == "polyhedron":
        from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
        from OCP.ShapeFix import ShapeFix_Solid
        from OCP.TopAbs import TopAbs_SHELL

        pts = args["points"]
        faces = args.get("faces") or args.get("triangles")
        sewing = BRepBuilderAPI_Sewing(1e-6)
        for face in faces:
            sewing.Add(polygon_face_3d([pts[i] for i in face]))
        sewing.Perform()
        explorer = TopExp_Explorer(sewing.SewedShape(), TopAbs_SHELL)
        solids = []
        while explorer.More():
            fix = ShapeFix_Solid(BRepBuilderAPI_MakeSolid(TopoDS.Shell_s(explorer.Current())).Solid())
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
        n = polygonal(args)
        return 2, polygon_face(ngon(n, r)) if n else circle_face(r)
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
        base = fuse([k[1] for k in kids])
        if base is None or h <= 0:
            return 3, None
        solid = outward(BRepPrimAPI_MakePrism(base, gp_Vec(0, 0, h)).Shape())
        if args.get("center"):
            trsf = gp_Trsf()
            trsf.SetTranslation(gp_Vec(0, 0, -h / 2))
            solid = BRepBuilderAPI_Transform(solid, trsf, True).Shape()
        return 3, solid
    if name == "rotate_extrude":
        base = fuse([k[1] for k in kids])
        if base is None:
            return 3, None
        trsf = gp_Trsf()
        trsf.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(1, 0, 0)), math.pi / 2)
        profile = BRepBuilderAPI_Transform(base, trsf, True).Shape()
        angle = float(args.get("angle", 360))
        return 3, outward(BRepPrimAPI_MakeRevol(profile, gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), math.radians(angle)).Shape())
    if name == "offset":
        base = fuse([k[1] for k in kids])
        if base is None:
            return 2, None
        r = args.get("r")
        delta = args.get("delta")
        amount = float(r if r is not None else delta if delta is not None else 1)
        join = GeomAbs_Arc if r is not None else GeomAbs_Intersection
        if r is None and args.get("chamfer"):
            raise Unsupported("offset chamfer")
        # A 2D boolean leaves coplanar pieces split along its intersection edges; offset the merged region.
        merged = ShapeUpgrade_UnifySameDomain(base, True, True, True)
        merged.Build()
        base = merged.Shape()
        out = []
        explorer = TopExp_Explorer(base, TopAbs_FACE)
        while explorer.More():
            op = BRepOffsetAPI_MakeOffset(TopoDS.Face_s(explorer.Current()), join)
            op.Perform(amount)
            if not op.IsDone():
                raise Unsupported("offset failed")
            wires = op.Shape()
            from OCP.TopAbs import TopAbs_WIRE

            wexp = TopExp_Explorer(wires, TopAbs_WIRE)
            ws = []
            while wexp.More():
                ws.append(TopoDS.Wire_s(wexp.Current()))
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


def outward(solid: TopoDS_Shape) -> TopoDS_Shape:
    """A sweep of a face whose normal points the other way comes out inside out."""
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(solid, props)
    return solid.Reversed() if props.Mass() < 0 else solid


def polygon_face_3d(points: list[list[float]]) -> TopoDS_Shape:
    poly = BRepBuilderAPI_MakePolygon()
    for p in points:
        poly.Add(gp_Pnt(*map(float, p)))
    poly.Close()
    return BRepBuilderAPI_MakeFace(poly.Wire(), True).Face()


def area(shape: TopoDS_Shape) -> float:
    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, props)
    return props.Mass()


def leaves(node: dict, m: np.ndarray) -> list[tuple[dict, np.ndarray]]:
    """Primitive nodes under groups and transforms, with their accumulated matrix."""
    if node["name"] in ("group", "union", "render", "color"):
        return [leaf for child in node["children"] for leaf in leaves(child, m)]
    if node["name"] == "multmatrix":
        mm = m @ np.array(node["args"].get("0", node["args"].get("m")), dtype=float)
        return [leaf for child in node["children"] for leaf in leaves(child, mm)]
    return [(node, m)]


def hull(node: dict, kids: list, dim: int) -> TopoDS_Shape | None:
    prims = [leaf for child in node["children"] for leaf in leaves(child, np.eye(4))]
    translations = all(np.allclose(m[:3, :3], np.eye(3)) for _, m in prims)
    if translations and prims:
        if dim == 3 and all(p["name"] == "cylinder" and not polygonal(p["args"]) for p, _ in prims):
            spans = set()
            radii = set()
            centers = []
            for p, m in prims:
                a = p["args"]
                h = float(a.get("h", 1))
                r1, r2 = float(a.get("r1", a.get("r", 1))), float(a.get("r2", a.get("r", 1)))
                z0 = (-h / 2 if a.get("center") else 0.0) + m[2, 3]
                spans.add((round(z0, 9), round(z0 + h, 9)))
                radii.add((round(r1, 9), round(r2, 9)))
                centers.append((m[0, 3], m[1, 3]))
            if len(spans) == 1 and len(radii) == 1 and (r := next(iter(radii)))[0] == r[1]:
                z0, z1 = next(iter(spans))
                base = equal_circle_hull(centers, r[0])
                solid = BRepPrimAPI_MakePrism(base, gp_Vec(0, 0, z1 - z0)).Shape()
                trsf = gp_Trsf()
                trsf.SetTranslation(gp_Vec(0, 0, z0))
                return BRepBuilderAPI_Transform(solid, trsf, True).Shape()
        if dim == 2 and all(p["name"] == "circle" and not polygonal(p["args"]) for p, _ in prims):
            radii = {round(float(p["args"].get("r", p["args"].get("0", 1))), 9) for p, _ in prims}
            if len(radii) == 1:
                return equal_circle_hull([(m[0, 3], m[1, 3]) for _, m in prims], next(iter(radii)))
    # General case: the convex hull of the children's finely meshed points.
    shape = fuse([k[1] for k in kids])
    if shape is None:
        return None
    BRepMesh_IncrementalMesh(shape, 0.01, False, 0.05, True)
    pts = mesh_points(shape)
    if dim == 2:
        poly = convex_hull_2d(pts[:, :2])
        return polygon_face([tuple(p) for p in poly])
    from scipy.spatial import ConvexHull
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
    from OCP.ShapeFix import ShapeFix_Solid
    from OCP.TopAbs import TopAbs_SHELL

    ch = ConvexHull(pts)
    sewing = BRepBuilderAPI_Sewing(1e-6)
    for simplex in ch.simplices:
        sewing.Add(polygon_face_3d([pts[i] for i in simplex]))
    sewing.Perform()
    explorer = TopExp_Explorer(sewing.SewedShape(), TopAbs_SHELL)
    fix = ShapeFix_Solid(BRepBuilderAPI_MakeSolid(TopoDS.Shell_s(explorer.Current())).Solid())
    fix.Perform()
    unify = ShapeUpgrade_UnifySameDomain(fix.Solid(), True, True, True)
    unify.Build()
    return unify.Shape()


def mesh_points(shape: TopoDS_Shape) -> np.ndarray:
    from OCP.BRep import BRep_Tool
    from OCP.TopLoc import TopLoc_Location

    pts = []
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(TopoDS.Face_s(explorer.Current()), loc)
        if tri is not None:
            t = loc.Transformation()
            for i in range(1, tri.NbNodes() + 1):
                p = tri.Node(i).Transformed(t)
                pts.append((p.X(), p.Y(), p.Z()))
        explorer.Next()
    return np.unique(np.round(np.array(pts), 9), axis=0)


# ---------------------------------------------------------------- main


def measure(shape: TopoDS_Shape) -> tuple[float, np.ndarray]:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    return props.Mass(), np.array(box.Get())


def solids_only(shape: TopoDS_Shape) -> TopoDS_Shape:
    found = []
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        found.append(explorer.Current())
        explorer.Next()
    return compound(found) if len(found) != 1 else found[0]


def write_step(shape: TopoDS_Shape, path: Path) -> bool:
    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_AsIs)
    path.parent.mkdir(parents=True, exist_ok=True)
    return writer.Write(str(path)) == IFSelect_RetDone


def main() -> None:
    scad, stl, step = map(Path, sys.argv[1:4])
    import trimesh

    reference = trimesh.load(stl, force="mesh")
    ref_volume = abs(float(reference.volume))
    ref_box = np.concatenate([reference.bounds[0], reference.bounds[1]])
    info: dict = {"method": "csg"}
    try:
        with tempfile.TemporaryDirectory() as tmp:
            csg = Path(tmp) / "part.csg"
            subprocess.run(["openscad", "-o", str(csg), str(scad)], check=True, capture_output=True, timeout=120)
            nodes = parse(csg.read_text())
        _, shape = build({"name": "group", "args": {}, "children": nodes})
        if shape is None:
            raise Unsupported("empty")
        unify = ShapeUpgrade_UnifySameDomain(shape, True, True, True)
        unify.Build()
        shape = solids_only(unify.Shape())
        volume, box = measure(shape)
        size = float(np.max(ref_box[3:] - ref_box[:3]))
        info.update(volume=round(volume, 3), refVolume=round(ref_volume, 3), boxError=round(float(np.max(np.abs(box - ref_box))), 4))
        if abs(volume - ref_volume) > 0.02 * ref_volume or info["boxError"] > max(0.5, 0.005 * size):
            raise Unsupported(f"disagrees with render: volume {volume:.1f} vs {ref_volume:.1f}, box error {info['boxError']}")
        if not BRepCheck_Analyzer(shape).IsValid():
            raise Unsupported("invalid B-rep")
    except Exception as error:  # fall back to the faceted render
        info = {"method": "faceted", "reason": f"{type(error).__name__}: {error}"[:300]}
        sys.path.insert(0, str(Path(__file__).parent))
        import score

        info["faceted"] = score.stl_to_step(stl, step, unify=True)
        print(json.dumps(info))
        return
    faces = 0
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        faces += 1
        explorer.Next()
    info.update(faces=faces, written=write_step(shape, step), bytes=step.stat().st_size)
    print(json.dumps(info))


if __name__ == "__main__":
    main()
