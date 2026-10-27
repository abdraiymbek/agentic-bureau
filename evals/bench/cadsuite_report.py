"""Summarise and chart an internal-CAD-suite comparison across setups.

    python -I evals/bench/cadsuite_report.py <out dir> --fonts <dir of TTFs> <label>=<arm dir> ...

Each arm dir holds `cadsuite/<task>__r<n>/` runs with `result.json` (evals/bench/run.ts) and
`judge.json` (evals/bench/judge-cadsuite.ts). Cost is recomputed from each run's token usage at
list price (score.task_cost). Writes summary.json, summary.md and the chart in dark and light.
"""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import score  # noqa: E402

THEMES = {  # Bureau tokens (design-system/tokens.css); lines flattened onto the field
    "dark": {"field": "#07090c", "text": "#e6eaee", "text2": "#a3adb8", "text3": "#818c9a", "line": "#14171b", "accent": "#4fc8f0", "muted": "#818c9a", "ring": "#07090c"},
    "light": {"field": "#eceef1", "text": "#0a0e12", "text2": "#424a55", "text3": "#5b6470", "line": "#d9dbdf", "accent": "#1286b6", "muted": "#7d8591", "ring": "#eceef1"},
}


def ours_label(label: str) -> bool:
    """Our setup. Results recorded before the rename call it Omen Flow."""
    return "Bureau" in label or "Omen Flow" in label


def summarise(label: str, arm: Path) -> dict:
    runs = []
    for result_file in sorted((arm / "cadsuite").glob("*/result.json")):
        result = json.loads(result_file.read_text())
        judge_file = result_file.parent / "judge.json"
        verdict = json.loads(judge_file.read_text()) if judge_file.exists() else {"pass": False, "checks": []}
        model = result.get("model") or ("claude-opus-5-5" if "opus" in arm.name else "claude-haiku-5-5")
        cost = score.task_cost(result_file.parent, model)
        checks = verdict.get("checks", [])
        runs.append(
            {
                "task": result["id"].rsplit("__r", 1)[0],
                "pass": bool(verdict["pass"]),
                "usd": cost["usd"],
                "seconds": result["durationMs"] / 1000,
                "outputTokens": cost["output"],
                "checks": len(checks),
                "checksPassed": sum(1 for c in checks if c.get("pass")),
                "timedOut": result.get("timedOut", False),
            }
        )
    passed = sum(r["pass"] for r in runs)
    usd = sum(r["usd"] for r in runs)
    tasks = sorted({r["task"] for r in runs})
    reliable = sum(all(r["pass"] for r in runs if r["task"] == t) for t in tasks)
    return {
        "label": label,
        "model": runs and model,
        "runs": len(runs),
        "passed": passed,
        "passRate": passed / len(runs) if runs else 0.0,
        "tasksAllRunsPassed": reliable,
        "tasks": len(tasks),
        "checksPassed": sum(r["checksPassed"] for r in runs),
        "checks": sum(r["checks"] for r in runs),
        "costUsd": usd,
        "costPerRunUsd": usd / len(runs) if runs else 0.0,
        "costPerCorrectPartUsd": usd / passed if passed else None,
        "medianSeconds": statistics.median(r["seconds"] for r in runs) if runs else 0,
        "timeouts": sum(r["timedOut"] for r in runs),
        "failedTasks": sorted({r["task"] for r in runs if not r["pass"]}),
    }


def chart(rows: list[dict], out: Path, fonts: Path, theme: str) -> None:
    """Two panels on one row: parts correct, and cost per correct part; Bureau in the accent, the rest gray."""
    import matplotlib

    matplotlib.use("Agg")
    from matplotlib import font_manager
    import matplotlib.pyplot as plt

    for ttf in fonts.glob("*.ttf"):
        font_manager.fontManager.addfont(str(ttf))
    t = THEMES[theme]
    sans, mono = "Geist", "IBM Plex Mono"
    fig, (left, right) = plt.subplots(1, 2, figsize=(11, 5.4), dpi=200, gridspec_kw={"width_ratios": [1, 1], "wspace": 0.16})
    fig.patch.set_facecolor(t["field"])
    ys = list(range(len(rows)))[::-1]
    colors = [t["accent"] if ours_label(r["label"]) else t["muted"] for r in rows]
    worst = max((r["costPerCorrectPartUsd"] or 0) for r in rows)

    for ax, title in ((left, "Parts correct"), (right, "Cost per correct part (USD, list price)")):
        ax.set_facecolor(t["field"])
        for side in ("top", "right", "left"):
            ax.spines[side].set_visible(False)
        ax.spines["bottom"].set_color(t["line"])
        ax.tick_params(axis="x", colors=t["text3"], labelsize=9, length=0)
        ax.tick_params(axis="y", length=0)
        ax.set_yticks([])
        ax.grid(True, axis="x", color=t["line"], linewidth=0.8)
        ax.set_axisbelow(True)
        ax.set_title(title, loc="left", fontsize=11, fontfamily=sans, color=t["text2"], pad=10)
        for label in ax.get_xticklabels():
            label.set_fontfamily(mono)

    left.set_xlim(0, 1.0)
    left.set_xticks([0, 0.25, 0.5, 0.75, 1.0], ["0%", "25%", "50%", "75%", "100%"])
    right.set_xlim(0, worst * 1.32)
    from matplotlib.ticker import FuncFormatter

    right.xaxis.set_major_formatter(FuncFormatter(lambda v, _: "" if v == 0 else f"${v:g}"))
    for label in right.get_xticklabels():
        label.set_fontfamily(mono)
    for y, r, c in zip(ys, rows, colors):
        ours = ours_label(r["label"])
        left.barh(y, r["passRate"], height=0.46, color=c, edgecolor=t["field"], linewidth=2)
        left.text(0.012, y + 0.38, r["label"], fontsize=12, fontfamily=sans, fontweight="semibold" if ours else "medium", color=t["text"], va="bottom")
        left.text(min(r["passRate"], 1.0) - 0.015, y, f"{r['passed']}/{r['runs']}", fontsize=10.5, fontfamily=mono,
                  color=t["field"], va="center", ha="right", fontweight="medium")
        cost = r["costPerCorrectPartUsd"] or 0
        right.barh(y, cost, height=0.46, color=c, edgecolor=t["field"], linewidth=2)
        right.text(cost + worst * 0.02, y, f"${cost:.3f}" if cost < 1 else f"${cost:.2f}", fontsize=10.5, fontfamily=mono, color=t["text"], va="center")
    for ax in (left, right):
        ax.set_ylim(-0.6, len(rows) - 0.1)

    n_tasks = rows[0]["tasks"]
    runs_each = rows[0]["runs"] // max(n_tasks, 1)
    fig.text(0.06, 0.94, "Same CAD tasks, same judge: quality and cost", fontsize=17, fontfamily=sans, fontweight="semibold", color=t["text"])
    fig.text(0.06, 0.895,
             f"Bureau internal CAD suite: {n_tasks} parts \u00d7 {runs_each} runs per setup. Every delivered part is re-rendered and checked against its specification.",
             fontsize=10, fontfamily=sans, color=t["text3"])
    fig.text(0.06, 0.035,
             "Claude Code 2.1.287 at xhigh effort, October 2026. Correct means every geometry check passes: envelope, volume, bodies, probe points, sections, parameter variants.",
             fontsize=8.5, fontfamily=sans, color=t["text3"])
    fig.subplots_adjust(left=0.06, right=0.97, top=0.8, bottom=0.12)
    fig.savefig(out, facecolor=t["field"])
    plt.close(fig)


def main() -> None:
    out = Path(sys.argv[1])
    fonts = Path(sys.argv[sys.argv.index("--fonts") + 1])
    arms = [a for a in sys.argv[2:] if "=" in a]
    rows = [summarise(label, Path(path)) for label, path in (a.split("=", 1) for a in arms)]
    out.mkdir(parents=True, exist_ok=True)
    (out / "summary.json").write_text(json.dumps(rows, indent=2))
    lines = ["| Setup | Parts correct | Tasks correct in all runs | Checks passed | Cost (list) | Cost per correct part | Median time |", "|---|---|---|---|---|---|---|"]
    for r in rows:
        per = f"${r['costPerCorrectPartUsd']:.4f}" if r["costPerCorrectPartUsd"] else "—"
        lines.append(f"| {r['label']} | {r['passed']}/{r['runs']} ({r['passRate']:.0%}) | {r['tasksAllRunsPassed']}/{r['tasks']} | {r['checksPassed']}/{r['checks']} | ${r['costUsd']:.2f} | {per} | {r['medianSeconds']:.0f} s |")
    (out / "summary.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    for r in rows:
        print(r["label"], "failed tasks:", ", ".join(r["failedTasks"]) or "none")
    for theme in THEMES:
        chart(rows, out / f"cad-suite-comparison-{theme}.png", fonts, theme)


if __name__ == "__main__":
    main()
