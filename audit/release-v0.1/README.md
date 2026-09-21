# v0.1 release qualification — 2026-09-20/21

Status: **qualification in progress; not yet a release approval**.

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

- Sixty seconds settled overview: 0.0033% mean CPU, maximum summed RSS 557.4 MiB.
- Sixty seconds stationary plate viewport: 0.0033% mean CPU, maximum summed RSS
  575.1 MiB. No live CLI/render inside the sampled desktop tree. External model
  evaluation processes are excluded. This is a small native project, not the
  required 500-artifact / 100k-triangle memory or frame-time qualification.
- Thirty 2,000-node graph command samples: p50 3.931 ms / p95 5.922 ms, 32,248-byte
  default JSON page. Paging regression reaches all 1,999 dependents exactly once.
  A single root edit takes 354 ms and correctly marks all dependents stale.
  Full-path stale persistence and other synchronous work still need their own
  latency qualification; this does not establish a general 100 ms stall bound.

See the JSON in `evidence/`; summed process RSS includes shared pages. The graph
measurement script and complete output remain under `audit/execution`.

## Evaluation integrity

Early campaigns and failures remain under `/tmp/omen-v01-readiness`. The first
feedback revision made unresolved scope explicit, but 5 of its first 12 completed
runs still failed final readiness after mistaken committed assertions. That
campaign was stopped once it could no longer reach 95% over its planned 60 runs;
interrupted in-flight runs are not counted as passes. Geometry correctness did
not rescue their failed readiness. All five targeted regressions then passed
with the trial-before-commit guide. The original holdout has now informed fixes
and must be described as regression coverage, not a newly unseen holdout.

The `qualified-main` and `qualified-holdout` campaigns rerun every task three
times. Three disjoint main-suite shards and one holdout process share the machine;
record latency with that concurrency caveat. Their final results, false-completion
review, tool budgets and outstanding multi-step/performance gates must be added
before declaring release readiness. The evaluator now exits nonzero on any
failed collected run; no oracle or tolerance was relaxed.
