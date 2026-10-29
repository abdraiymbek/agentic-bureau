# Pre-release audit evidence — 2026-09-20

Audited commit: `9305742` (`Tighten the workspace around the current object and its state.`).
The deliverable is [OMEN_V0.1_MASTER_PLAN.md](OMEN_V0.1_MASTER_PLAN.md).
Product code was not changed by this audit.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm rebuild:node
pnpm exec tsx audit/pre-release/reproduce.ts
pnpm exec tsx audit/pre-release/measure.ts
```

The CAD probes need OpenSCAD. Both scripts create disposable projects in the OS temporary directory and print the result location. They intentionally exercise invalid operations. **These are observations, not tests asserting that bugs should remain.** Convert each issue to a regression test of the corrected behavior when implementing the plan. No real user projects are inputs.

`evidence/probes.json` records 19 named probes, including observations that span multiple operations. The research URL probe uses a stub host and makes no network request. `performance.json` records synthetic graph/list/intersection probes. Its process RSS includes cumulative fixture construction and is not a desktop memory benchmark. The synthetic graph is a deliberately adversarial chain; its 64-level traversal truncation is part of the finding.

The two `native-idle-*.json` files contain twelve one-second `ps -o pid,pcpu,rss` samples of the dev Electron main, GPU, network, utility and renderer processes. Values are PID, percent CPU, RSS in KiB. They exclude Vite and the external model CLI. CPU percent is relative to one CPU core; these are short observational samples, not precise utilization or frame-time benchmarks. The final Overview sample includes activity, so its mean should not be called a steady-state baseline. GPU-process CPU is not GPU utilization.

`luna-eval.md` is a fresh two-task run, using the existing repository evaluator:

```sh
pnpm eval:cad -- --out /tmp/omen-cto-audit/eval \
  --tasks sensor-plate-modify,inclined-foot --runs 1 --timeout-min 6
```

This does not constitute an independent rerun of the historical full suite or cross-model evidence. The evaluator shares geometric check code with the product. Full model traces and native terminal databases remain in disposable local audit directories and are deliberately not copied here.

## Native desktop observations

Environment: Apple M5, 16 GiB RAM, macOS 26.6.2; OpenSCAD 2026.09.18; Codex CLI 0.154.0. Native app launched with isolated core app data using `OMENFLOW_APP_DATA=/tmp/omen-cto-audit/appdata pnpm dev`. The renderer still uses the app's ordinary Electron user-data directory. The `scu` CLI could not import its Python module, so GUI interaction used the available native desktop automation tool.

Disposable project: `/tmp/omen-cto-audit/native-project`. Model selection: GPT-5.6 Luna, High. Native terminal inherited the installed CLI's configuration; the automated evaluator uses a more controlled configuration. Unrelated MCP startup errors appeared in the native CLI, but Omen Flow tools worked.

| Exercise                                                                               | Observation                                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create a 60 × 40 × 5 mm plate, centered in XY, bottom Z=0, four Ø4 holes at (±20, ±10) | Agent rendered and checked 16/16 assertions, then submitted a proposal.                                                                                                                |
| Inspect first proposal before acceptance                                               | Review displayed a truncated JSON payload; Design files had no selected geometry despite the proposed mesh existing. Accepted only to continue this disposable test.                   |
| “Make it stronger without changing envelope or hole centers; clarify first”            | Agent asked about the tradeoff and did not modify geometry. Appropriate behavior.                                                                                                      |
| Request thickness 8 mm, then interrupt during source reading                           | Agent stopped; approved baseline remained unchanged. This tests one interruption point, not all cancellation races.                                                                    |
| Redirect: retain 5 mm thickness, enlarge only holes to Ø6                              | Same-artifact draft, 16/16 reported checks; correct submission. Review showed source hash, STL hash and job ID changes, with no engineering comparison.                                |
| Request changes through review: Ø5.5 holes, preserve thickness and centers             | Decision saved, queue badge became zero while changes-requested card remained. Terminal stayed at its previous result until a manual prompt relayed the decision.                      |
| Manually tell agent to read reviewer decision and correct it                           | Agent produced revision 3 with Ø5.5 holes and 16/16 reported checks; submitted a new proposal based on approved revision 1.                                                            |
| Renderer reload, reopen recent project                                                 | Returned to launcher; recent title was folder name. Project and proposals survived, but running terminal was blank and did not restore prior output.                                   |
| Stop agent, kill this audit's utility process, navigate to Design files and render     | No service-offline state. Page said Current/Approved and No geometry; render button remained Starting render. IPC source sets a 300-second timeout for this path. App was then closed. |

These are human-observed GUI outcomes, not an automated UI suite. No physical fabrication, production engineering validation, multi-hour soak, GPU profiling, Windows run, or multi-model comparison was performed.
