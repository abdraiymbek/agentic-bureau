# Omen Flow 0.2.4 verification record

Date: 22 October 2026 (America/Chicago). Status: **release candidate; not published**.

This record covers release 0.2.4. It answers six findings from the CAD benchmark runs of
21 October 2026 (CADGenBench, BenchCAD and the internal CAD suite with Claude Haiku 5.5): the
agent could not see its part or zoom into a drawing; checks confirmed what the agent asserted,
not what was asked; simple work had too much overhead; there was no STEP export; nothing caught
a small model that stops early; and Claude Code was given model aliases and its own cost figure
was trusted. Before fixing them, overhead and early stopping were checked again on the 0.2.3
host: overhead reproduced (2.6× plain Claude Code's cost per correct part, the "parts" playbook
read in 14 of 15 runs); early stopping did not (8 of 8 drawings delivered a part). Measurements
are in [measurements.md](measurements.md).

## Changes

| Change                         | Intended everyday behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Verification                                                                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. The agent can see its part  | `cad_view` draws the current part as one engineering sheet (front, top and right views at one scale with hidden edges dashed, an isometric view, and cross-sections, by default one through the middle) from the revision's stored mesh, with a pure-Rust rasterizer. `image_view` shows an image in the project whole with a labelled grid, or a region enlarged; PNG and JPEG. Pictures reach the model as MCP image blocks after the reply is shaped; the reply carries their paths. Both are diagnostic and never verification.                                                     | rasterizer, layout, scale, determinism, byte caps and path-safety tests; MCP image block tests including Codex (`structuredContent` left out on picture replies, from codex-rs source); conformance |
| 2. Checks follow the request   | `cad_check` expectations take spec items: one per requested dimension or feature, in the request's words, each with its assertions. Linked requirements contribute items (and, with `features`, their own assertions). An item without an assertion keeps the check `partial`, and `work_status` reports `cad_spec_unasserted` with the call that would assert it. Checks without items or linked requirements behave as before.                                                                                                                                                        | unit, gate, engine and lifecycle tests; conformance; review                                                                                                                                         |
| 3. A leaner CAD path           | The `parts` playbook is now `components` (old names still accepted). The launch brief carries the CAD playbook and a snapshot of the project, so an empty project skips `project_summary`. `cad_write_source`, `cad_patch_source` and `cad_set_param` accept `expect` and check the saved revision in the same call; replies to a committed check carry a `workStatus` digest from the gate. The ledger records the chained check and digest as `alsoRan`, never as agent calls.                                                                                                        | guide, write-and-check (one OpenSCAD run), idempotency and digest tests; CAD suite: median 1 tool call instead of 8                                                                                 |
| 4. STEP export                 | `cad_export` takes `format: "step"` for people (any destination) and agents (only under `exports/`, never over a file an earlier export did not write). With a Python that has OpenCASCADE (`cadquery-ocp-novtk==7.9.3.1.1`) the part is rebuilt from OpenSCAD's CSG tree as analytic surfaces and compared with the render (volume, bounding box, paired surface probes on both shapes); otherwise, or when the comparison fails, a faceted STEP is written in Rust from the render, with coplanar facets merged. The result always says which and why. Mechanical stage: Export STEP. | faceted writer, converter runner, destination and archive-redaction tests; opt-in end-to-end tests with real OCP; corpus below; design preview                                                      |
| 5. Unfinished work is visible  | When a conversation turn ends, Omen Flow records the completion gate over that turn's sessions. A turn that leaves blockers shows "Work not finished" with Continue; one that called no Omen Flow tool says so. Continue resumes the Claude Code conversation (Codex replays the history), and a continuation's own `work_status` covers the turns it continues. Settings → Agents can also continue automatically once per message, for blockers the agent can resolve from the project record (off by default).                                                                       | chat, host and conformance tests; live check below                                                                                                                                                  |
| 6. Full model ids, no CLI cost | Claude Code's models are listed and launched as `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`; saved aliases launch the full id unless model routing is configured anywhere Claude Code reads it, which keeps the alias. The turn header shows the model and warns when the CLI reports another. Omen Flow never stores or shows the CLI's cost figure; evals estimate cost from a dated list-price table.                                                                                                                                          | adapter, routing, pty and chat tests; live check below                                                                                                                                              |
| 7. A judge correction          | The legacy section code (used by the CAD evaluation judge) no longer loses corners when a cut runs through a ring of vertices. This caused the two v-pulley misses reported on 21 October; re-judged, every setup passes the suite.                                                                                                                                                                                                                                                                                                                                                     | regression test; re-judged runs in measurements.md                                                                                                                                                  |

The before-release review (seven reviewers, two independent checks per finding) confirmed 29
findings; all were fixed with tests or documented, and each fix branch was checked again. Among
them: a continuation's own `work_status` covered only its new session; a requirement named by a
committed check could drop out of a later one; export and view jobs pulled parts into the
session's scope; the exact-STEP comparison could miss a lost flat feature; review content
dropped recorded tolerances; the notices lacked the two crates JPEG decoding ships.

## Compatibility and limits

- Application, workspace package and helper versions are 0.2.4. The bundle identifier remains
  `app.omenflow.desktop`.
- Project storage remains schema 1. New fields, event types (`cad.exported`), job kinds
  (`cad_export`), sidecars (`.omenflow/cache/views-v1/`) and checker `omenflow-rust-mesh-checks-v3`
  are additive. Contracts are additive (113 operations); `omenflow call` and `omenflow mcp` keep
  working. The legacy TypeScript oracle refuses the new operations and inputs.
- Going back to 0.2.3 is possible but lossy: 0.2.3 ignores v3 checks and goes by its own newest
  check, treats spec scopes as changed, and drops 0.2.4's conversation fields whenever it saves
  a conversation (see [going back to 0.2.3](../../docs/project-format.md#going-back-to-023)).
- Listing budgets were raised as a recorded decision, for the two new core tools, spec items in
  `cad_check` and `expect` on the writes: TypeScript wire listings 7,000 → 8,500, 66,000 →
  70,000 and 74,000 → 80,000 characters (measured 8,399 / 69,358 / 79,336); Rust model-facing
  7,500 → 8,500, 60,000 → 62,600 and 66,000 → 71,000 (measured 8,399 / 62,063 / 70,469). Compact
  lists 15 tools (was 13), standard 45, full 60. Guidance caps: compact instructions 1,200 → 1,400
  characters, compact brief 1,600 → 4,300 bytes (it now carries the CAD playbook), largest
  compact brief with a snapshot 6,600; the full brief stays under 9,000.
- Without recorded requirements, a check's items are the agent's own reading of the request;
  they become independent of the agent when a person records or approves requirements.
- Exact STEP needs a separately installed Python 3.11–3.14 with `cadquery-ocp-novtk==7.9.3.1.1`
  (OpenCASCADE, LGPL, not shipped). The surface comparison does not see a lost feature shallower
  than its probe offset; [engineering adapters](../../docs/engineering-adapters.md) states the
  rule. Mechanical revisions without OpenSCAD source cannot be drawn or exported as STEP.
- Codex's handling of picture replies was read from its source, not run. Automatic continuation
  and the Claude Code resume path were run once live (below); Codex continuation replays text.
- Agents cannot approve, accept or revert a person's baseline. Approval and engineering
  validity remain separate.
- The macOS app is ad hoc signed and is not notarized. OpenSCAD and agent CLIs are installed
  separately. Automated and packaged smoke results do not establish a native manual walkthrough,
  a clean-machine installation, an upgrade, reduced motion, VoiceOver, or use on a real Linux
  desktop.
- The standalone `videos/` package is outside this release.

## Live checks

In the design preview on the Rust headless host (`OMEN_PREVIEW_AGENTS=1`), with Claude Code
2.1.287 and Claude Haiku 5.5 selected in Settings as `claude-haiku-5-5`:

- A request to save a spacer unchecked ended with "Work not finished · 1 blocker" recorded by
  Omen Flow. The turn record holds `model` and the CLI-reported `resolvedModel`, both
  `claude-haiku-5-5`.
- Continue sent the labelled continuation; the run resumed the same Claude Code conversation
  under a new Omen Flow session. The agent found its own first check had failed on a wrong
  assertion, rewrote the part with `expect` in one call (11 of 11 assertions, committed), and
  the activity rail showed the host-run check and "work_status (this turn and the one it
  continues): ready". The gate recorded after the continuation was ready.
- Settings showed the four full model ids; Export STEP wrote a faceted file without the
  converter and an exact one (26 faces, volume within 0.005 %, 2041 of 2041 probes agreeing)
  with it, and refused with its reason on a fixture part whose mesh is illustrative.

## STEP corpus

The 49 parts Haiku 5.5 delivered for CADGenBench on 21 October (their OpenSCAD source and
rendered STL), exported with the release code and OCP 7.9.3.1 (`cadquery-ocp-novtk==7.9.3.1.1`)
by the opt-in `step_corpus_parity` test:

- 46 exact (B-rep), 4 of them with a hull rebuilt to 0.01 mm and noted; 3 faceted, each with its
  reason: 125 (OpenCASCADE could not rebuild an `offset`), 135 (the rebuilt solid's volume was
  5.8 % off the render) and 141 (one face does not tessellate). The benchmark converter of
  21 October had 47 exact and 2 sewn from the mesh.
- Every exact part is one valid, closed solid. Largest accepted differences from the render:
  volume 0.075 %, bounding box 0.016 mm, 0 render-side probe disagreements, 1 on the solid's own
  faces.
- With the last cutter of the first `difference()` removed from each CSG tree, 49 of 49 were
  refused as exact. With one smaller cutter removed, 41 of 42 were refused; the one accepted
  (part 105) had removed a cutter that cut nothing, so its exact volume was unchanged.
- Export time: median 1.5 s, 90th percentile 16 s, longest 92 s.
- During development every chosen file passed CADGenBench's own `validate_step` (OCP 7.9.3);
  that gate was not run again on the final code.

## Final verification

Local candidate checks from [the release procedure](../../docs/release.md#local-candidate), on
the tree of the release commit (`Prepare Omen Flow 0.2.4`, before this record's results were
added) on macOS arm64 with OpenSCAD 2026.09.18, from a checkout outside the main repository
folder:

| Check                                                             | Result                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release version consistency and dependency-lock review            | passed; workspace/app/helper 0.2.4; lockfiles change only local crate versions plus zune-core and zune-jpeg for JPEG decoding                                                                                                                                        |
| Generated contracts and third-party notices                       | passed                                                                                                                                                                                                                                                               |
| TypeScript typecheck, lint and formatting                         | passed (lint: 0 errors)                                                                                                                                                                                                                                              |
| JavaScript and renderer suites, including engine cases            | 1129 passed across 110 files with real OpenSCAD; no skipped tests                                                                                                                                                                                                    |
| Rust formatting and clippy                                        | passed                                                                                                                                                                                                                                                               |
| Rust workspace suites with OpenSCAD                               | 820 passed, 1 ignored; the ignored real-helper case passed separately. Run from the worktree path: from a longer folder one test's socket path exceeds macOS's 104-byte limit                                                                                        |
| Helper tests                                                      | 13 passed                                                                                                                                                                                                                                                            |
| STEP end-to-end with OCP 7.9.3.1 (`OMENFLOW_STEP_E2E=1`)          | 41 passed, none skipped                                                                                                                                                                                                                                              |
| Rust host conformance suites                                      | 73 passed across 12 files                                                                                                                                                                                                                                            |
| Headless helper smoke                                             | passed read, agent draft and capability refusal                                                                                                                                                                                                                      |
| macOS arm64 build, bundle metadata, signatures and packaged smoke | passed; 0.2.4, `app.omenflow.desktop`; DMG verified with `hdiutil verify`, mounted read-only; ad hoc app and helper signatures valid; packaged smoke passed from the mounted path                                                                                    |
| Linux arm64 build, declared floors and packaged smoke             | passed in about 620 s with `--skip-tests` (the suites ran on the host, above); packages, metadata (version 0.2.4) and floors; .deb on Ubuntu 22.04/24.04 and Debian 12, AppImage on Ubuntu 22.04 without GTK/WebKitGTK, .rpm on Fedora 42, all fresh Xvfb containers |

Package and publication checks (CI on the release commit, the x86_64 release workflow, and the
re-downloaded assets) are recorded after publication.

## Release artifacts

Not published yet.
