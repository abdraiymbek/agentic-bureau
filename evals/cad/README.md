# CAD agent evaluation

Measures whether an agent CLI running inside Omen Flow turns engineering intent
into **dimensionally correct** OpenSCAD parts — judged by geometry, not by
looks and not by "the render command exited 0".

```sh
pnpm eval:cad -- --out /tmp/cad-eval --runs 3                 # main suite, 3 runs per task
pnpm eval:cad -- --out /tmp/cad-eval --tasks flanged-hub       # one task
pnpm eval:cad -- --out /tmp/cad-eval --suite holdout           # unseen tasks
pnpm eval:cad -- --out /tmp/cad-eval --model gpt-5.6-luna --effort high
```

Requirements: OpenSCAD installed (auto-discovered), Codex CLI on PATH and
logged in. Several runners may share one `--out`; `summary.md` is rebuilt from
every `result.json` present.

## What a run does

1. Creates a fresh project through `CoreApp` with the real OpenSCAD adapter,
   seeds any pre-existing artifact the task needs, starts the bridge + MCP
   server exactly as the desktop app does (`CodexAdapter.launchSpec`).
2. Runs `codex exec --json` with the model pinned, the task prompt behind a
   constant framing sentence, and `--ignore-user-config` so only Omen Flow's
   MCP server is present.
3. Takes the **newest revision** of the target mechanical artifact, re-renders
   its OpenSCAD source independently, and runs the task's `Expectation`
   through the shared check engine (`packages/core/src/cad-checks.ts`):
   envelope, analytic volume, watertightness, body count, solid/empty probe
   points, cross-section holes/slots/polygons/outlines, parametric variants
   (`-D` re-renders), and for modification tasks a sampled
   "unrelated geometry preserved" comparison against the seed.
4. Records the trace (`trace.jsonl`), metrics (turns, tool calls, tool errors,
   shell commands, tokens, time, `cad_check` calls and their last result) and
   keeps the project folder for forensics.

Tolerances: 0.1 mm linear (0.15–0.3 on polygonal circles' bounding boxes),
1.5 % volume (absorbs `$fn` faceting), roundness ≥ 0.97 for circular holes
(≈ `$fn ≥ 13`; a default-`$fn` pentagon is a failure).

## Suite

| tier | task                 | category                | what it stresses                               |
| ---- | -------------------- | ----------------------- | ---------------------------------------------- |
| 1    | basic-plate          | basic                   | exact envelope at the origin                   |
| 1    | spacer-ring          | basic                   | bore diameter, centering                       |
| 1    | l-bracket-parametric | parametric              | named parameters, `-D` re-size variant         |
| 1    | flanged-hub          | feature-composition     | stacked bodies, bore, bolt circle              |
| 1    | standoff-plate       | spatial                 | centered pattern, blind-hole depth             |
| 1    | slotted-link         | engineering-constraints | derived positions, rounded ends                |
| 1    | sensor-plate-modify  | modification            | change holes only; same artifact; preservation |
| 1    | nema17-motor-mount   | complete-object         | plate + walls + holes through Y                |
| 2    | stepped-shaft        | spatial                 | axis along X, chamfer                          |
| 2    | open-box             | feature-composition     | shell, floor holes, wall window                |
| 2    | nut-trap-plate       | engineering-constraints | across-flats vs across-corners                 |
| 3    | inclined-foot        | spatial                 | wedge, hole normal to an inclined face         |
| 3    | v-pulley             | engineering-constraints | revolved V profile                             |
| 3    | slotted-disc         | spatial                 | 12-slot radial pattern                         |
| 3    | bracket-thicken      | modification            | derived dimensions under a fixed envelope      |

Every expectation was validated against a hand-written reference solution
before any agent run (`ALL REFERENCE SOLUTIONS PASS`).

Holdout tasks (`holdout.ts`) were written only after the harness changes were
frozen and never used while modifying the system.
