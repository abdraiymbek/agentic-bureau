# v0.1 release qualification — 2026-09-20/21

Status: **software candidate ready for the Apple signing handoff on macOS Apple Silicon**. This is an unsigned candidate, not a signed public-release approval. Actual notarization and signed clean-Mac acceptance remain credential-dependent.

The owner clarified that no Apple developer account is available yet. The app
must be ready for signing/notarization when credentials arrive. Actual Apple
acceptance and clean-machine Gatekeeper validation are deferred credential
checks, not reasons to redesign the app or to mislabel an unsigned build.

Baseline: `368c4ed` plus the working-tree release fixes. macOS 26.6.2, Apple
Silicon, Node 24.19.0, pnpm 9.15.9, OpenSCAD 2026.09.18, Codex CLI 0.154.0.
Model evaluation stays on GPT-5.6 Luna / high / ignore-user-config. No stronger
model is substituted for the capability gate. Rust stable 1.98.1 was installed
through the repository toolchain configuration.

## Fixes made during qualification

- Bundle an actual standalone mesh worker. Worker failure is a structured error,
  never a hidden synchronous fallback. CAD checks and preservation comparisons
  run through the cancellable worker; cancelled checks cannot record evidence.
- Repair the Rust helper's compilation and EOF lifecycle. Either side closing
  terminates the pump even when the other side is blocked; integration tests
  exercise both closure directions and a real framed call.
- Make the packaged smoke exercise the shipped mesh worker, calculation worker,
  bridge, real OpenSCAD and final persisted CAD verification. Repair the broken
  `smoke:bridge` command. Isolate Chromium user data as well as core app data.
- Add explicit `ready` and lead with unresolved verification in CAD responses.
  Preserve legacy raw `pass` semantics and the committed-scope guard. The guide
  now trials complete request-derived assertions before committing them.
- Reject source winding defects even when the display mesh was normalized. Carry the original winding flag through stored renders and caches; re-render older entries that lack it. Checker v4 retires earlier evidence and requires the exact stored output hash as well as input identity.
- Keep source preparation, geometry inspection, sections and probe work off the core event loop. Make OpenSCAD discovery asynchronous and preserve cancellation before process spawn.
- Release WebGL contexts when leaving a viewport, and package every vendored font on the app origin so the production CSP can load it.
- Preserve saved project names in the launcher without opening/migrating each
  project database. Replay current service availability when a renderer reloads.
- Bound graph-impact command pages to 32 KiB, retain total count and pagination,
  build path explanations only for returned rows, and expose remaining results
  in requirement impact previews.
- Add credential-gated signing/notarization configuration, minimal hardened
  runtime entitlement, configuration tests and `pnpm release:macos`. See
  [the account handoff](../../docs/release.md). This path is configured but has
  not submitted anything to Apple without credentials.

## Native acceptance observed

Disposable data only: `/tmp/omen-v01-readiness/native-project` and
`native-appdata`. GUI testing used native accessibility controls after the
installed `scu` command failed to import its Python module.

The development build completed the full real CLI/review loop: create a
60 x 40 x 5 mm plate with four diameter-4 holes at (+/-20, +/-10), inspect the
unapproved candidate, accept its exact scope and baseline; change holes to 6;
request 5.5 through a saved review decision; resume the agent from that decision;
inspect its replacement proposal; approve scope and revision 3. The old proposal
was explicitly superseded, the queue emptied, revision 3 became the default,
and terminal history restored after a renderer reload. Quitting with a live
idle CLI left no owned app/CLI processes.

The rebuilt packaged app then reopened that project, displayed its actual saved
name and selected approved revision 3, exported its build and archive, imported
the archive through the native file picker into a clean directory, preserved
identity/decisions/baseline, and re-rendered the imported part. The rerender
created an explicit unapproved revision 4; it did not replace the approved
baseline. The exported source independently re-rendered to the same 1,052
triangles (canonical vertex coordinates to four decimals) as the exported STL;
all file hashes matched the manifest. Verification in that manifest was bound
to the approved revision and retained its scope and limitations.

Force-killing the packaged core utility displayed the recovery message. A
renderer reload retained the service-offline message and returned an immediate
structured command failure instead of hanging. App quit left no owned processes.
These observations do not claim exhaustive power-loss injection at every
instruction boundary or fresh-machine upgrade qualification.

## Measurements

The final native reference contains 500 artifacts and 99,852 triangles. Two
60-second samples around 100 native Overview/Design files switches measured
666.6 MiB before and 688.5 MiB after: **21.9 MiB retained**, below the 100 MiB
allowance. Mean desktop CPU was 0.00% before and 0.13% after. Each switch verified
the mesh remounted and displayed. This measures viewport loads, not 100 OpenSCAD
renders or 100 full project closes. Summed RSS includes shared pages; external
provider processes are excluded.

The first repetition exposed blocked small font assets and retained WebGL
contexts. After fixing them, 100 repeated loads produced **zero console errors
or warnings**, and both Geist and IBM Plex Mono loaded. Native orbit gestures and
keyboard navigation worked. A separate sustained redraw benchmark ran the live
renderer for 60 warmup + 300 measured frames, with WebGL2 `finish()` after each
draw: frame interval p50 16.7 / p95 17.6 / max 17.7 ms; GPU-completed draw p95
0.5 ms. This is measured redraw throughput, plus separate native interaction
validation; it is not a p95 distribution of human gestures.

Ten fresh-user-data packaged launches all passed bridge/calculation smoke. Spawn-to-bridge readiness was p50 203.9 / p95 316.5 ms with the OS file cache warm. This is not first-paint or cold-disk startup timing.

Thirty samples each on the same 500-artifact fixture, using the source core:

| Operation                  | p50      | p95      | Maximum 5 ms timer gap |
| -------------------------- | -------- | -------- | ---------------------- |
| Artifact read              | 0.207 ms | 0.333 ms | 6.02 ms                |
| Search                     | 0.607 ms | 1.104 ms | 6.47 ms                |
| 99,852-triangle inspection | 552.0 ms | 577.2 ms | 9.29 ms                |

The real large-model write/check/inspect fixture also measured maximum timer
gaps of 34.1 / 16.7 / 8.5 ms. Before asynchronous discovery, the first write had
a 385.6 ms stall; that failed measurement drove the fix. These measurements
include scheduling contention and do not claim a universal hard latency bound.

Thirty 2,000-node graph samples: p50 3.931 / p95 5.922 ms, 32,248-byte default
JSON page. Paging tests reach all 1,999 dependents exactly once. A root edit takes
354 ms and marks every dependent stale. This full write is distinct from the
impact query and still persists complete path explanations.

The earlier small-project samples (557.4 MiB overview / 575.1 MiB viewport,
0.0033% mean CPU) and export equivalence remain in `evidence/`. Reproduction:
`measure-heavy.ts`, `measure-commands.ts`, and `../execution/measure-idle.py`.

## Evaluation integrity

Early campaigns and failures remain under `/tmp/omen-v01-readiness`. The first
feedback revision made unresolved scope explicit, but 5 of its first 12 completed
runs still failed final readiness after mistaken committed assertions. That
campaign was stopped once it could no longer reach 95% over its planned 60 runs;
interrupted in-flight runs are not counted as passes. Geometry correctness did
not rescue their failed readiness. All five targeted regressions then passed
with the trial-before-commit guide. The original holdout has now informed fixes
and must be described as regression coverage, not a newly unseen holdout.

The qualified campaign completed **45/45 main + 15/15 former-holdout runs**.
All 60 provider-delivered sources and parameter sets were then copied and
re-rendered as new candidate revisions under the final binary-STL adapter and
checker v4: **60/60 independent geometry and matching-evidence checks pass**.
The original sources, revisions and selected baselines remain intact. This is
60 original provider deliveries plus final deterministic revalidation, not a
claim of 60 fresh provider turns after every implementation change.

The repeated workflow campaign completed **30/30** across ten scenarios with
two provider turns and a closed/reopened project between turns. Six results are
correct, explicit human scope-review escalations after changed requirements or
reviewer corrections; 24 deliver verified geometry. Every case preserves the
selected baseline and unrelated work. Copies of all 30 final deliveries also pass fresh checker-v4 revalidation: the same 24 passes and six scope-review escalations, with sources, parameters and selected baselines unchanged. All provider workflows stay inside the predeclared 420-second,
20-CAD-call combined budget (p50 113.7 / p95 214.3 / max 215.9 seconds).

Additional complex-task confirmation deliberately remained separate and exposed
two further failures: one source with inverted winding that had been normalized
for display (11/12 campaign), then one bore with an incorrectly signed normal
(2/3 winding regression). Neither failed campaign is relabeled as passed. The
first required a mandatory source-integrity guard and checker v4; the second
required general plane-normal, tangent-dot-product and oblique-section guidance.
The final normal regression passes **3/3**, with independent source re-renders,
correct bore direction and matching persisted verification. It is recorded
separately in `evidence/agent-campaigns.json`. These are new provider runs with
the final guide; they do not erase either earlier failing campaign.

The initial 180-second target held for 53/60 qualified runs; CAD calls were at
most nine. Times were p50 90.1 / p95 207.1 / max 258.8 seconds, with up to four
concurrent providers. A documented five-minute target for four complex families
was subsequently tested; it did **not** hold universally (the later inclined
regression includes a 318-second correct delivery and a 364-second incorrect
one). The final three correct normal regressions took 225.8, 273.1 and 447.6 seconds; one used 11 CAD calls. The last run spent time investigating an optional triangle-intersection diagnostic on the inclined boolean boundary. Such mesh diagnostics have limited coverage and are not exact-solid certification. Do not advertise a three- or five-minute completion guarantee or a ten-call guarantee. For v0.1,
these remain reported model/network latency and call-count targets; correctness, explicit
failure, preserved work and bounded execution are the release gates. A slow or
incorrect model run cannot be relabeled as a correct run to satisfy a target.

## Automated and remote checks

- Full local suite: **287/287 tests in 37 files**, real OpenSCAD enabled, no skips.
- Workspace and evaluator typecheck pass; formatting passes; lint has zero errors
  and 53 pre-existing warnings.
- Rust format, clippy with warnings denied, and three bridge integration tests pass.
- Bridge smoke passes; local final packaged smoke exercises the standalone mesh
  worker, bridge, calculation worker, real OpenSCAD and persisted CAD verification.
- Production dependency audit reports no known vulnerabilities. The full development-toolchain audit reports 25 advisories in eight test/dev-server/packaging packages; none is present as a package in the shipped archive. These remain toolchain maintenance findings, not a claim of a clean repository-wide audit. See `evidence/toolchain-audit.json`; v0.1 does not expose a Vite/Vitest server or process user archives with those build tools.
- CI tests Ubuntu TypeScript/lint/tests, pinned OpenSCAD 2021.01 geometry,
  Rust, macOS packaging/smoke, and experimental Windows packaging/smoke.

The pinned Linux engine exposed a cavity-containment bug: duplicate ray hits on
shared triangle edges could count one surface crossing multiple times. Distinct
crossings are now counted once; 64 triangulation patterns and a thin-wall test
cover the correction. Analytic tests and the adapter use binary STL to avoid the
older ASCII exporter's six-digit rounding. No geometric tolerance was loosened.

Windows packaging required an explicit locked `lodash` build input and direct
Node invocation of the Vite CLI. Its smoke then exposed a named-pipe path used as
a filesystem directory. The credential file now uses the app-data run directory.
The Windows smoke's per-step error suppression was removed so a failed smoke
shows a failed experimental job. A packaged CI pass still does not qualify the
Windows native product for public v0.1.

## Release scope and remaining credential checks

v0.1 qualification targets **macOS Apple Silicon**, self-contained deterministic
OpenSCAD parts with millimetre model coordinates, the existing human-review
workflow, and the recorded Codex CLI/Luna High configuration. Other providers
and Intel/Windows/Linux desktop installations are not covered by this native
acceptance. Calculations remain explicitly experimental; research/browser agent
operations remain excluded from the stable capability profile. No engineering
safety certification, request-completeness guarantee, exact-solid CAD guarantee,
or hostile-agent isolation is implied by a declared-check pass.

The planning document's broader optimization targets remain visible: there is no
instrumented ten-launch cold-start/first-paint p95 claim, no exhaustive power-loss
injection at every instruction, and no universal 32 KiB response guarantee.
Summaries honor their advertised budget and graph-impact pages are byte-bounded;
explicit artifact/file reads retain the compatible 8 MiB transport ceiling.
The native scale reference is 500 artifacts / approximately 100k triangles, not
a promise of unrestricted project or assembly size. These limits are not silently
counted as passed benchmarks.

There is only schema version 1 at this first release, so an older publicly
supported schema migration matrix is not applicable. Newer-version read-only
protection, WAL snapshots, interrupted journal recovery, archive containment,
privacy and review rollback have automated coverage. Installation/upgrade with
actual Apple signatures, notarization tickets and Gatekeeper remain the account
handoff: see [release commands](../../docs/release.md). The signing configuration
and fail-fast pipeline are implemented; actual Apple acceptance cannot be
claimed before the credentials and final clean-Mac check exist.

Current application CI: [all platform jobs](https://github.com/abdraiymbek/stark_harness/actions/runs/35556271421) passed, including the Windows smoke without per-step suppression. The final guide/evidence commit is checked on [PR #7](https://github.com/abdraiymbek/stark_harness/pull/7). Package sizes and SHA-256 hashes are in `evidence/packages.json`; both distributables remain unsigned. The credential-free release command correctly refuses to proceed without both signing inputs.
