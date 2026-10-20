# Lens verification

The newest record comes first. Checks apply to working trees, not to a packaged or signed
release. Native v0.1 qualification of the previous renderer is recorded in
[release evidence](../audit/release-v0.1/README.md) and does not transfer to Lens.

## 1.0.1 · 19 October 2026

The nine audit improvements are tracked in the [1.0.1 verification record](../audit/v1.0.1/README.md).
The real Rust design preview was reviewed in Paper and Graphite at 1440×900 and 1024×700.
Open component stages refreshed offers and consecutive draft heads; Files refreshed a newly
recorded revision; content search opened its matched revision. A concurrent test procedure
change preserved an observation and required explicit review of the new procedure.

Native macOS validation used an isolated disposable project and a real Custom CLI PTY.
Requirement, observation and CAD edits survived canceled close/quit; canceling the later
agent consent preserved both the edit and running agent. Confirmed quit stopped the PTY and
exited 0; clean close passed. Intentional GPU context loss is covered by automated guards,
not a native manual exercise. Package and publication checks are recorded separately above.

## V1 · 14 October 2026

V1 brought eight renderer tracks (sync and frame, object, decision, agent, lenses, flow, visual
system, renderer seams) onto the Rust-backed host: the Evidence lens (`⌘5`), a flow map
renderer of its own with a keyboard model, the agent surface (session bar, activity rail from
the host's call ledger, onboarding states, one ask queue, a docking window), decisions with
phases and one approval guard, the object edit model, viewport tools, new kit primitives, the
lens registry, and stylesheets split by surface. [The specification](design.md) (version 2.3,
with the QA and review changes folded in) describes the result. Recorded here: the renderer
integration pass with its preview walkthrough, a fresh-eyes QA pass, and the final checks after
the adversarial review, made for the [V1 readiness record](../audit/v1/README.md).

### Integration

The integration pass joined the tracks' seams:

- One unsaved-work registry and one prompt. Object editors register with the frame
  (`lib/unsaved-edits.ts` → `lib/dirty.ts`); every store navigation (go, focus, decide, zoom
  out, back, forward, closing or switching the project) asks first; the object view's own
  prompt is gone. Parked edits are cleared with the project.
- One ask path. `askAbout` and every “Ask agent” entry point use the agent's queue: pasted once
  the CLI shows its prompt, waiting visibly until then, never dropped or submitted. The
  surfaces that said “nothing was typed” no longer need to.
- One proposal rule (`lib/proposals.ts`): the activity-bar badge, titlebar pill, omnibar,
  Needs you and the decision queue count pending proposals that nothing replaced.
- The decision guard reads the shared layer helper (`lib/layers.ts`).
- Toasts lift above any `data-toast-avoid` control (decision bar, map controls, save bar) and
  leave with an exit animation.
- Object rails fold (40 px strip, `omen.rails`) and each rail, the decision queue, the impact
  rail and CAD geometry have their own error boundary.
- Timeline pages through the store's event window; lens filters, picks and queries survive a
  lens switch (`useViewState`).
- Visual-system roles adopted in surface stylesheets: signal stroke for lines, rings and dots;
  motion utilities on the omnibar, sheet, scrims, prompt and toasts; stage zoom motion only
  when the level changes; layer tokens; the disabled token; the photo well; the terminal
  palette read from `--terminal-*`, `--ansi-*` and the scrollbar tokens, cursor still under
  reduced motion.
- Bundle: no runtime import of the contracts barrel (Parts uses `ui/units.ts`, kept identical
  to the contract unit table by `tests/frontend/ui-units.test.ts`); the omnibar and settings
  sheet are code-split. Entry chunk **444.4 kB** (gzip 137.9 kB), down from 507.6 kB at merge.

### Automated checks at the end of the integration pass

| Check                                                                        | Result                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @omenflow/desktop typecheck`                                  | Passed                                                                                                                                                                                                                                                                          |
| `pnpm exec vitest run tests/frontend tests/terminal-restore.test.ts`         | 49 files, 563 tests passed                                                                                                                                                                                                                                                      |
| `pnpm exec eslint apps/desktop/src/renderer tests/frontend --max-warnings 0` | 0 errors, 0 warnings                                                                                                                                                                                                                                                            |
| `prettier --check` on `apps/desktop`, `tests/frontend`, `design-system`      | Passed                                                                                                                                                                                                                                                                          |
| `pnpm --filter @omenflow/desktop build:rust-ui`                              | Passed; entry 444.4 kB; lazy: three 499.8, xterm 331.3, ObjectView 93.5, markdown 68.7, DecideView 65.0, FlowLens 57.9, Agent 49.3, StlViewport 49.2, DesignSystemView 33.6, Omnibar 29.7, PartsLens 24.0, Settings 15.1, TimelineLens 12.4, EvidenceLens 9.5, FilesLens 8.8 kB |

### Preview walkthrough (integration pass)

`pnpm design:preview` on the Rust headless host, Chromium (Browser pane), 1440 × 900 and
1024 × 700, Graphite and Paper, on the disposable rover fixture:

- Flow: 26 objects at 100 % (1440) and 88 % with “5 off screen” (1024), titles 12.5 px; hover
  on Rover mass budget lit 5 nodes and 4 links in `--signal-stroke` (lime; olive on Paper);
  keyboard → followed the link from Payload capacity to Rover mass budget, ↵ opened it.
- Needs you counted only the pending proposal (1); after approving it, the flow showed four
  out-of-date objects with reasons (“Payload capacity changed, through Rover mass budget”),
  the legend gained “path of a change” and “out of date”, and the badge cleared.
- Every lens, Evidence included (served by the Rust host's `project.coverage`): no horizontal
  overflow, lens bars 50 px. Timeline paged from 400 held events to the start of the record
  through the store after 420 intent edits on the disposable project.
- All ten object types in the fixture (requirement, assumption, mechanical, calculation, test,
  wiring, component, source, assembly, architecture): no overflow and no error boundary in
  either theme at either size. Rails fold to 40 px and back; the mechanical stage labels its
  illustrative mesh.
- Unsaved edit on a requirement target: the activity-bar Flow tab and a revision pick each
  opened the frame prompt naming “requirement Payload capacity”; Escape kept the edit;
  “Discard and show another revision” discarded it and moved.
- Decision: approved the pending proposal by pointer; the done state and handoff text
  appeared; a toast raised over the decision view sat above the bar (bottom 756 px against the
  bar's top 760 px at 1440 × 900), and above the map controls at 1024 × 700.
- Agent: with no session, “Ask agent” opened the window and showed “Waiting to type” with the
  CLI choice (Codex and Claude Code were not started; the preview refuses them anyway). A
  Custom CLI configured to `/bin/cat` in the preview's own app data started in the real PTY;
  the session bar read “Running · Custom CLI · Compact · adapter default · 13 tools”; a queued
  ask waited (cat never enables bracketed paste) and “Paste now” typed it without a Return;
  the palette followed the theme at once (`#0d0e10` → `#fbfbfc`).
- Omnibar and settings load on first open with their enter and exit motion; the catalogue's
  `PayloadDiff` specimen renders the typed diff; the launcher's location stays in the preview
  root.
- Console: no errors or warnings from the app.

Defects found and fixed during the pass: the folded rail token was missing (rail kept its
width); toasts slid up over the decision bar while their position settled; a scaling zoom-out
on the project level was measured by the flow map's fit; the flow canvas could be scrolled
sideways by focus and scroll memory, shifting nodes under the activity bar (it is now
`overflow: clip`).

### QA pass

A fresh-eyes product QA walked every surface in the specification on the Rust-backed preview
(rover and drone fixtures) in the Browser pane at 1440 × 900 and 1024 × 700, Graphite and
Paper, and drove the Agent tab with a real shell: Settings → Custom CLI, executable `/bin/zsh`,
arguments `-i`, saved through the form. At that time the preview started a Custom CLI without
`OMEN_PREVIEW_AGENTS=1`; since the review it starts no terminal without it. Codex CLI and Claude
Code were never started. The pane was hidden, so terminal content was checked against the
host's `terminal.state` scrollback as well as on screen. The host was restarted once to pick up
the one Rust fix.

What the real terminal showed (observed, not injected):

- The session bar read “Running · Custom CLI · Compact · adapter default · 13 tools · 0 calls”,
  and `which omenflow` found the bundled helper. `omenflow status` answered “Nothing is
  unfinished in this session.” and the bar moved to 1 call; `omenflow guide cad` printed the
  CAD playbook; `omenflow call artifact_list` listed the project.
- `artifact_read` with `revisionID` was repaired, with the note “renamed revisionID →
  revisionId”; with `verbosity` it was refused as `VALIDATION` naming the allowed keys, with an
  example and a repair.
- The activity rail listed every call newest first with outcome, duration, raw tool name,
  time, the repair note, the selectable error and the touched object as a link; the rail header
  and the session bar gave the same call and failure counts, and the activity-bar mark appeared
  after a failed call and cleared after the next successful one.
- Interrupt cut off `sleep 30`. The `⌘J` window's ticker followed new calls live, docking
  narrowed the stage and the flow refit, and `⌘J` closed it with focus back in the terminal.
  Restart gave a new session with no calls and kept the earlier ones under “earlier session”.
- A shell script ran `artifact_update_draft` and `proposal_submit` through the helper: the rail
  recorded both, and the proposal read “Proposed by the agent” and superseded the fixture's
  proposal.
- “Ask agent” on a stage, “Ask the agent to rebase” and the launcher brief were pasted with
  bracketed paste and never submitted (checked in the scrollback).

Every count on the agent surface matched the ledger.

The pass found 22 problems. It fixed 15 and one partly, and left six with owners; the review
fix tracks then closed those seven.

| #   | Surface              | What was wrong                                                                                                                  | Now                                                                                                                                                       |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Session bar, ended   | A stop the person asked for read “Ended · exit code 1” in red: the PTY library reports code 1 for any process ended by a signal | The host records an exit code only without a signal (`crates/agent-host/src/pty.rs`, with a test that fails without it); the bar reads “Ended”, neutral   |
| B   | Mechanical stage     | The illustrative tray lay on its side (62 × 14.5 × 44 mm): the fixture still rotated Z-up geometry for an older Y-up viewer     | Rotation removed; 62.00 × 44.00 × 14.50 mm, upright, as a real render of the same source                                                                  |
| C   | Decision, base moved | The right rail said approving would move the baseline, which the core refuses                                                   | “Approval is refused”, with the reason                                                                                                                    |
| D   | Timeline             | “Bill of materials changed” after every approval                                                                                | The renderer hides an empty announcement after an approval that touched no component, line or replacement; the core now emits one only for such approvals |
| E   | Timeline             | An impact row counted the changed object itself as reached                                                                      | Impact rows count only objects beyond the changed ones; a row that reached none is hidden                                                                 |
| F   | Toasts               | A toast rose mid-screen over the Revisions rail                                                                                 | The stack is measured and lifts only past a control it would overlap both ways                                                                            |
| G   | Activity rail        | “1:15:38 AM – 1:15:38 AM”; headers and call details broke mid-phrase at 264–300 px                                              | A range only when the shown times differ; wrapping only between facts                                                                                     |
| H   | Session bar          | About 2 s of “Running” with live controls after Stop on a shell that ignores SIGTERM                                            | The pressed control is busy and the other disabled until the host answers                                                                                 |
| I   | Evidence header      | “1 of 2 … 1 is only partly covered and 1 has no evidence” read as three requirements                                            | “…has current evidence, but only partly. 1 has no evidence.”                                                                                              |
| J   | Settings, Custom CLI | An operation name in the hint, and “Documented, not verified here” for a CLI nothing documents                                  | “Set its executable path under Configure.” and “Not verified here”                                                                                        |
| K   | Settings, Agents     | CLIs that are simply not installed shown in error red                                                                           | Neutral when not detected, red when a detected one fails                                                                                                  |
| L   | Settings, Custom CLI | Saved arguments were invisible after a save                                                                                     | Partly in the pass (hint); closed in the review: `connection.list` reports `args` and Settings shows them                                                 |
| M   | Record rail          | An agent revision's full session UUID wrapped over three lines                                                                  | “agent · session” and a short id, the full id in the title                                                                                                |
| N   | Decision, done       | “Would affect —” with nothing open                                                                                              | Only “What approval means” remains                                                                                                                        |
| O   | Flow map             | Its accessible name said “17 links” beside the header's “18 recorded links”                                                     | “17 drawn links”                                                                                                                                          |
| P   | Catalogue            | Level cards and the screens index left out Evidence                                                                             | Added                                                                                                                                                     |
| Q   | Shortcuts            | `⌘K` was ignored for about 320 ms while a closing sheet played its exit                                                         | Closed in the review: a layer marked `data-state="closed"` no longer holds the keyboard                                                                   |
| R   | Agent rail           | “Draft the first requirements” stayed offered after the launcher brief was typed                                                | Closed in the review: starters hide once anything was typed or pasted                                                                                     |
| S   | Agent window         | Collapsed, it covered the map legend and part of the peek strip                                                                 | Closed in the review: until placed it sits above the bottom controls                                                                                      |
| T   | Calculation inputs   | A pinned input named a short revision id where other rails say `rN`                                                             | Closed in the review: `rN` from the source's history                                                                                                      |
| U   | Preview script       | The disposable data folder was never removed                                                                                    | Closed in the review: removed when the preview stops                                                                                                      |
| V   | Fixture data         | Endurance target 45 min, acceptance “≥30 min”                                                                                   | Closed in the review: acceptance says ≥45 min                                                                                                             |

Checked and correct in the same pass: supersession both ways with “Open the replacement”; base
moved with “I have read the changes” and “Ask the agent to rebase”; approve with `⌘↵` from the
rationale, the done state and handoff; request changes and the disabled handoff with its
reason; impact after approval (amber paths, the agent ring, Needs you two abreast with
Re-evaluate all); the hover thread and map keys; fit all at 1024; the unsaved-work prompt and
the conflict table (Keep or Discard); save to baseline and draft accept; a real OpenSCAD render
accepted as baseline; section, measure and envelope; Parts and BOM totals equal to the sum of
lines; Files preview; the omnibar; `⌘[` and `⌘]`; launcher create with the brief pasted;
Settings sections; Paper; every rover object type at 1024 with no alert and no horizontal
overflow. No console errors or warnings in the whole walk.

QA did not cover the native WKWebView, a live model CLI, VoiceOver, animations and xterm
repaint while the pane was hidden (checked through the DOM, host state and scrollback), or the
Linux Rust job for the `pty.rs` change.

### Final checks after the review

After the adversarial review's 11 renderer fixes and the Rust fixes the renderer reads (the
[V1 readiness record](../audit/v1/README.md) lists them), run between 09:18 and 09:36 UTC; counts
are copied from the output.

| Check                                                                | Result                                                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm exec vitest run tests/frontend tests/terminal-restore.test.ts` | 52 files, 616 tests passed                                                                |
| `pnpm typecheck`                                                     | Passed (every workspace package and `evals/`)                                             |
| `pnpm lint`                                                          | 0 errors; 123 warnings, none under `apps/desktop`                                         |
| `pnpm --filter @omenflow/desktop build:rust-ui`                      | Passed; entry 445.98 kB (gzip 138.60 kB); three.js 499.75 kB and xterm 331.26 kB separate |
| `pnpm test`                                                          | 91 files, 967 passed, 2 skipped (real-engine gated cases)                                 |
| `pnpm test:conformance`                                              | 4 files, 52 tests passed, one an expected failure                                         |
| `cargo test --workspace --locked --no-fail-fast`                     | 544 passed, 1 ignored                                                                     |
| `pnpm format:check`                                                  | Passed                                                                                    |

On the Rust headless host, with no browser (`OMEN_PREVIEW_PORT=5199 pnpm design:preview`): the
page's endpoints answered 403 until the printed key was traded for the cookie; then the gallery
answered 200, a cross-origin bootstrap 403, and through the preview proxy `project.coverage`
(2 requirements), `work.status`, `guide.read`, `agent.activity` and the `tool.describe`
catalogue (57 tools) answered, while `terminal.start` was refused with `PREVIEW`. Stopping it
removed its data folder.

No browser walkthrough was repeated after the review fixes. They are covered by tests; the
placement of an agent window that was never placed and the requirement stage's “The target is
unknown” choice have not been looked at in a running app.

### Not covered

- **Native WKWebView.** The Tauri app was not launched. `overflow: clip`, `:has()`, container
  queries, `text-wrap`, individual transform properties, `field-sizing` and the first-paint
  theme script were seen in Chromium only.
- **VoiceOver** and the operating system's reduced-motion setting (reasoned from the tokens).
- **A live model in the interface.** No Codex, Claude Code or other model CLI was started from
  the interface. The integration pass ran `/bin/cat` (no tool calls); the QA pass filled the
  activity rail from a real shell calling the helper. The live models ran headless, without the
  interface, in the evaluation recorded in the [V1 readiness record](../audit/v1/README.md).
- The Browser pane was hidden during both passes, so animations and intersection observers
  were throttled; exit animations and Timeline's automatic paging were confirmed by state and
  by pressing “Show earlier entries”, not by watching them run.
- **Windows and Linux** chrome and webviews (WebView2, WebKitGTK): never run.
- **Signed packages.** No build was signed or notarized; no clean-machine install.

## Lens redesign · 23 September 2026

### What changed

The v1 renderer (sidebar, overview dashboard, nine routes, inspector side panel, status bar,
`components/ui.tsx`, `global.css`, `welcome.css`) was removed. Lens replaces it with three
zoom levels, a causal flow map, type-shaped stages, a decision mode, an agent composer bound to
the PTY, an omnibar, and a settings sheet. Tokens, specification, catalogue, brand, app icons,
and reference screens were replaced together. `@omenflow` operations, `.omenflow` storage, and
the bridge are unchanged.

### Automated checks

| Check                                            | Result                                                 |
| ------------------------------------------------ | ------------------------------------------------------ |
| `pnpm typecheck`                                 | Passed across all workspace packages                   |
| `pnpm test`                                      | 37 files passed; 285 tests passed, 2 skipped           |
| `eslint apps/desktop/src/renderer`               | 0 errors, 0 warnings                                   |
| `pnpm --filter @omenflow/desktop build:rust-ui`  | Passed (existing large-chunk advisory remains)         |
| `prettier --check` on renderer and design-system | Passed                                                 |
| `git diff --check`                               | Passed                                                 |
| `pnpm dev` (Tauri, macOS)                        | Compiled and launched with the overlay titlebar config |

Renderer logic that tests cover moved without behavioural change:
`lib/mechanical-revisions.ts` and `lib/terminal-restore.ts` (test imports updated).

### Preview walkthrough

Performed in `pnpm design:preview` at 1440 × 900 and 1024 × 700, Graphite and Paper, on the
disposable rover fixture with the real engineering core:

- Launcher: name + brief composer, open folder, import archive, recent projects, catalogue link.
- Flow: columns Intent → Parts (sources, components) → Design → Evidence; barycentre ordering;
  Needs-you island reserves map space; hover lights the full causal thread (6 nodes through
  the 2S pack); zoom and fit controls.
- Decision: approved “Increase payload capacity to 500 g” with a rationale via **Approve
  changes**. The queue emptied, “Resume agent from decision” appeared, and the flow then marked
  Camera tray, Rover mass budget, Wheel torque, and Ramp traverse out of date with amber path
  edges; Needs you listed all four with reasons.
- Object stages checked: mechanical (real STL bytes, revision picker, render bar, parameters,
  source), requirement (statement, target quantity, priority, trace impact, “Change in review”
  opens its proposal), calculation (result, expression, inputs with sources), component
  (properties with source links), wiring (validate → 5 findings in words, connections table).
- Lenses: Parts (known cost 113.75 USD, known mass 0.0795 kg, 6 lines), Timeline (merged
  revision/baseline rows, empty impact rows hidden), Files.
- Omnibar (`⌘K`): recent objects, grouped results, exact matches suppress loose fuzzy ones;
  layered above the flow after isolating the stage stacking context.
- Console: composer carries the focused object as a removable context chip; expanded console
  docks the terminal full-width and resizable.

Defects found and fixed during the pass: map overlapped the project header; tall Parts column
(split into two sub-columns); Needs-you island covered Evidence nodes; viewport fit too tight;
diff values too far apart; omnibar painted under flow nodes; revision rows collided in narrow
rails; timeline noise.

### Not covered

- **Native visual inspection.** The Tauri app built and launched, but screen capture and
  computer-use were unavailable in this environment, so the overlay titlebar, traffic-light
  alignment, and drag regions were not seen. Check `pnpm dev` on macOS: traffic lights at
  (18, 17) inside the 48 px titlebar, dragging from empty titlebar space.
- **A live agent session.** The preview cannot start a CLI. The composer's bracketed-paste
  send, “Ask agent” from the omnibar, live pulse, and activity line were verified by code path
  only against the existing `terminal.write` behaviour.
- Windows and Linux chrome, VoiceOver, keyboard-only traversal of the flow map, and long real
  projects (hundreds of objects on the map) still need dedicated passes.

## Artifact content audit · 24 September 2026

Audited all 14 artifact types from the agent operation contract through stored revisions to
native object stages. The baseline-only list view remains compatible; object focus loads
revision history and displays current work explicitly. Component candidates load their draft
payloads and separate offers. New reusable external-link and revision specimens are in the
Design system catalogue.

Fixes include draft visibility and prefilled recorded fields; wiring response field mismatch,
automatic revision-bound diagrams, pin/connection detail and theme contrast; native diagram
pin/signal/voltage labels and distinct connection rows; supplier links in components, candidates
and BOM; offer-added refresh events; concept/architecture visuals, software file previews,
calculation text results and exact-revision inputs, assumption uncertainties, and test evidence
details. Requirement edits preserve an unknown target and its reason. Implicit updates before
the first baseline retain the prior active draft's content, files, inputs and ancestry.

Creation now exposes per-type payload schemas through `tool.describe` and rejects a nonempty
payload whose fields would all be discarded. Empty payloads remain allowed for staged authoring;
existing storage is not migrated. Both agent guides explain the fields and the separate
source/offer records. Previously discarded content cannot be reconstructed from the empty
payload; an agent must author a new revision from available evidence.

Native walkthrough used a disposable, explicitly illustrative project generated by
`pnpm exec tsx scripts/artifact-review-fixture.ts`. It did not modify the user's engineering
project. All fourteen stages displayed saved content in the macOS native development build.
Confirmed 14 V draft → 12 V baseline switching, disabled draft edit controls, automatic wiring
diagram and findings, candidate offers, source destinations, software source preview, concept
SVG preview, and mechanical mesh/parameters plus matching draft metadata. Graphite and Paper
were inspected. The `scu` installation failed with a missing Python module, so native computer
use used the available CUA connector. An app wrapper under ignored `target/debug` made the
current unbundled development executable accessible to that connector.

Automated coverage: all-type creation/readback and schema discovery; render assertions for the
13 non-mechanical stages plus the existing mechanical revision tests; rejected revision
filtering; unknowns and uncommon units; HTTP-only external links; offer destinations and refresh
events; draft update preservation; native wiring labels, XML escaping, loops, reverse links,
and more than three connections. Final results: 39 JavaScript test files passed (340 tests,
2 skipped), 20 Rust contracts/core library tests passed, workspace typecheck passed, and both
the desktop UI production build and native development build passed. The UI build retains its
existing large-chunk advisory. Native visual checks included 1440 × 900 and 1024 × 700 windows;
the compact electrical diagram, pin table and connection table were readable in both themes.
The normal window size and Graphite theme were restored after testing.

A live agent authoring session and end-to-end supplier website navigation are not covered by
this audit.

## Activity-bar layout · 24 September 2026

The workbench was re-laid out like a classic editor: a 48 px activity bar on the left carries
the Agent tab first, then the lens tabs, Decisions (with an open-proposal count badge), and at
the bottom the agent-window toggle and Settings. The agent is one xterm/PTY instance that stays
mounted for the life of the open project and switches presentation — full Agent tab, floating
bottom-left window (`⌘J`, resizable, persisted), or hidden. The composer, agent chip, context
chip, docked console, top-right lens switcher, and the titlebar Settings button were removed.
The agent choice moved to a Settings radio group (`omen.agent` preference) with
“Restart with {agent}” for a live session on another CLI; “Ask agent” now types into the PTY
without submitting.

Checks run:

- `pnpm --filter @omenflow/desktop typecheck` — passed.
- `eslint apps/desktop/src/renderer` — 0 errors, 0 warnings.
- `prettier --check` on `apps/desktop/src/renderer`, `design-system`, `AGENTS.md` — passed.
- `pnpm exec vitest run` — 39 files, 340 tests passed, 2 skipped (no renderer test files exist
  under `apps/desktop`).
- `pnpm --filter @omenflow/desktop build:rust-ui` — passed (existing large-chunk advisory
  remains).
- `pnpm design:preview` walkthrough at ~1440 × 900, Graphite and Paper: activity bar renders
  with the Agent tab first; the Agent tab fills the main area with the terminal; the agent
  window opens/closes over Parts and survives tab switches; the Settings agents radio group
  selects the preferred adapter; the “not detected” overlay offers the Settings shortcut.

Not covered:

- **A live agent session.** The preview cannot start a CLI (`terminal.start` is disabled), so
  autostart, the live pulse/ring, bracketed-paste typing, scrollback restore, and the
  ended/restart overlay were verified by code path only.
- `omen.agentWindow` persisted sizing across relaunch, and native chrome (overlay titlebar,
  traffic lights) alongside the activity bar.

## Sourced parts · 26 September 2026

Parts now uses a shared shopping-list row in Candidates and the approved BOM: seller product
photo, name and part number, project-specific selection reason, recorded price/currency and
pack basis, availability, observation date, and exact external purchase destination. Comparison
also includes reasons and seller offers. The component stage shares the photo and offer display.
Candidates is the initial view so proposed purchases are visible before approval. Missing facts
stay explicit. Placeholder/non-web purchase destinations have no purchase action. Old projects
remain readable without migration; previously absent photos or reasons need a sourced revision.

Added optional `imageUrl` and `selectionReason` through TypeScript/Rust contracts, candidate
creation and BOM reads. Enabled only `research.read_page` for agents (other browser operations
remain gated), exposed photos and structured product metadata, rejected failed navigation before
reading a stale page, and waited for complete native research documents. Both generated agent
guides require exact product-page inspection and recorded prices/photos/reasons plus offer IDs.
HTTPS product images are allowed by the renderer CSP; external scripts remain blocked.

Live evaluation: `pnpm exec tsx scripts/parts-agent-eval.ts out/parts-luna-r2`, pinned to
**GPT-6 Luna, medium**. Three sourced candidates, three pending quantity-one proposals, no
self-approval. The test harness then approved these disposable proposals as the reviewer and
verified a three-line **20.40 USD** BOM. All three exact seller pages and image URLs returned
HTTP 200. Independently matched saved prices, currencies, SKUs and images against each page's
Product structured data; summary: [parts-verification.json](parts-verification.json). This is
observed price/availability evidence, not future stock or price guarantees or engineering approval.
The first run preceded exposure of the page reader and used the agent's web tool; its test-host
observation gate failed. The second run used the app's page reader and passed.

Visual validation: `pnpm design:preview` at 1440 × 900 and 1024 × 700; Graphite and Paper;
part-number filtering; selection and comparison; legacy missing-data fallbacks. `pnpm dev`
compiled and launched the native macOS application. Opened the live evaluation project in the
native build and verified candidate and BOM photos, reasons, prices and total. A native seller
link opened the exact Adafruit product URL in Safari. Native validation caught the initially
blocked photos; the HTTPS image policy fix was verified visually. Screenshot:
[sourced parts](screenshots/parts-sourced.png). The installed `scu` CLI still fails with its
missing Python module, so visual inspection used the available CUA connector.

Checks: workspace typecheck, production renderer build, 20 Rust contracts/core tests and the
new shopping-flow/render regressions passed. Full JavaScript suite: 39 files passed; two files
hit the existing calculation-worker 2-second timeout under concurrent load. Both affected files
passed when rerun with one worker (16 tests), with no calculation code changes. Build retains
the existing large-chunk advisory. No other agent model was used for live testing.

## First-use hardening · 26 September 2026

The current Lens renderer was checked alongside the packaged Rust app. Project
close/switch now releases the native project and terminal; agent restart resets
history per session; startup errors offer a retry; read-only projects explain why
agent startup is disabled. Existing `Button`, state, and agent empty-state patterns
are reused; no new navigation, primitive, or visual token was introduced. Settings
loads the saved OpenSCAD path and permits clearing it to restore detection.

The populated preview covered Parts, Timeline, Files/source preview, and missing
agents in both themes at 1024 × 700. Native 1440 × 900 acceptance covered launcher
creation, real PTY/helper calls, a real OpenSCAD mesh, human approval, terminal
restart, export/import, close/quit cleanup, configured-engine diagnostics, and a
newer-schema read-only project. Tests and exact limits are recorded in the
[current readiness audit](../audit/v1-readiness/README.md). The package is unsigned;
this evidence does not replace signing or clean-machine acceptance.
