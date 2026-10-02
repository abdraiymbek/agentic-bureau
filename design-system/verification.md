# Lens verification

23 September 2026. Checks apply to the Lens working-tree redesign, not to a packaged or
signed release. Native v0.1 qualification of the previous renderer is recorded in
[release evidence](../audit/release-v0.1/README.md) and does not transfer to Lens.

## What changed

The v1 renderer (sidebar, overview dashboard, nine routes, inspector side panel, status bar,
`components/ui.tsx`, `global.css`, `welcome.css`) was removed. Lens replaces it with three
zoom levels, a causal flow map, type-shaped stages, a decision mode, an agent composer bound to
the PTY, an omnibar, and a settings sheet. Tokens, specification, catalogue, brand, app icons,
and reference screens were replaced together. `@omenflow` operations, `.omenflow` storage, and
the bridge are unchanged.

## Automated checks

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

## Preview walkthrough

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

## Not covered

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
