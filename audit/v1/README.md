# V1 readiness record — 14 October 2026

Status: **V1 working tree, verified by automated suites, a fresh-eyes QA pass and an adversarial
review on the Rust headless host, and a first live-model measurement of the agent layer.
Unsigned. The release bundle was built and passed the packaged smoke; the native interface was not walked through by hand. Not a release.**

V1 makes three things true, and this record says how far each was checked:

1. The shipped Rust path is the tested path: one `Host` serves the Tauri app, a headless
   loopback server and agents.
2. The agent layer adapts to the model: a session-fixed capability profile (`compact`,
   `standard`, `full`) shapes tools, schemas, guidance, results and errors, with the same
   verification rules in every profile.
3. The interface shows what the agent actually did, decisions can be trusted, and edits are
   never silently lost.

Storage stays schema 1 (additive changes only; see [project format](../../docs/project-format.md)).
The package version is 1.0.0 and the bundle identifier `app.omenflow.desktop` (`tauri.conf.json`);
builds before 1.0 were 0.1.0 with the identifier `com.electron.omen-flow`. On its first start 1.0
copies `settings.json`, `reservations.json` and `window-state.json` from the earlier identifier's
data folder, and settings from the Electron app's `@omenflow/desktop`, without overwriting what it
has already written and leaving the old files in place; interface preferences kept in the
webview's own storage start fresh, because that storage is keyed by the identifier
([release](../../docs/release.md#apple-signing-handoff)). The final macOS bundle and DMG
(`Omen Flow_1.0.0_aarch64.dmg`) carry 1.0.0, `app.omenflow.desktop` and macOS 13.3; the
earlier 0.1.0 DMG mentioned below was replaced.

## What changed

### Hosts

- `crates/agent-host` gained `Host`: the user-origin command router (moved out of the Tauri
  shell) behind `EventSink`, `Shell` and `ResearchSurface`. A panic in a command now answers
  `INTERNAL` and recovers the core lock, where the invoke used to never settle.
- `apps/headless` is new: `omenflow-host`, the same `Host` over loopback HTTP and server-sent
  events with a bearer token, `Host` and `Origin` checks and size caps. It backs the design
  preview, the conformance suite, the fixtures, `pnpm smoke:headless` and the evaluations;
  `POST /api/agent/launch` returns the exact launch plan a terminal session would get.
- `apps/rust-desktop` is a thin implementation of the traits: the main window is created from
  its config behind a navigation guard, startup failures show a dialog, window state is stored
  and restored in the window system's own coordinates (points on macOS) onto an existing
  display, Quit and closing the window ask while an agent runs, one app runs per data
  directory, and the research webview is hidden for agent loads with bounded extraction and DNS
  checks off the interface thread.
- `omenflow_core::dispatch_shared` releases the core lock while OpenSCAD runs: plan under the
  lock, render and measure without it, commit under it. Each event is delivered once, with
  `projectId`, through a per-project cursor; agent events carry `data.sessionId`, including
  events of a render that was queued in the background.
- The design preview prints an address with a one-time key that the page trades for an
  HttpOnly, same-site cookie; every preview endpoint requires it. Terminals and agent settings
  are refused unless the preview was started with `OMEN_PREVIEW_AGENTS=1`, and its data folder
  is removed when it stops.

### Contracts and the agent layer

- Every registry operation carries `tier`, `pack`, `summary`, `example` and an optional compact
  schema. 106 operations; 57 agent tools (13 core, 30 standard, 14 full). New operations:
  `work.status` (the completion gate), `project.coverage`, `guide.read`, `tool.call`,
  `agent.activity`, `graph.remove_edges`.
- Profiles are fixed on the session grant and resolved from an explicit setting or the model
  id. Agent input goes through lossless, reported repairs; unknown keys are refused with the
  allowed keys and the nearest one. Results are capped per profile (6,000 / 16,000 / 32,000
  characters) with an explicit `truncated` marker; a list cut inside an artifact's content is
  replaced by a visible stand-in that cannot be saved back, and `artifact_read` returns its
  revision whole. Ten playbooks (at most 2,400 characters each) are served by `guide_read`.
- Every agent call is recorded at one funnel (`dispatch_agent`) in a ledger without arguments,
  persisted to `.omenflow/work/<session>/calls.jsonl` and `session.json`, and delivered live
  (`omenflow:agent:call`, SSE `agent-call`). Stored error messages never quote the values a
  call sent, and the ledger follows a project folder that moved.
- Adapters are data: Codex CLI and Claude Code verified against the installed CLIs; OpenCode,
  Gemini CLI and Qwen Code documented only; a Custom CLI. `connection.test` makes real round
  trips through the helper; `connection.list` reports a custom adapter's saved arguments (never
  its environment). Only the Custom CLI gets a bounded `AGENTS.md` block; the old unbounded
  guide is removed by its markers.
- The `omenflow` helper takes either tool-name form, prints compact results and one-line
  errors with their repair, and adds `guide` and `status`.

### Core

- **Review and history.** Approval is refused with `REVISION_CONFLICT` when the baseline moved
  since the change was drafted (the proposal stays pending; `baseMoved` on every change); a
  newer proposal covering the same objects supersedes the old one, and accepting a draft that
  already contains a proposal's candidate answers that proposal (`superseded`,
  `impact.answeredByRevisionId`). An update that names no revision continues the open draft;
  a draft that a new revision retires is named in `warnings`. Request changes keeps the
  reviewer's text; stale propagation shares the approval's transaction and is reconciled when a
  project opens; mutations are atomic; idempotency never keeps a failure; working-file write
  failures after a commit are warnings; a BOM edit no longer moves its anchor component's
  baseline, and `bom.changed` is announced only for an approval that touched the bill of
  materials.
- **Read side.** `work.status` with 13 kinds of outstanding work and a `next` call for each;
  `project.coverage` with verdicts only from recorded test results, where a calculation counts
  only when the engine reproduces its recorded result and a link an agent drew does not make
  evidence current; `project.summary` v2 with `activeWork` and `next`; set-based
  `artifact.list` that pages instead of silently capping; `project.search` with fallbacks;
  `NOT_FOUND` with repairs; brief reads for agents.
- **CAD.** Engine discovery and process control, a render cache with in-flight sharing, a
  parameter scanner, short-form expectations and `autoCommit`, one verification state machine
  shared by `cad_check`, `work_status` and proposals (which now return the committed
  expectations an agent must restore), meshes up to 600,000 triangles, checker
  `omenflow-rust-mesh-checks-v2`. A render identity is kept only when a render job of this core
  produced it.
- **Engineering.** One units module (26 units added); units an agent writes are symbols, a
  spelled-out unit with one meaning is converted and reported, anything else is refused. A
  rewritten calculation engine whose result unit never borrows the first input's, template
  inputs that default to 1 as a recorded assumption instead of inviting a guess, BOM totals
  that list each unknown with its reason, results recorded by a person versus an agent (a
  person's result carries an open agent draft forward), wiring ids assigned by the server and
  fewer false findings, structured build issues, agent exports only inside the project, and a
  three-call parts flow.

### Renderer

Styles split by surface; new kit primitives (`Tooltip`, `ConfirmButton`, `Menu`, `Checkbox`,
`QuantityField`, `Skeleton`, `ErrorBoundary`); the `LENSES` registry and the **Evidence** lens
(`⌘5`); a flow map renderer of its own (layout, routing, fit, detail levels, keyboard model)
replacing React Flow; the agent surface (session bar, activity rail from the ledger,
onboarding states, one ask queue, docking window); decisions with phases (base moved, waiting
on the agent, superseded), a single approval guard and a done state; an object edit model that
holds edits apart from incoming data; one unsaved-work prompt for every navigation; viewport
tools. The entry chunk is 445.98 kB in the final build, and the renderer no longer imports the
contracts runtime. Details: [design specification](../../design-system/design.md) and
[design verification](../../design-system/verification.md).

### Repository

The dead Electron shell (17 files) and 29 desktop dependencies were removed (lockfile 981 → 508
packages). CI (`.github/workflows/ci.yml`) defines TypeScript, Rust (macOS with OpenSCAD, Ubuntu
without), helper, conformance, macOS package, legacy CAD and experimental Windows package jobs;
none of them has run for V1. The documents were rewritten for V1.

## Automated verification

Final run, after the review fixes, between 09:18 and 09:36 UTC on 14 October 2026, macOS arm64,
Node 24.19.0, pnpm 9.15.9, Rust 1.98.1, OpenSCAD 2026.09.18 at `/opt/homebrew/bin/openscad`. The
load average was 11 at the start and 30 when the suites finished, from unrelated jobs. Each
count is copied from the command's output. The suites ran one after another.

| Command                                                                 | Result                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cargo test --workspace --locked --no-fail-fast`                        | Exit 0. **544 passed, 1 ignored**: agent host 127 + 1 ignored, `host_render_lock` 1, contracts 51, core 304, headless library 14, `omenflow-host` binary 3, `apps/headless/tests/binary.rs` 5, `apps/headless/tests/server.rs` 11, desktop shell 19, storage 9. No skip variable was set, so the engine tests required OpenSCAD and passed |
| `cargo clippy --workspace --all-targets --locked -- -D warnings`        | Exit 0                                                                                                                                                                                                                                                                                                                                     |
| `cargo fmt --all -- --check`                                            | Exit 0                                                                                                                                                                                                                                                                                                                                     |
| `cargo test -p omenflow-agent-host --locked -- --ignored`               | 1 passed (the real-helper round trip, after `pnpm build:bridge`)                                                                                                                                                                                                                                                                           |
| `cargo test --manifest-path native/omenflow-bridge/Cargo.toml --locked` | 13 passed                                                                                                                                                                                                                                                                                                                                  |
| `pnpm contracts:check`                                                  | “crates/contracts/registry.json matches the TypeScript contracts”                                                                                                                                                                                                                                                                          |
| `pnpm test`                                                             | Exit 0. **91 files, 967 passed, 2 skipped** (the two real-engine cases gated by `OMENFLOW_OPENSCAD_E2E`). No calculation timeouts in this run                                                                                                                                                                                              |
| `pnpm test:conformance`                                                 | Exit 0. **4 files, 52 tests passed**, one of them an expected failure (`it.fails`: the archive has no readable per-artifact views)                                                                                                                                                                                                         |
| `pnpm exec vitest run tests/frontend tests/terminal-restore.test.ts`    | Exit 0. **52 files, 616 passed** (renderer)                                                                                                                                                                                                                                                                                                |
| `pnpm typecheck`                                                        | Exit 0                                                                                                                                                                                                                                                                                                                                     |
| `pnpm lint`                                                             | Exit 0. 0 errors, 123 warnings (in `tests/`, the evaluation harness, `audit/pre-release`, legacy packages and fixtures; none under `apps/desktop`)                                                                                                                                                                                         |
| `pnpm --filter @omenflow/desktop build:rust-ui`                         | Built. Entry chunk 445.98 kB (gzip 138.60 kB); three.js 499.75 kB and xterm 331.26 kB load separately                                                                                                                                                                                                                                      |
| `pnpm format:check`                                                     | Exit 0 at 09:27 UTC, before these documents were edited, and at 09:36 UTC after                                                                                                                                                                                                                                                            |

The tool listings measured by `listing_sizes_stay_within_their_budgets` (agent host, run with
`--nocapture`): what a client forwards to the model is 6,290 characters for compact, 57,288 for
standard and 64,010 for full; with `title` and `annotations`, `tools/list` is 7,978, 62,936 and
71,486 characters.

## Other checks run for this record

Between 09:23 and 09:27 UTC, after the suites:

- `cargo run -p omenflow-headless --bin omenflow-host -- --app-data <temp>`: printed its port,
  token and socket; `GET /api/health` with the token 200, without it 401, with an `Origin`
  header 403, with `Host: evil.example` 403; `connection.list` through `POST /api/command`
  listed six adapters, each with an `args` field; `POST /api/shutdown` stopped it.
- `pnpm smoke:headless`: “helper round trip passed (read, agent draft, refusal)”, “Headless
  smoke passed”.
- `pnpm fixture:rover <temp>`: built on the Rust host, “proposals approved: 10”, 26 artifacts;
  the folder had the layout in [project format](../../docs/project-format.md), marker version 1,
  `meta` `schema_version` 1, and the 15 schema 1 tables plus the FTS5 tables. The project's
  `README.md` now describes what the folder holds.
- `OMEN_PREVIEW_PORT=5199 pnpm design:preview`: it printed an address with a key and “Terminals
  are off”. Without the cookie the bootstrap and the command endpoint answered 403; the key
  answered 303 with the cookie and the address without the key; with the cookie a cross-origin
  bootstrap was 403 and the gallery 200. Through the preview proxy: `artifact.list` 26
  artifacts, `project.coverage` (2 requirements: 1 partly covered, 1 with no evidence),
  `work.status` (project scope, ready, “1 draft is not submitted for review. 1 proposal awaits
  the human's decision.”), `guide.read` for `cad` (2,102 characters, 10 topics), the
  `tool.describe` catalogue (57 tools: 13 core, 30 standard, 14 full), `agent.activity` (no
  calls), and `terminal.start` refused with `PREVIEW`. SIGTERM released the port and the
  preview removed its data folder (“Removed the disposable project data at …”).

From the earlier pass (06:24 to 06:28 UTC), not repeated: `pnpm release:macos` without
credentials stopped before building with “Run on macOS with OMENFLOW_SIGNING_IDENTITY and
OMENFLOW_NOTARIZE_PROFILE.”, and `pnpm install --frozen-lockfile` reported the lockfile up to
date.

The browser walkthroughs of the interface on the Rust headless host, the integration pass and
the QA pass, are recorded in [design verification](../../design-system/verification.md).

### Final gate and the release bundle

Run once more by the orchestrator after this record was written, one command after another,
from a quiet machine: `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm format:check`,
`pnpm contracts:check`, `pnpm test` (91 files, 967 passed, 2 skipped),
`cargo test --workspace --locked --no-fail-fast` (544 passed, 0 failed, 1 ignored),
`cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo fmt --all -- --check`,
the bridge crate's 13 tests, `pnpm test:conformance` (4 files, 52 tests) and
`pnpm smoke:headless` all exited 0.

`pnpm build:rust` compiled the release binaries and bundled
`target/release/bundle/macos/Omen Flow.app`, then failed at the DMG step: `bundle_dmg.sh`
timed out driving Finder through AppleScript (`AppleEvent timed out (-1712)`, reproduced by
running the script directly), because the session could not grant Finder automation.
`CI=true pnpm make` skips that layout step: it produced `Omen Flow_0.1.0_aarch64.dmg`
(9.2 MB) holding the app and an Applications link, with `LSMinimumSystemVersion` 13.3 after
the minimum was set in `tauri.conf.json` (it said 10.13, below what the renderer's WebKit
target needs). The packaged smoke passed against the app inside the mounted DMG. Launched from
the bundle with scratch app data, the app showed one on-screen 1440 × 900 window (listed
through the window server; its contents were not captured, because the session has no screen
recording permission). The bundle is ad-hoc signed only: `spctl` rejects it, so other Macs will
refuse it until it is signed with a Developer ID and notarized. The release script now signs the
bundled helper before the app; that order was checked with an ad-hoc identity and the hardened
runtime (`codesign --verify --deep --strict` valid, packaged smoke passed), not with Apple
credentials.

`pnpm smoke:packaged` then launched that bundle with a scratch app-data directory: “helper
round trip passed (read, agent draft, refusal)”, “Rust bundle smoke passed”. This proves the
bundled helper and the authenticated bridge of the release app, not the interface: the native
window was not inspected by hand.

Not run: `pnpm dev` (opens the native app for manual testing), `pnpm eval:cad` and
`pnpm eval:workflows` (legacy stack, model credits). CI has not been executed for V1.

## QA pass

A fresh-eyes QA pass walked every surface in the design specification on the Rust-backed
preview, with a real `/bin/zsh -i` session in the Agent tab driving the bundled helper end to
end (status, guide, reads, a repaired key, a refused key, an agent draft and proposal). Every
count on the agent surface matched the ledger. It found 22 problems: 15 were fixed in the pass,
one partly, and six were left with owners; the review fix tracks below closed those seven. The
one Rust fix: a session the person stopped recorded exit code 1, because the PTY library
reports code 1 for any process ended by a signal; the host now records an exit code only for a
process that exited with one. Findings, fixes and what was not covered are in
[design verification](../../design-system/verification.md#qa-pass).

## Adversarial review

After the QA pass the merged tree was reviewed adversarially, looking hardest at the seams
between the tracks. 35 findings were confirmed, 24 in the Rust core, agent host, shell and
scripts and 11 in the renderer, and all 35 were fixed, each with a regression test. The fix
tracks also closed the follow-ups the QA pass and the evaluation had left open. The fix tracks
report that each new test fails without its fix: by reverting the fix for the event-session,
check-order, scope-binding and same-title tests, the two terminal tests and renderer findings 1
to 4, and by construction for the rest (they assert fields or outcomes the old code did not
produce). The suites above include every one of them.

**Evidence and verification.** Nothing counts as evidence that did not happen:

- A calculation counts as run only when the engine reproduces its recorded result from the
  recorded formula or template and inputs. A typed result is `calculation_not_run` in
  `work_status` and `no_result` with `computed: false` in coverage, and a calculation payload
  no longer defaults its `evidenceKind` to `calculated`.
- A link an agent drew never makes evidence current: coverage reports it as `draft` with
  `linkReviewed: false` and says it is “linked by an agent and not reviewed”.
- The gate counts a cited source only when the project holds that source artifact.
- A render identity supplied with a draft is kept only when it names a succeeded render job of
  this project with the same source, parameters and output; otherwise every derived output is
  removed.
- The check committed last decides, whatever order checks were asked in; a check that ended
  before measuring binds no scope; a part checked against older revisions of its inputs is
  reported for rebuilding, not rechecking.

**Review and history.**

- An update naming no revision continues the open draft instead of starting a second line, and
  a draft a new revision retires is named in `warnings`.
- Accepting a draft built on a proposal answers that proposal (`superseded`); a proposal part of
  which is already in the baseline still approves.
- A person's result on an approved test with an open agent draft carries that draft onto the new
  baseline (`carriedDraft`).
- Two new parts with one title written at once are both saved.
- A render queued in the background records its events for the session that asked.
- Found while verifying: committing a CAD result opened a deferred transaction that failed at
  once with “database is locked” when the interface committed in between (the cause of an
  intermittent core test failure); it now begins `IMMEDIATE`.

**Agent presentation and ledger.**

- `artifact_read` returns its revision whole; a list or text cut anywhere else inside content
  becomes a visible `{omitted, shown, total, …}` stand-in that fails validation if saved back.
- A cut page continues after the last item shown (`nextOffset`, `nextCursor`).
- The standard profile lists slim full schemas, not the compact overlays.
- The ledger follows a moved project folder and never re-creates a deleted `.omenflow`; stored
  messages never quote what the call sent, and artifact ids are kept only when they are ids.
- An agent can export a build package only inside the project (`PATH_OUTSIDE_PROJECT`, checked
  before any work).

**Hosts and processes.**

- Stop waits for the CLI and its whole process group, and kills what is left at the deadline.
- Scrollback is cut on a character boundary; session locks recover from a panic.
- The design preview's key, cookie and terminal opt-in described above.
- A relative data folder is made absolute before the bridge socket is named; the connection test
  runs the helper in the project folder.
- Window placement uses the window system's own space (points on macOS).
- On Windows each data folder has its own bridge pipe (name derivation unit-tested only).

**Renderer.**

1. **Paste now** never presses Enter: until the CLI turns bracketed paste on, line breaks become
   spaces (tested against the real xterm).
2. A live event that arrives before the first read of the event record no longer hides the
   history before it.
3. The leave guard discards edits only once the move is certain: a cancelled folder pick, a
   failed open, choosing to stay, or a failed close keep them.
4. Side effects of a live event the record had already returned (a BOM refresh, a rename) run
   once.
5. CAD parameter overrides are sent in the model's units (lengths in mm, angles in deg); a unit
   with no model unit is refused instead of being sent as mm.
6. A calculation re-run that recorded nothing says so instead of “waiting for review”.
7. A proposal that changes only a bill of materials says the baseline stays where it is.
8. The geometry gate applies to approval only; reject and request changes stay available.
9. Approve waits until the candidate mesh has been shown in the viewport.
10. A one-sided bound (only a minimum or only a maximum) is kept and shown.
11. An unknown target without a reason is no longer erased on save; the requirement stage has a
    “The target is unknown” choice.

**Follow-ups closed.** From the evaluation: the committed expectations are returned in
`scope_changed` replies (`committedExpect`) and in the gate's `next.args.expect`; agent units
are symbols or refused (`INVALID_UNITS` with the path); `battery_energy.usable_fraction` and
`power_budget.margin` default to 1 as a recorded assumption, with no “e.g.” values;
`project_summary.next` suggests `guide_read` only for an empty project. From QA: the core emits
`bom.changed` only when an approval touched the bill of materials (the Timeline keeps its
filter for events earlier builds recorded); `connection.list` reports a custom adapter's
arguments and Settings shows them; the preview removes its data folder, and the Endurance
acceptance text matches its 45 min target; a closing menu or dialog no longer holds the
keyboard; starters are hidden once something was typed or pasted; an agent window that was
never placed sits above the map foot and the decision bar; pinned calculation inputs name their
revision as `rN`.

## Agent evaluation

The first measurement of the agent layer on the shipped Rust path is
[`evals/agent/results/2026-10-14-v1-matrix.md`](../../evals/agent/results/2026-10-14-v1-matrix.md):
release `omenflow-host` and helper built from this tree, Claude Code 2.1.287 (haiku, sonnet,
opus) and Codex CLI 0.156.1 (gpt-6-luna, gpt-6-astra) driven through the host's own headless
launch plan, four tasks (requirements, a CAD plate, a calculation, finish discipline), and
every result judged from recorded project state. The judges were checked first with scripted
good and bad sessions, and again on the final host build. One run per cell, so each number is
one observation, not a rate. Claude Code spend was 2.12 USD for the first pass and 0.35 USD for
the re-runs; Codex reports no cost.

- **First pass: 14 of 18 cells passed.** All four failures were Claude haiku, identically in the
  compact and the full profile. In the requirements task it saved a ramp target with the unit
  `"degree"`, which the unit table cannot read, the save gave no sign of it, and its final
  message called the requirements “verified”. In the calculation task it chose the
  `battery_energy` template and filled the required `usable_fraction` with the 0.8 its
  description offered as an example, giving 2.66 Wh. Every run called `work_status` before
  finishing; none used a tool outside Omen Flow, created a duplicate part, or claimed approval.
- **What the compact profile changed for haiku.** Not the outcome: pass and fail were the same
  in all four tasks. It changed the cost: input per model turn was 15k against 21k tokens
  (requirements), 22k against 47k (CAD plate), 24k against 45k (calculation) and 28k against
  58k (finish discipline), and total input was 22 % to 76 % lower in compact. Sessions shown the
  compact schema overlay wrote the short `cad_check` form and matched the committed scope at
  once; full-profile sessions wrote the long form and got `scope_changed` (haiku full 7 times,
  costing 9 checks, 1.05M input tokens and 154 s on a one-line edit; opus and astra once each),
  because no tool showed the committed expectations. The file notes that a seed committed in the
  long form would have favoured the other side. In the first pass the standard profile (sonnet)
  also listed the overlays; since the review it lists slim full schemas.
- **Fixes and re-runs.** The evaluation track changed the instructions, the playbooks and the
  result shaping: units as symbols, with a `warnings` entry for any quantity whose unit the
  table cannot read; a template only when every input it needs was given; “do only what was
  asked” in the compact instructions; and the provenance key in the calculation playbook's
  input example. Seven re-runs of the affected cells: both requirements cells passed (`deg`
  from the start); the calculation passed in haiku full and in one of two haiku compact runs,
  and the other compact run used 0.8 again (“a typical usable depth of discharge is 80%”);
  finish discipline (haiku compact) passed without the unrequested proposal; and the Luna CAD
  plate passed without the unrequested requirement, in 8 calls instead of 15.
- The four causes the file lists as outside the evaluation track's files (invisible committed
  expectations, any unit string stored, the template's example value, the summary's
  requirement hint) were then fixed in the core; see the follow-ups above. The section after
  the ones summarised here, “After core fixes”, was being written by the evaluation track when
  this record was made, so it is not summarised here; read it in the file.

This record makes no other claim about how a live model performs with Omen Flow.

## Linux packages — 14 October 2026

The first Linux build of the Rust app: `.deb`, `.rpm` and AppImage, version 1.0.0, arm64, made by
`node scripts/linux-package.mjs` (new; recipe in `scripts/linux/`) on the macOS arm64 machine
through colima (profile `omenflow`, 6 CPUs, 9 GiB, Apple Virtualization) and Docker 29.5.2. Final
clean run 19:48 to 20:04 UTC, 973 s, from a new container of the `omenflow-linux-build` image:
Ubuntu 24.04.5 LTS arm64, Node v24.19.0, pnpm 9.15.9, rustc 1.99.0 (the `stable` channel of
`rust-toolchain.toml` on that day; the Mac has 1.98.1), OpenSCAD 2021.01 from Ubuntu. Counts are
copied from the output.

| Step (in the build container, as an ordinary user)             | Result                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`, `pnpm rebuild:node`          | Exit 0                                                                                                                                                                                                                                                                                                                         |
| `pnpm contracts:check`                                         | Exit 0                                                                                                                                                                                                                                                                                                                         |
| `pnpm build:bridge`                                            | Exit 0                                                                                                                                                                                                                                                                                                                         |
| `cargo test --workspace --locked --no-fail-fast`               | Exit 101. **550 passed, 1 failed, 1 ignored**: agent host 129 + 1 ignored, `host_render_lock` 1, contracts 51, core 308 + 1 failed, headless library 14, `omenflow-host` 3, `binary.rs` 5, `server.rs` 11, desktop shell 19 (the macOS-only display test is not compiled), storage 9. The failure is OpenSCAD's version, below |
| Helper tests; `cargo test -p omenflow-agent-host -- --ignored` | 13 passed; 1 passed (real-helper round trip)                                                                                                                                                                                                                                                                                   |
| `pnpm test:conformance`                                        | 4 files, 52 tests passed                                                                                                                                                                                                                                                                                                       |
| `pnpm smoke:headless`                                          | “helper round trip passed (read, agent draft, refusal)”, “Headless smoke passed”                                                                                                                                                                                                                                               |
| `pnpm make --bundles deb,rpm,appimage`                         | Release build 4 m 38 s; `Omen Flow_1.0.0_arm64.deb` 11,293,564 bytes, `Omen Flow-1.0.0-1.aarch64.rpm` 11,296,578, `Omen Flow_1.0.0_aarch64.AppImage` 84,560,392                                                                                                                                                                |
| Package metadata                                               | `Package: omen-flow`, `Version: 1.0.0`, `Section: devel`, `Maintainer: Omen Flow contributors`, `Depends:` the libraries in [release](../../docs/release.md#linux-packages); rpm `License: Apache-2.0`; `desktop-file-validate: no errors`                                                                                     |

The failing test, `cad::tests::brief_results_keep_the_outcome_in_a_fraction_of_the_size`, printed
`1074 vs 2146`: it requires the brief CAD result to be under half the full one, and the full
result names the engine, `"tool":"openscad 2021.01"`, three characters shorter than
`openscad 2026.09.18` on the Mac (where the test passes). The same test failed the same way in the
first container run. The test was not changed then; it is below.

Each package then ran on a system that never saw the build, as an ordinary user under
`xvfb-run` (1920 × 1080), through `node scripts/rust-packaged-smoke.mjs --linux` (new):

| Package                                                                                                       | Install                                                                                                        | Smoke                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.deb`, fresh `ubuntu:24.04`                                                                                  | `apt-get install --no-install-recommends ./…deb`: 221 newly installed, 2 upgraded; `ldd` found nothing missing | helper `/usr/lib/Omen Flow/omenflow`; round trip passed; child environment clean; window 1440 × 900 `IsViewable`, `WM_CLASS "omen-flow", "Omen-flow"`; “Linux package smoke passed: /usr/bin/omen-flow”; `apt-get remove` removed `/usr/bin/omen-flow` |
| AppImage, fresh `ubuntu:24.04` with no WebKitGTK or GTK (display tools, EGL, GLES/GL, HarfBuzz, FriBidi only) | `APPIMAGE_EXTRACT_AND_RUN=1`                                                                                   | helper inside the unpacked image; round trip passed; “child environment clean (15 variables, none inside /tmp/appimage_extracted_…)”; window 1440 × 900; passed                                                                                        |
| `.rpm`, fresh `fedora:42`                                                                                     | `dnf install`: 261 packages; `ldd` found nothing missing                                                       | helper `/usr/lib/Omen Flow/omenflow`; round trip passed; window 1440 × 900; passed                                                                                                                                                                     |

Screenshots (`smoke-deb.png`, `smoke-appimage.png`, `smoke-rpm.png`, kept with the packages in
`target/release/bundle/linux-arm64/`) show the launcher drawn by WebKitGTK with its own fonts and
`Ctrl` shortcut labels. SHA-256: `.deb` `3a7c38c3…1f08ec`, `.rpm` `330b89e6…7722da`, AppImage
`228266b2…f03437`.

Linux defects found and fixed, each first seen in a run above:

- The `.deb` did not start on a fresh Ubuntu 24.04: `libpipewire-0.3.so.0 => not found` (the
  screen-capture crate links it; Tauri declares only WebKitGTK and GTK). `bundle.linux.deb` and
  `.rpm` then declared PipeWire, D-Bus, xcb, EGL, GBM and Wayland (superseded below: the Linux
  build no longer links any of them).
- The AppImage bundling failed: `xdg-open binary not found /usr/bin/xdg-open`; `xdg-utils` is in
  the recipe.
- Every child of the AppImage (agent terminals, the login-shell and version probes, OpenSCAD,
  links opened in the browser) inherited the launcher's `LD_LIBRARY_PATH`, `PYTHONHOME`,
  `PYTHONPATH`, `PATH`, GTK, GIO, GStreamer, Qt and Perl paths into the image, `GDK_BACKEND=x11`,
  and a working folder inside the image. The new smoke check failed on the unfixed AppImage,
  naming 20 variables, `PWD` among them; `omenflow_core::child_env` now gives children the
  session's environment and home folder (5 tests), used by the terminal plan (1 test), the probes,
  OpenSCAD and link opening, and the search path leaves out folders inside the image.
- The command was `/usr/bin/omenflow-rust-desktop`, the 256-pixel icon went to a non-standard
  `hicolor/256x256@2`, and no license file was shipped. Linux builds now install `omen-flow`
  (`tauri.linux.conf.json`), icons at 32, 128 and 512 pixels, and the license and notice.
- Agent CLIs installed by Homebrew on Linux or as snaps are now found without the login shell
  (1 test).

Driven with xdotool and wmctrl on the installed `.deb` (from the build just before the final run,
same Rust code): under openbox a close request ended the app with exit 0 and wrote
`window-state.json` (`"space":"pixels"`); with a D-Bus session, a second start exited 0 and the
first kept its one window; with `DBUS_SESSION_BUS_ADDRESS` unset (and `dbus-x11` installed) it
still started. In the project, the Agent tab started a stand-in `claude` (a shell script, no
model) in a PTY: it ran in the project folder in its own session (pid = process group = session
id, `pts/0`), with the helper's folder first on its PATH, the bridge variables set and the app's
own `OMENFLOW_APP_DATA_DIR` removed; `omenflow call project.summary` through the helper succeeded
and the activity rail showed “Project summary · ok”. A close request then showed “An agent is
still working”, and “Stop agent and close” ended the app and the stand-in's process group.

Not resolved: under Xvfb the app's GTK dialogs (the folder picker, “An agent is still working”)
never appear in a screenshot of the screen, black without a compositor and see-through with
`xcompmgr`, although they work (their window image is correct and clicks on Cancel and “Stop
agent and close” acted). `WEBKIT_DISABLE_DMABUF_RENDERER`, `WEBKIT_DISABLE_COMPOSITING_MODE`,
`GDK_GL=disable`, `LIBGL_ALWAYS_SOFTWARE` and `GDK_SYNCHRONIZE` changed nothing; a minimal Tauri
2.11 window with an rfd dialog or a GTK dialog made on the main thread behaves the same; the
GTK 3 demo program's dialogs do appear. Whether a person sees them on a Linux desktop is
unknown. Also not done: x86_64 (the new `package-linux` CI job has not run), signing, a real
desktop, Wayland, GPU drivers, a real agent CLI on Linux, other distributions. On every
platform the bridge socket file stays after quit; the next start replaces it.

Mac, after the Rust changes: `cargo test --workspace --locked --no-fail-fast` exit 0, 552
passed, 1 ignored, no engine test skipped (OpenSCAD 2026.09.18); `cargo clippy --workspace
--all-targets --locked -- -D warnings` and `cargo fmt --all -- --check` exit 0. The macOS bundle
and its packaged smoke were not rebuilt or run.

### Linux hardening — later on 14 October 2026

An independent verification of the packages above found that they needed glibc 2.39 without
saying so (on Ubuntu 22.04 apt installed the `.deb` and the app then stopped with ``version
`GLIBC_2.39' not found``), that `node scripts/linux-package.mjs` without `--keep-going` stopped at
the Rust tests, that `weak_client_tests::numbers_and_booleans_sent_as_strings_are_read_and_reported`
failed 3 times in 10, and that SIGTERM killed the app (status 143) without its exit path. Fixed:

- **Build base Ubuntu 22.04 and a declared floor.** The image is now Ubuntu 22.04.5 (glibc 2.35).
  Its PipeWire 0.3.48 cannot build the screen-capture crate's PipeWire bindings (`libspa` 0.10.1:
  `spa_video_info_raw` has no `flags`, `modifier` is `i64`, no `spa_meta_first`; 0.9.2 the same),
  and the 24.04-built app imported no PipeWire, GBM, EGL or Wayland symbol at all. So on Linux the
  research screenshot is now taken by WebKitGTK (`apps/rust-desktop/src/capture.rs`, 3 tests) and
  xcap is built for macOS and Windows only; the app links glibc, libgcc and the GTK, WebKitGTK and
  D-Bus stack. The `.deb` declares `libc6 (>= 2.35)`, `libwebkit2gtk-4.1-0 (>= 2.41.90)` and
  `libdbus-1-3`; the `.rpm` `libc.so.6(GLIBC_2.35)(64bit)` and `libdbus-1.so.3()(64bit)`. A new
  packaging step reads the newest `GLIBC_` symbol (app `GLIBC_2.35`, helper `GLIBC_2.34`,
  everything in the AppImage `GLIBC_2.35`) and `dpkg-shlibdeps` (`libc6 (>= 2.35)`,
  `libwebkit2gtk-4.1-0 (>= 2.41.90)`) and fails if a declaration falls below them. On Ubuntu 20.04
  apt now refuses the `.deb`: "Depends: libc6 (>= 2.35) but 2.31-0ubuntu9.17 is to be installed".
- **Stable listing order.** `artifact.list` (and the graph snapshot) ordered artifacts created in
  the same millisecond by their random ids. They are now ordered by `created_at`, then insertion
  order (`rowid`); cursors keep the `createdAt|id` form and are placed by that artifact's row, and
  offsets are unchanged. A new test gives eight artifacts one creation millisecond and pages through
  them by offset and cursor at four page sizes; it, and the 650-artifact paging test, fail with the
  old ordering. On the Mac the weak-client test then passed 20 of 20 runs in a row (18 of 20 with
  the old ordering restored for comparison).
- **CAD test sizes.** `cad::tests::brief_results_keep_the_outcome_in_a_fraction_of_the_size`
  compared raw JSON lengths, which carry the engine's version and the render time: on the Mac it
  failed as well, `1074 vs 2148` with a 61 ms render. It now compares the result with ids, content
  hashes, `render.tool` and `render.ms` made uniform (`977 vs 2039` for `cad.write_source`,
  `686 vs 2092` for `cad.check`, on the Mac), keeps the half-size bound, and also
  requires the brief result to leave out the parameters, geometry, sections, probes, next-step
  prose, title and engine fields. `a_part_with_hundreds_of_thousands_of_triangles_is_rendered_measured_and_checked`
  exceeded its 120 s render limit with OpenSCAD 2021.01 (the sphere-minus-cylinder boolean alone
  took 134 s with Ubuntu 22.04's build and 142 s with 24.04's; the Mac's Manifold snapshot, 8 s).
  It now turns the same drilled ball from its profile (`rotate_extrude`, no 3D boolean): 260,960
  triangles, every assertion unchanged, 7.7 s with 2021.01 and 8.2 s on the Mac.
- **SIGTERM, SIGINT and SIGHUP** now quit through the exit path (`apps/rust-desktop/src/signals.rs`,
  signal-hook 0.4.5; tests signal a child copy of the test binary: each of the three gives exit status 0, a second signal ends a shutdown that does not finish). The packaged smoke gained a
  stand-in agent started in the Agent tab (`OMENFLOW_SMOKE_AGENT`) and ends with a SIGTERM that must
  give status 0 and end the agent's process group; 2 more tests cover the stand-in agent.

Final run of `DOCKER_CONTEXT=colima-omenflow node scripts/linux-package.mjs`, 22:56:35 to
23:19:21 UTC, 1364 s, exit 0, "linux-package: all steps passed" (build image: Ubuntu 22.04.5 LTS
arm64, glibc 2.35-0ubuntu3.15, Node v24.19.0, pnpm 9.15.9, rustc 1.99.0, OpenSCAD 2021.01):

| Step                                                | Result                                                                                                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test --workspace --locked --no-fail-fast`    | 562 passed, 0 failed, 1 ignored: agent host 129 + 1 ignored, `host_render_lock` 1, contracts 51, core 311, headless 14, `omenflow-host` 3, `binary.rs` 5, `server.rs` 11, desktop 28, storage 9 |
| Helper tests, real-helper round trip, conformance   | passed; `Test Files 4 passed (4)`, `Tests 52 passed (52)`; headless smoke passed                                                                                                                |
| `pnpm make --bundles deb,rpm,appimage`              | release build 3 m 42 s; `.deb` 11,253,306 bytes, `.rpm` 11,252,543, AppImage 86,714,888                                                                                                         |
| Declared floors                                     | "glibc floor 2.35: declared by both packages, and exactly what the binaries need"                                                                                                               |
| `.deb`, fresh `ubuntu:22.04` (glibc 2.35)           | 201 newly installed; `ldd` nothing missing; smoke passed                                                                                                                                        |
| `.deb`, fresh `ubuntu:24.04` (glibc 2.39)           | 216 newly installed; `ldd` nothing missing; smoke passed                                                                                                                                        |
| `.deb`, fresh `debian:12` (glibc 2.36)              | 223 newly installed; `ldd` nothing missing; smoke passed                                                                                                                                        |
| AppImage, fresh `ubuntu:22.04`, no WebKitGTK or GTK | `APPIMAGE_EXTRACT_AND_RUN=1`; smoke passed; the runtime kept its `/tmp/appimage_extracted_…` folder (the smoke removed it)                                                                      |
| `.rpm`, fresh `fedora:42` (glibc 2.41)              | dnf installed 261 packages; `ldd` nothing missing; smoke passed                                                                                                                                 |

Every smoke showed the packaged helper, a clean child environment, a 1440 × 900 `IsViewable`
window with `WM_CLASS "omen-flow", "Omen-flow"`, a 1440 × 900 WebKitGTK picture of the page, a
stand-in agent leading its own session and group that called `project.summary` through the packaged
helper, and "SIGTERM to pid …: exit status 0, agent process group … gone, window state saved".
SHA-256: `.deb` `7b598fef…bb5a942`, `.rpm` `54da5299…49cbd66`, AppImage `9b6a4bdb…7a424d5e`.

In separate containers with the same files: mounted through FUSE (`--device /dev/fuse`, `fuse3`)
on Ubuntu 22.04, the AppImage's launched process was the app itself, and a SIGTERM to it or to its
whole process group gave status 0, unmounted the image and left no process. Unpacked
(`APPIMAGE_EXTRACT_AND_RUN=1`), the AppImage runtime (type2-runtime 8f39b89) forks the app and
waits: a SIGTERM to the app gave status 0; one to the runtime alone ended the runtime (143) and left
the app running; and the runtime kept its folder after every exit, including an immediate clean
one (traced on the build before: after `wait4` it calls `exit_group(0)` without removing anything).
That is the runtime's behaviour, not the app's.

Mac, after these changes: `cargo test --workspace --locked --no-fail-fast` exit 0, 563 passed,
1 ignored, no engine test skipped (OpenSCAD 2026.09.18); `cargo clippy --workspace --all-targets
--locked -- -D warnings` exit 0; `cargo fmt --all -- --check` exit 0; `pnpm test:conformance`
4 files, 52 tests passed; `cargo build --release --locked -p omenflow-rust-desktop` exit 0. The
macOS app was not launched.

## Known limits

- **Native app.** The release bundle was launched only by `pnpm smoke:packaged`, which proves the bundled helper and bridge, not the interface. Unverified at runtime: creating the main window from
  config (`"create": false`; if wrong, no window appears), the navigation guard, the startup
  error dialog, the custom macOS menu and Quit confirmation, window-state restore (unit-tested
  across pixel densities on macOS, never on real mixed-density displays), the content security
  policy with Tauri's `ipc:` protocol, and the hidden research window. Renderer features seen
  only in Chromium: `overflow: clip`, `:has()`, container queries, `text-wrap`, individual
  transform properties and the first-paint theme script in WKWebView.
- **Distribution.** Apple signing and notarization have never run with real credentials; no
  clean-machine install or populated-project upgrade. From 1.0.0 the bundle identifier is
  `app.omenflow.desktop`, with the settings migration above; the 1.0.0 bundle and DMG are built
  but unsigned (ad-hoc), so other Macs refuse them until `pnpm release:macos` runs with a
  Developer ID. Windows is not verified: the
  Windows bridge pipe has not been built or run on Windows. Linux packages were built and run on
  arm64 in containers only, on an Ubuntu 22.04 base with a declared glibc 2.35 floor
  ([Linux packages](#linux-packages--14-october-2026)); x86_64 is a CI job that has not run. The
  macOS job uses the unpinned `openscad@snapshot`; the Rust engine tests pass with OpenSCAD
  2026.09.18 on the Mac and with Ubuntu 22.04's 2021.01 in the Linux build container.
- **Accessibility.** VoiceOver and the operating system's reduced-motion setting have not been
  checked.
- **Agents.** Stop hooks that enforce the completion gate are not built; the gate is requested
  by the instructions and playbooks. Claude Code `--resume` has not been exercised live; Codex
  resume is not offered. OpenCode, Gemini CLI and Qwen Code launch lines follow their
  documentation only. Results refuse a cut list that is saved back, but not a whole list that
  an agent shortened itself.
- **Records.** Archives contain no readable per-artifact views (the one expected conformance
  failure), and a render identity keeps the OpenSCAD path. `artifact.history` and
  `proposal.list` are unbounded. A revision built on an older base still retires the open draft
  (kept in history, and now named in `warnings`). Idempotency keys are kept 24 hours. The BOM's
  known-mass unit follows whichever line sorts first.
- **Renderer.** When this record was written, a calculation payload without an `evidenceKind`
  still read “calculated” in the decision view (`decide/ArtifactContent.tsx`) and showed a
  blank evidence kind on the calculation stage; the Evidence lens shows such a calculation as
  “No result” from coverage. The renderer mirrors the core's rule for a BOM-only carrier
  revision (`isCarrier` in `decide/model.ts`), so a change to that rule needs both. The placement
  of an agent window that was never placed was checked in the browser preview at 1024 × 700
  (it stops above the map legend); the requirement stage's unknown-target choice was tested but
  not looked at in a running app. In `packages/contracts`, `convert()` and
  `formatQty` still drop a one-sided bound; the renderer formats quantities itself.
- **Hosts.** Events recorded outside a dispatch (terminal state) reach the renderer with the
  next delivery; a stopped terminal reports `exited` twice; `stop_engines` is process-wide;
  `omenflow:job:progress` is never emitted. The bridge socket path limits the app-data path to
  about 104 bytes.
- **Research.** No HTTP status or PDF text from the webview; `research.read_page` has no paging;
  `browser.screenshot` needs the window on screen. None of it exists in the headless host.
- **Tests.** The legacy calculation worker's 2-second limit timed out on heavily loaded machines
  and on GitHub's runners; at release it was raised to 10 s (the limit's own test sets its own),
  and the root config caps test workers at 4.

## Incident during V1 work

While checking the preview's Agent tab, “Start again” after an ended Custom CLI session started
the preferred adapter, Codex CLI, whose first screen was an update prompt; a typed line ending
in Return chose “Update now” and its installer began fetching 0.162.1 before the session was
stopped about ten seconds later. No prompt reached a model. Afterwards `codex --version` still
printed 0.156.1, and a possibly incomplete
`~/.codex/packages/standalone/releases/0.162.1-aarch64-apple-darwin` was left in place for the
owner to decide on. The preview now starts no terminal at all unless it was started with
`OMEN_PREVIEW_AGENTS=1`.

No safety, manufacturability or production-readiness claim is made by this record.

## Final gate — 14 October 2026, evening

After the identifier, version and Linux changes, on the Mac: `pnpm typecheck`, `pnpm lint`
(0 errors), `pnpm format:check`, `pnpm contracts:check`, `pnpm test` (91 files, 967 passed,
2 skipped), `cargo clippy` and `cargo fmt --check` passed; `cargo test --workspace` passed 563
with 1 ignored after one test-only race was fixed (the data-folder lock test re-claimed a lock
that a child forked by another test still shared; it now waits for the release). The bridge
crate's 13 tests, `pnpm test:conformance` (52) and `pnpm smoke:headless` passed. `CI=true pnpm
make` built `Omen Flow_1.0.0_aarch64.dmg` (identifier `app.omenflow.desktop`, version 1.0.0,
minimum macOS 13.3), and the packaged smoke passed against the app inside the mounted DMG; the
app now quits through its exit path on SIGTERM. The agent-host probes retry briefly when an
executable is busy (ETXTBSY), which made three adapter tests fail intermittently on Linux: the
agent-host library suite then passed 40 of 40 runs in the Ubuntu 22.04 build image (the second
Linux verification had seen 6 failures in 52 runs).
