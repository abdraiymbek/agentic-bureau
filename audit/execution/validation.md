# Execution validation — 2026-09-20

Release status: **HOLD**. This is evidence for the current working tree, not a completed release qualification. The user requested wrap-up before the outstanding native fault and performance tests; no further model runs were started.

## Automated gates

| Gate                                | Result                                                   | Retained log                                |
| ----------------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| `OMENFLOW_OPENSCAD_E2E=1 pnpm test` | PASS: 249/249 tests, 32 files, no skips; 38.47 s         | [Tests](evidence/tests-release.log)         |
| `pnpm typecheck`                    | PASS across seven packages                               | [Typecheck](evidence/typecheck-release.log) |
| `pnpm lint`                         | PASS with 0 errors, 53 warnings; warnings remain visible | [Lint](evidence/lint-final.log)             |
| `pnpm package`                      | PASS; macOS arm64 package built                          | [Package](evidence/package-release.log)     |
| `pnpm smoke:packaged`               | PASS; packaged bridge and CLI `artifact.list` round trip | [Smoke](evidence/packaged-smoke-final.log)  |

Local real geometry tests used OpenSCAD 2026.09.18. The pinned Linux CI engine job has not run here. The first smoke attempt collided with the running development app's Electron single-instance lock; closing that app and rerunning passed. This is not evidence of clean-machine installation, signing or upgrades. The final formatting check is retained in `evidence/format-final.log` when completed.

## Native workflow actually exercised

Disposable project: `/private/tmp/omen-v01-execution/native-project`; isolated Omen app data under `/tmp/omen-v01-execution/appdata`. Native interaction used the available computer-use fallback because installed `scu` failed to import its module.

In the development desktop, with **GPT-5.6 Luna High** visibly selected:

1. Created and reopened a project. Asked for a 60 × 40 × 5 mm plate, centered in XY, with four Ø4 mm holes at (±20, ±10). Candidate geometry was visible before approval; 15/15 checks and explicit scope acceptance were reviewed.
2. Asked to change only the holes to Ø6 mm. The same artifact retained its envelope; review displayed baseline/candidate geometry and 29/29 checks with changed scope.
3. Requested Ø5.5 mm instead through saved review rationale. Resume initially failed to submit terminal input. Bracketed paste plus a separate Enter fixed this. A second correction made the resume prompt explicitly request a replacement proposal. Native use then created the corrected draft and replacement proposal, which was reviewed and accepted.
4. Candidate source, revision selector and parameter fields were exercised. Untyped numbers displayed unspecified units. A renderer reload exposed the StrictMode terminal-restoration bug; after its fix, history appeared in the live terminal again.
5. Stopped the agent and quit the development application before final packaging.

The **final packaged app** launched and reopened that project with geometry and revision history persisted. It exposed a remaining regression: with revision 3 (Ø5.5) accepted, Design files defaulted to older proposed revision 2 (Ø6). The screen accurately labeled the displayed candidate but chose the wrong default. The old changes-requested proposal also remains in the review queue after its replacement is accepted. Both belong to unfinished P0-08; see the exact reproduction and fix boundary in [NEXT_AGENT.md](NEXT_AGENT.md).

The full create → modify → request changes → resume → approve loop was exercised in development, not repeated entirely against the final packaged build. Checker v2 deliberately invalidates old v1 evidence; recheck old artifacts instead of treating historical results as current.

## Agent evidence

[Retained Luna results](luna-evaluation.md): final representative pair **1/2 readiness passes**. Both final geometries satisfy independent task geometry checks. Sensor modification passed 23/23 evaluator checks (68.339 s, 7 tools). Inclined foot passed 20/21 (248.290 s, 10 tools), failing final verification scope. The model removed an assertion and failed to disclose `scope_changed` clearly in its final response. Treat this as an unresolved completion regression, not success. No stronger model or relaxed evaluator was used.

## Performance evidence and limits

[Graph measurements](evidence/graph-impact-30.json): 2,000-node impact p50 12.881 ms / p95 23.856 ms over 30 samples, compared with 1,432–1,662 ms before. Root propagation now reaches all 1,999 downstream artifacts; the final root-edit sample took 427 ms. Response JSON is still 2.84 MB. Command timing excludes serialization, bridge and rendering.

[Mesh measurements](../pre-release/evidence/mesh-execution-performance.json): adversarial overlap work now rejects at a declared limit in 41.53 ms versus 929.58 ms of previous blocking work. Supported 100k-triangle analysis still took 401.98 ms. This does not meet the 100 ms stall goal.

The final 60-second idle sample was **not run**. `measure-idle.py` is a prepared script, not evidence. Startup distributions, large-project memory/retention and viewport FPS remain **NOT TESTED**. No final packaged core-crash/forced-quit fault matrix was run. The offline banner and bounded shutdown are implemented but lack that native qualification.

## Acceptance accounting

The master plan classifies every original criterion: **5 PASS, 13 PARTIAL, 1 FAIL** across A01–A19. Model gates: one PASS, one PARTIAL, two FAIL, one NOT TESTED. Performance gates: two PARTIAL, one FAIL, four NOT TESTED. Do not aggregate passing unit tests into passing release criteria. See the master plan for each unresolved condition.
