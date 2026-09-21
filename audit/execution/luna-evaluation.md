# Luna CAD execution evaluation

The final paired rerun achieved **2/2 correct geometries, but only 1/2 verified final artifacts** under the strengthened evaluator. The sensor modification recovered after the preservation/scope fixes. The inclined foot still failed because its assertion scope changed; its final message omitted that qualification. **These runs do not clear the agent release gate.** They demonstrate useful Luna capability and a remaining gap between producing correct geometry and reliably establishing and communicating completion.

## Method and retained evidence

Each stage ran `sensor-plate-modify` and `inclined-foot` once with **GPT-5.6 Luna, reasoning high**, through the real Omen MCP bridge and OpenSCAD. The final artifacts record OpenSCAD **2026.09.18**, millimetres and a right-handed Z-up frame. The CLI used an ephemeral session, ignored user configuration, and had workspace-write access. All six runs exited successfully, completed one turn, reported zero tool/API errors and zero shell commands, and did not time out. Zero tool errors does **not** mean zero geometric or verification failures: those are structured tool results.

Results, including both implementation failures, are retained in [luna-results](luna-results/). Each `*-checks.json` preserves every check's expectations, revision, overrides, failed assertions, verification status and recovery guidance. The final `*-evidence.json` files preserve the immutable evidence returned by the product, including input/output/spec identity, coverage and limitations. Final source files and model invocation arguments are also retained, including the [inclined-foot reproduction source](luna-results/implementation-final-inclined-foot.scad). Full raw traces and projects remain in the corresponding directories:

- Audit baseline: `/tmp/omen-cto-audit/eval/{task}/r1/`.
- First implementation run: `/tmp/omen-v01-execution/eval/{task}/r1/`.
- Final paired rerun: `/tmp/omen-v01-execution/eval-final/{task}/r1/`.

The old evaluator lacked five of the current provider/final-candidate/evidence gates. Its pass totals are historical evidence, **not directly comparable release pass rates**. The current evaluator independently re-renders source, but shares the product mesh/check implementation. It is not a fully independent geometry oracle. This is one observation per task per stage, not a latency distribution or controlled causal performance experiment.

## Results

“Geometry” counts the task's geometric assertions after lifecycle/source-render gates. “Declared checks” is the last agent-requested geometric check count; it must not be substituted for verification status.

| Stage                | Task                | Evaluator             | Geometry | Final declared checks / evidence | Time      | Tools / checks |
| -------------------- | ------------------- | --------------------- | -------- | -------------------------------- | --------- | -------------- |
| Audit baseline       | Sensor modification | PASS 18/18, old gates | 15/15    | 21/21; old evidence contract     | 65.957 s  | 5 / 2          |
| Audit baseline       | Inclined foot       | PASS 16/16, old gates | 14/14    | 10/10; old evidence contract     | 114.838 s | 6 / 2          |
| First implementation | Sensor modification | **FAIL 22/23**        | 15/15    | 18/18; `scope_changed`           | 163.527 s | 13 / 6         |
| First implementation | Inclined foot       | PASS 21/21            | 14/14    | 11/11; `passed`                  | 131.825 s | 6 / 2          |
| Final paired rerun   | Sensor modification | **PASS 23/23**        | 15/15    | 20/20; `passed`                  | 68.339 s  | 7 / 2          |
| Final paired rerun   | Inclined foot       | **FAIL 20/21**        | 14/14    | 11/11; `scope_changed`           | 248.290 s | 10 / 4         |

| Stage / task     | Input tokens | Cached input | Uncached input | Output tokens | Reported reasoning tokens |
| ---------------- | -----------: | -----------: | -------------: | ------------: | ------------------------: |
| Audit / sensor   |      172,876 |      133,376 |         39,500 |         2,971 |                     1,378 |
| Audit / inclined |      220,825 |      191,488 |         29,337 |         5,819 |                     3,695 |
| First / sensor   |      412,313 |      368,128 |         44,185 |         7,948 |                     4,153 |
| First / inclined |      211,604 |      185,344 |         26,260 |         6,668 |                     4,305 |
| Final / sensor   |      156,673 |      133,376 |         23,297 |         2,813 |                       902 |
| Final / inclined |      365,227 |      326,656 |         38,571 |        10,900 |                     7,576 |

Input totals include repeated context across calls; cached input is a subset. Reasoning is reported as provided, not added again to output. The final sensor used two more tools than the audit run and took 2.382 s longer. The final inclined foot reached the proposed 10-call budget and exceeded the proposed 180 s simple-task target by 68.290 s. Neither single observation establishes a percentile.

## Failure analysis and recovery

### First sensor run: the harness caused avoidable work

The source-only approved seed had no stored STL. Preservation initially required a rendered immediate parent instead of rendering the immutable reference source. The agent wrote an identical continuation to obtain a rendered parent, which could make preservation compare the modification with itself. Separately, diagnostic checks on the historical seed, performed after candidate creation, contaminated the candidate's inherited scope with the old four-hole/Ø2.5 expectations. The final geometry met the requested five-hole/Ø3.4 task, but matching evidence remained `scope_changed`. The final message correctly disclosed that status and the need for human acceptance.

Before the final rerun, preservation was anchored to the approved ancestor/original draft lineage and could render a source-only reference. Evidence now records that reference's revision, input fingerprint and output hash. Scope inheritance includes candidate retries and ancestor checks that existed when the candidate was created, excluding later historical diagnostics. Non-passing verification guidance no longer instructs the agent to report completion. This fixes the discovered causes without weakening the evaluator.

### Final sensor run: correct result, exact baseline preserved

The agent created one draft on the existing artifact. Its first check supplied redundant explicit parameter values, producing passing geometry with `unverified` temporary-variant status. Repeating the identical expectations without overrides bound the check to the committed render and returned `passed`, 20/20. The evidence's preservation revision is the original seed `e76258ba-16d9-4abf-b093-f8a45493fe3c`, not another modified draft. SQLite retained that user-approved selected revision and only its original user-origin baseline event. The final response accurately described passing checks and pending human review.

The evaluated snapshot also left a duplicate source conflict file during normal source materialization. The storage track reproduced this and added an expected-parent-hash fix separately. This run establishes the pre-fix symptom; it does not validate that later fix's live behavior.

### First inclined run: legitimate repair retained the checks

The agent replaced an initial construction after intersection feedback. A subsequent hole check failed roundness (0.969 against 0.97); increasing faceting preserved the expectations and produced 11/11 passing checks with matching `passed` evidence. This was a useful deterministic feedback loop rather than assertion relaxation.

### Final inclined run: correct geometry, changed scope, incomplete final disclosure

The agent corrected an initial orientation error (40 × 20 × 30 instead of 40 × 30 × 20). Its first explicit check then failed two section assertions at `x=20`: “no material in this plane” and ten open chains. The diagnostic mentioned coincident faces/edges and suggested moving the plane. The agent replaced the section with `x=10` and corresponding expected dimensions; all remaining geometric assertions passed. This is a changed check scope, not proof that the previous failed assertions were resolved. The run does not establish whether the first section failure was a geometry issue or a sectioning degeneracy; retain it as a reproduction fixture.

The agent then created a “clean same-geometry draft revision” and rechecked. The monotonic scope guard correctly survived that rewrite. Its final no-override check returned raw **11/11** but **`scope_changed`**, with explicit guidance to restore prior assertions or request human acceptance. Two later inspections did not accept or resolve the scope change.

The final message claimed the inclined hole was verified and reported 11/11 checks, while acknowledging the draft was not approved. It **omitted the blocking scope change**. The numerical check count was true, but the completion account was insufficiently qualified. “Draft, not approved” does not communicate “verification scope changed.” SQLite confirms four agent drafts, no selected baseline and no baseline-change events: the agent did not silently approve its own work. Both final evidence objects passed mandatory mesh integrity checks; that does not override their different verification statuses.

## Required follow-up before agent qualification

1. **Reproduce the inclined section failure deterministically.** Preserve final source and the `x=20`/`x=10` expectations from the retained trace. Determine whether stitching/coplanar handling or the requested outer-profile interpretation caused the open chains. Add an analytic/reference section fixture. Return an explicit diagnostic limitation where appropriate; do not turn an unevaluated section into a pass or weaken the evaluator.
2. **Separate diagnostic probes from accepted verification scope.** Agent-chosen inspection planes are not automatically user requirements. Provide explicit requirement/check identities and a reviewed scope-change path, retaining prior failed evidence. Do not infer equivalence between relocated sections or allow a fresh revision to clear failures. The current human acceptance path is a safe stopgap; this unattended run did not exercise it.
3. **Enforce honest completion independently of prose.** Render final verification state, coverage and scope delta from the exact evidence alongside the agent summary. Add a regression using this trace: `scope_changed` plus raw `pass=true` must remain visibly unverified and cannot become a ready result because the model says “verified.” Preserve the current failing evaluator result until the scope is legitimately resolved.
4. **Remove redundant-override recovery work carefully.** Both final runs spent a check discovering that explicit defaults describe a temporary variant. Improve tool guidance or canonicalize proven-equivalent effective inputs with regression coverage for actual overrides, source changes and changed engine/options. Never equate two inputs merely because their current bounding boxes match.
5. **Rerun the qualification matrix after fixes.** Retain these failures, run repeated seeds on both cases and the complete main/holdout set, then consecutive correction/interruption/resumption workflows. Record engine identity and actual model configuration. Exercise alternate providers and a stronger model only as additional comparisons; do not replace Luna to conceal a harness regression.

No full-suite agent qualification, model independence, cross-provider reliability, long-session recovery, manufacturing readiness or zero-false-completion claim follows from these six runs. The final paired result remains **one qualified artifact out of two**, with both requested geometries satisfying the evaluator's geometric assertions.
