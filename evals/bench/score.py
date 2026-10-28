"""Score an evals/bench run.

    python -I evals/bench/score.py <run dir> --benchcad-repo <BenchCAD-main checkout> --benchcad-steps <GT steps dir>

- cost: recomputed from the CLI's per-request token usage at Claude Haiku 5.5 list prices
  (the CLI does not know the model and prices it like a larger one). Requests whose prompt
  exceeds 100K tokens use the long-context rate.
- benchcad: BenchCAD Vision2Code voxel IoU (64^3, bbox-normalised), computed with BenchCAD's own
  ground-truth loader and voxelisation; a task with no part scores 0.
- cadgenbench: each part's STL becomes a faceted STEP (sewn triangles, coplanar faces merged),
  checked against CADGenBench's three validity rules, and laid out as results/<run>/<id>/output.step.
  Its score needs the private ground truth on the leaderboard Space.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

PRICES = {  # $ per million tokens at list price: short (<=100K prompt) and long
    "claude-haiku-5-5": {
        "short": {"input": 0.10, "output": 0.50, "cache_write": 0.125, "cache_read": 0.01},
        "long": {"input": 0.50, "output": 2.50, "cache_write": 0.625, "cache_read": 0.05},
    },
    "claude-opus-5-5": {  # one rate across the context window
        "short": {"input": 4.00, "output": 20.00, "cache_write": 5.00, "cache_read": 0.20},
        "long": {"input": 4.00, "output": 20.00, "cache_write": 5.00, "cache_read": 0.20},
    },
}
PRICE = PRICES["claude-haiku-5-5"]


def stream_usage(events: Path) -> tuple[list[dict], int]:
    """Prompt-side usage of each request (last report per message id) and the run's output tokens.

    Assistant events carry each request's prompt tokens but only a partial output count, so
    output tokens come from the run's final result event."""
    usage: dict[str, dict] = {}
    output = 0
    for line in events.read_text().splitlines():
        if not line.startswith("{"):
            continue
        event = json.loads(line)
        if event.get("type") == "result":
            output += (event.get("usage") or {}).get("output_tokens", 0)
        message = event.get("message", {}) if event.get("type") == "assistant" else {}
        if message.get("id") and message.get("usage"):
            usage[message["id"]] = message["usage"]
    return list(usage.values()), output


def task_cost(task_dir: Path, model: str = "claude-haiku-5-5") -> dict:
    price = PRICES[model]
    total = {"requests": 0, "longRequests": 0, "input": 0, "cache_write": 0, "cache_read": 0, "output": 0, "usd": 0.0}
    for events in [task_dir / "events.jsonl", *sorted(task_dir.glob("continue-*/events.jsonl"))]:
        if not events.exists():
            continue
        requests, output = stream_usage(events)
        long_requests = 0
        for u in requests:
            fresh = u.get("input_tokens", 0)
            write = u.get("cache_creation_input_tokens", 0)
            read = u.get("cache_read_input_tokens", 0)
            long_ = fresh + write + read > 100_000
            long_requests += long_
            p = price["long" if long_ else "short"]
            total["input"] += fresh
            total["cache_write"] += write
            total["cache_read"] += read
            total["usd"] += (fresh * p["input"] + write * p["cache_write"] + read * p["cache_read"]) / 1e6
        # Output is split across tiers in proportion to the requests in each.
        share = long_requests / len(requests) if requests else 0.0
        total["usd"] += output * (share * price["long"]["output"] + (1 - share) * price["short"]["output"]) / 1e6
        total["output"] += output
        total["requests"] += len(requests)
        total["longRequests"] += long_requests
    return total


def benchcad_iou(stl: Path, gt_step: Path, iou_module) -> float:
    import numpy as np
    import trimesh

    try:
        mesh = trimesh.load(stl, force="mesh")
        verts = np.asarray(mesh.vertices, dtype=float)
        lo, hi = verts.min(axis=0), verts.max(axis=0)
        longest = (hi - lo).max()
        if longest < 1e-9:
            return 0.0
        ours = trimesh.Trimesh(vertices=(verts - (lo + hi) / 2.0) / longest + 0.5, faces=mesh.faces, process=False)
        gt = iou_module._load_normalized_mesh(gt_step)
        res = 64
        a = iou_module._vox_dense(ours.voxelized(pitch=1.0 / res).fill(), res + 4)
        b = iou_module._vox_dense(gt.voxelized(pitch=1.0 / res).fill(), res + 4)
        union = np.logical_or(a, b).sum()
        return float(np.logical_and(a, b).sum() / union) if union else 0.0
    except Exception as error:  # a part that cannot be voxelised scores 0, as in BenchCAD
        print(f"  iou failed for {stl}: {error}", file=sys.stderr)
        return 0.0


def stl_to_step(stl: Path, step: Path, unify: bool = False) -> dict:
    """Sew the STL's triangles into a solid (one planar face per triangle), write STEP, check validity.

    Merging coplanar triangles shrinks the file but leaves many-edged polygon faces that the
    official validity gate cannot tessellate within its 180 s limit, so it is off by default."""
    import numpy as np
    import trimesh
    from OCP.BRep import BRep_Builder
    from OCP.BRepBuilderAPI import (
        BRepBuilderAPI_MakePolygon,
        BRepBuilderAPI_MakeFace,
        BRepBuilderAPI_MakeSolid,
        BRepBuilderAPI_Sewing,
    )
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.gp import gp_Pnt
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.ShapeFix import ShapeFix_Solid
    from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS, TopoDS_Compound

    started = time.time()
    mesh = trimesh.load(stl, force="mesh")
    mesh.merge_vertices()
    sewing = BRepBuilderAPI_Sewing(1e-6)
    v = mesh.vertices
    for a, b, c in mesh.faces:
        poly = BRepBuilderAPI_MakePolygon(gp_Pnt(*v[a]), gp_Pnt(*v[b]), gp_Pnt(*v[c]), True)
        face = BRepBuilderAPI_MakeFace(poly.Wire(), True)
        if face.IsDone():
            sewing.Add(face.Face())
    sewing.Perform()
    sewn = sewing.SewedShape()
    solids = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(solids)
    shells = 0
    explorer = TopExp_Explorer(sewn, TopAbs_SHELL)
    while explorer.More():
        maker = BRepBuilderAPI_MakeSolid(TopoDS.Shell_s(explorer.Current()))
        fix = ShapeFix_Solid(maker.Solid())
        fix.Perform()
        builder.Add(solids, fix.Solid())
        shells += 1
        explorer.Next()
    if unify:
        unifier = ShapeUpgrade_UnifySameDomain(solids, True, True, True)
        unifier.Build()
        shape = unifier.Shape()
    else:
        shape = solids
    faces = 0
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        faces += 1
        explorer.Next()
    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_AsIs)
    step.parent.mkdir(parents=True, exist_ok=True)
    ok = writer.Write(str(step)) == IFSelect_RetDone

    # CADGenBench validity: well-formed BREP, watertight, meshes into a closed orientable manifold.
    brep_valid = BRepCheck_Analyzer(shape).IsValid()
    BRepMesh_IncrementalMesh(shape, 0.05, False, 0.5, True)
    from OCP.BRep import BRep_Tool
    from OCP.TopLoc import TopLoc_Location

    verts, tris, offset = [], [], 0
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is not None:
            trsf = loc.Transformation()
            for i in range(1, tri.NbNodes() + 1):
                p = tri.Node(i).Transformed(trsf)
                verts.append((p.X(), p.Y(), p.Z()))
            reversed_ = face.Orientation() == 1
            for i in range(1, tri.NbTriangles() + 1):
                n1, n2, n3 = tri.Triangle(i).Get()
                tris.append((offset + n1 - 1, offset + n3 - 1, offset + n2 - 1) if reversed_ else (offset + n1 - 1, offset + n2 - 1, offset + n3 - 1))
            offset += tri.NbNodes()
        explorer.Next()
    remesh = trimesh.Trimesh(vertices=np.array(verts), faces=np.array(tris), process=True)
    return {
        "written": ok,
        "bytes": step.stat().st_size if step.exists() else 0,
        "shells": shells,
        "faces": faces,
        "brepValid": bool(brep_valid),
        "watertight": bool(remesh.is_watertight),
        "windingConsistent": bool(remesh.is_winding_consistent),
        "valid": bool(ok and brep_valid and remesh.is_watertight and remesh.is_winding_consistent),
        "seconds": round(time.time() - started, 1),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run", type=Path)
    parser.add_argument("--benchcad-repo", type=Path, required=True)
    parser.add_argument("--benchcad-steps", type=Path, required=True)
    parser.add_argument("--cadgen-fixtures", type=Path, required=True)
    parser.add_argument("--benchcad-sample", type=Path, required=True, help="records.jsonl of the sample")
    parser.add_argument("--skip-step", action="store_true")
    args = parser.parse_args()
    sys.path.insert(0, str(args.benchcad_repo))
    from benchcad_core.scoring import iou as iou_module

    rows = []
    for result_file in sorted(args.run.glob("*/*/result.json")):
        result = json.loads(result_file.read_text())
        task_dir = result_file.parent
        row = {
            "bench": result["bench"],
            "id": result["id"],
            "part": (task_dir / "output.stl").exists(),
            "seconds": round(result["durationMs"] / 1000),
            "timedOut": result["timedOut"],
            "continuations": result.get("continuations", 0),
            "calls": result["calls"],
            "tools": result["tools"],
            "cliCostUsd": (result.get("stream") or {}).get("costUsd"),
            "cost": task_cost(task_dir),
            "harnessError": (result.get("harnessError") or "").split("\n")[0] or None,
        }
        if result["bench"] == "benchcad":
            row["iou"] = benchcad_iou(task_dir / "output.stl", args.benchcad_steps / f"{result['id']}.step", iou_module) if row["part"] else 0.0
        elif row["part"] and not args.skip_step:
            row["step"] = stl_to_step(task_dir / "output.stl", args.run / "submission" / "results" / "bureau-haiku-5-5-xhigh" / result["id"] / "output.step")
        rows.append(row)
        print(json.dumps({k: row.get(k) for k in ("bench", "id", "part", "iou", "seconds")} | ({"valid": row["step"]["valid"]} if "step" in row else {})), flush=True)
    (args.run / "scores.json").write_text(json.dumps(rows, indent=2))

    cadgen_ids = sorted(p.name for p in args.cadgen_fixtures.iterdir() if p.name[:1] == "1" and p.is_dir())
    sample = [json.loads(l)["stem"] for l in args.benchcad_sample.read_text().splitlines() if l.strip()]
    for bench, universe in (("cadgenbench", cadgen_ids), ("benchcad", sample)):
        done = [r for r in rows if r["bench"] == bench]
        if not done:
            continue
        usd = sum(r["cost"]["usd"] for r in done)
        summary = {
            "bench": bench,
            "tasks": len(universe),
            "run": len(done),
            "parts": sum(r["part"] for r in done),
            "costUsd": round(usd, 3),
            "costPerTaskUsd": round(usd / len(done), 4),
            "cliCostUsd": round(sum(r["cliCostUsd"] or 0 for r in done), 2),
            "medianSeconds": sorted(r["seconds"] for r in done)[len(done) // 2],
            "timeouts": sum(r["timedOut"] for r in done),
        }
        if bench == "benchcad":
            ious = [r["iou"] for r in done]
            summary["meanIoU_run"] = round(sum(ious) / len(ious), 4)
            summary["meanIoU_sample"] = round(sum(ious) / len(universe), 4)  # unrun tasks score 0
        else:
            steps = [r.get("step") for r in done if r.get("step")]
            summary["validSteps"] = sum(s["valid"] for s in steps)
            summary["maxStepMB"] = round(max((s["bytes"] for s in steps), default=0) / 1e6, 1)
        print(json.dumps(summary))


if __name__ == "__main__":
    main()
