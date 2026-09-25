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
