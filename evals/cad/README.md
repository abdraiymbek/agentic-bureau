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
3. Takes the **final active candidate or selected baseline**, excluding rejected
   and superseded revisions. A modification task must still refer to its seeded
   artifact and have a surviving new revision. The expected mechanical artifact
   count is enforced. It requires a stored render whose identity matches the
   final source/parameters and persisted verification for that exact revision,
   render fingerprint and checker version. It then re-renders
   its OpenSCAD source independently, and runs the task's `Expectation`
   through the shared check engine (`packages/core/src/cad-checks.ts`):
   envelope, analytic volume, watertightness, body count, solid/empty probe
   points, cross-section holes/slots/polygons/outlines, parametric variants
   (`-D` re-renders), and for modification tasks a sampled
   "unrelated geometry preserved" comparison against the seed.
4. Requires a successful provider exit, a completed turn without fatal provider
   errors, no timeout, and no unfinished session jobs. At exit the session grant
   is revoked and unfinished jobs are cancelled before evaluating the final
   state. Successful geometry from an earlier attempt cannot rescue a failed run.
5. Records the trace (`trace.jsonl`), metrics (turns, tool calls, tool errors,
   shell commands, tokens, time, `cad_check` calls and matching final verification) and
   keeps the project folder for forensics.

`metrics.lastCheckPassed` now means matching final-revision verification. The
field name remains compatible with historical result readers; it no longer
comes from finding `pass:true` in terminal/tool text. `finalRevisionId` and
`verificationEvidenceHash` identify the evaluated evidence. An absent check is
unverified, and partial or changed scope does not count as verified. This stricter
gate means historical reports and new pass rates have different completion
criteria; compare them with that qualification.

OpenSCAD diagnostics are captured from stderr on successful and failed renders.
Warnings fail the clean-render check for the final source and parametric
variants. A failed preservation reference also fails the evaluation explicitly.
Existing STL output is removed before each evaluator render. Set
`OMENFLOW_EVAL_OPENSCAD` to select an explicit evaluator executable; record the
version alongside any published evaluation. Model runs still require an installed,
authenticated Codex CLI and are not run by ordinary CI.

Tolerances: 0.1 mm linear (0.15–0.3 on polygonal circles' bounding boxes),
1.5 % volume (absorbs `$fn` faceting), roundness ≥ 0.97 for circular holes
(≈ `$fn ≥ 13`; a default-`$fn` pentagon is a failure).

Harness notes that help smaller models (still OpenSCAD / STL — no STEP or mates):

- `$fn = 64` is injected when curved primitives have no `$fn`.
- Watertight inside-out meshes are rewound and stored; open meshes are only diagnosed.
- `cad.inspect` accepts `origin`+`normal` for an inclined cut (plus probes).
- `cad.check` flags loosened tolerances on a retry, can require
  `preserve.changeRegions` vs the parent revision, and can fail
  `maxSelfIntersections`.
- File-scope expressions (`height = 2 * plate_w`) are evaluated and shown as
  derived parameters; only literals are `-D`-able.
- `cad.patch_source` is unique search-replace; `cad.compose` module-wraps
  existing parts at translate/rotate.

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

The analytic expectations and preservation checks remain unchanged. Independent
source rendering is not an independent geometry implementation: the evaluator
still shares mesh/checker code with the product. The closed-form geometry tests
and adversarial evaluator regressions must both pass; broader independent
oracles and multi-step/cross-provider evaluation remain separate release work.

Holdout tasks (`holdout.ts`) were written only after the harness changes were
frozen and never used while modifying the system.

## CI and supported platform scope

The initial release target is **macOS arm64**. Its packaged application/smoke job
is a release gate. Windows packaging and smoke remain explicitly experimental
and non-blocking; their presence in CI does not establish Windows release support.

The Linux `real-cad` job is an engineering-test gate, not a Linux desktop support
claim. It installs the published Ubuntu 24.04 package
[`openscad=2021.01-6build4`](https://packages.ubuntu.com/noble/openscad), checks the
installed package and engine versions, and requires a successful real adapter
probe before running CAD, mesh, lifecycle and evaluator tests with
`OMENFLOW_OPENSCAD_E2E=1`. Installation/probe failure fails the job instead of
silently producing a skipped-engine green build. The version output is uploaded
as an artifact. If that exact distribution package becomes unavailable, update
the pin deliberately and revalidate geometry; do not fall back silently.

Deterministic evaluator tests require no model credentials:

```sh
pnpm exec vitest run tests/cad-evaluator.test.ts
```

## Explicit synchronous geometry limits

V0.1 rejects unsupported workloads with `VALIDATION`, details
`reason: CAD_WORK_LIMIT` and `status: not_evaluated`; it never silently reduces
an explicitly requested check's coverage:

| Work                                                          | Limit                                              |
| ------------------------------------------------------------- | -------------------------------------------------- |
| STL file/object loaded into CAD analysis                      | 6,000,000 bytes                                    |
| Parsed mesh                                                   | 100,000 complete triangles with finite coordinates |
| Explicit probe/section-feature assertions per check           | 512                                                |
| Public inspection probes / extra section planes               | 64 / 12                                            |
| Probe, section, preservation or wall-sampling triangle visits | 10,000,000 per operation                           |
| Self-intersection candidate pairs                             | 8,000,000                                          |
| Self-intersection pairs with overlapping bounding boxes       | 100,000                                            |

The STL byte budget leaves room for base64 plus message overhead inside the
unchanged 8 MiB bridge frame. Files are checked before reading renderer output
or cached/stored meshes, and triangle counts before triangle-buffer allocation.
An oversized optional inspection diagnostic is labeled “not evaluated.” An
explicit oversized verification request fails, preserving the distinction
between unchecked and passing geometry. More complex artifacts need reduced
tessellation or smaller independent checks until cancellable worker execution
is available. These limits bound resource use; they do not establish the
master plan's 100 ms core-stall target for every supported mesh.
