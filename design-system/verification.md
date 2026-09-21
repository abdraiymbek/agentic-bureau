# Redesign verification

Native v0.1 launcher, review, terminal restoration, export/import and service
recovery checks are recorded in [release evidence](../audit/release-v0.1/README.md).
That native qualification also covers 500 artifacts, a 99,852-triangle viewport,
100 viewport reloads, local font loading and measured redraw timing. Production
fonts now remain on the app origin; retired viewports explicitly release their
WebGL contexts. The dated redesign-only limits below are historical.

19 September 2026. Checks apply to this working-tree redesign, not a packaged release certification.

## UX refinement pass (same day, later)

Scope: information hierarchy and workflow, no visual redesign. Verified in the design preview at the default viewport and at 1024 × 700, dark and light.

- Shell: breadcrumb shows Project › Route › Object; project crumb returns to Overview. Sidebar “Recent objects” fills as objects are opened (Camera tray → Rover mass budget → Payload capacity), carries the out-of-date mark, and persists per project. Design-system button removed from the titlebar (still reachable from the sidebar, launcher, and ⌘K).
- Agent panel idle state is compact (provider, detection state, one start action, review boundary); duplicated project counts and the footer strip are gone. Session state renders as words with the provider name; the Agent tab shows a live mark when running.
- Status strip: Local project · N awaiting review · N out of date · tool job activity · agent state. Full path moved to a tooltip; Files & exports keeps it visible.
- Overview: summary strip opens its workspaces; attention rows name the discipline and reason; the engineering record is one row per discipline with state summary; the workstream card grid and the six-row object table are removed. After approving the preview proposal the strip flags 3 out of date and three attention rows appear.
- Design files / Requirements / Review queue use the compact header; the browser groups fold and the selected group stays open; Inspect sits in the object heading and shows an active state while the Inspector is open.
- Mechanical: canvas first, Parameters section with Apply/Discard appearing only when edited, Source disclosure carrying Validate and Save. Wiring/calculation actions use the shared compact button style.
- Review queue: decision area pinned to the bottom; Approve primary, Reject demoted; controls disable during the decision; object titles in change cards are real buttons that open the Inspector.
- Inspector: identifier moved to a metadata row; “Open in Design files / Requirements” appears when the object’s workspace is not the current route.
- `pnpm typecheck`, renderer lint, and `pnpm test` (13 files, 95 passed, 1 skipped) pass after the changes.

Not covered here: a running agent CLI session (the preview cannot start one), so the live tab mark and terminal state labels were checked by code review only.

## Automated checks

| Check                                                                              | Result                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                   | Passed across all workspace packages                                         |
| Desktop typecheck after the final UI changes                                       | Passed                                                                       |
| `pnpm test`                                                                        | 13 files passed; 95 tests passed, 1 skipped                                  |
| `pnpm lint`                                                                        | Completed with 0 errors and 44 existing warnings in main/core/fixtures/tests |
| Renderer, preview script, and preview-mesh lint after final changes                | Passed with 0 warnings/errors                                                |
| `pnpm --filter @omenflow/desktop exec vite build --config vite.renderer.config.ts` | Passed                                                                       |
| Prettier on changed text/code resources                                            | Applied; checked before delivery                                             |
| `git diff --check`                                                                 | Passed                                                                       |

The skipped test requires OpenSCAD. The production renderer reports a large-chunk warning (approximately 1.75 MB minified JavaScript, 483 KB gzip, including the engineering viewers and terminal). Route-level code splitting is an appropriate later performance task; the warning was not suppressed.

## Interactive checks

Used the actual React renderer with a development-only bridge to CoreApp and disposable rover/drone projects. The browser does not execute agent CLIs or use the user's project data.

- Project launcher: recent projects, brief retained in dialog, focused project-name field, disabled incomplete creation action.
- Created a disposable project, verified the empty overview, actual project brief/path, and zero-valued counts; switched back to an existing project.
- Requirement editor: labeled target/unit/priority fields, saved baseline visibility, downstream impact preview.
- Draft-only assumption: original statement and reason load, draft/no-baseline explanation, mutation controls disabled.
- Mechanical workspace: example mesh loads, CAD parameters and source are visible, inspector aligns with selected object. Geometry is explicitly illustrative.
- BOM: filtering and clearing, panel toggling without a render loop, known totals, two-candidate comparison with unit-bearing properties.
- Calculation: input values and source names load; re-run creates a proposal for the same object rather than a duplicate object; original baseline remains visible.
- Review: 0.3 kg → 0.5 kg diff, named impact, rationale entry, approval, refreshed baseline and three stale objects. Array diffs now expand into individual fields and do not silently truncate the review after 30 rows.
- Impact: focused affected path, full-project mode, dark/light themes, readable object nodes and controls. React Flow attribution is retained.
- Wiring: live validation returns recorded warnings/errors; table separates component names from pin identifiers and scrolls within the content region. Findings use known object names.
- Assembly/source/test: visually checked numbered instructions, linked parts, source metadata/excerpts, procedure outcomes, and explicit test result/evidence inputs.
- Files: source preview, file/object/revision associations, separate archive/build actions, drafts excluded by default.
- Connections: unavailable adapters, setup instructions, tool settings, dark/light and comfortable/compact choices.
- Commands: query filtering, keyboard Enter selection, correct object navigation, focus-managed dialog.
- Panels: show/hide Agent, switch to Inspector, full-width table layout, independently scrolling navigation/object/detail areas; inactive terminal is inert.
- Responsive checks: 1440 × 900, default browser 1280 × 720, and native minimum 1024 × 700. At minimum width the requirements surface had no page-level horizontal overflow and all three quantity fields remained readable.
- The presentation, local assets, and interactive entry links were inspected in the browser before delivery.

## Preview use

```sh
pnpm design:preview
```

- Presentation: `http://127.0.0.1:5173/design-system/`
- Workspace: `http://127.0.0.1:5173/?design-preview`
- Launcher: `http://127.0.0.1:5173/?design-preview&screen=launcher`
- Live catalog: `http://127.0.0.1:5173/?design-preview&screen=design-system`

The script prints its temporary data directory. Each restart creates fresh projects and a pending payload proposal. Approve that proposal to explore the focused stale-impact graph. Captured screens show several distinct states of the disposable project, not one simultaneous database snapshot.

The preview binds only to loopback. Exports and new projects are confined to its temporary directory. Agent execution and archive imports are disabled there. Do not expose this development server publicly. Run the preview separately from CPU-heavy builds: the real calculation engine has a 2-second timeout, and concurrent compilation can exceed it during fixture initialization. A clean standalone restart was successful.

## Remaining native/release validation

The redesign has not been packaged into an installer or tested with a live agent CLI during this design pass. Native folder dialogs, research browser interaction, OpenSCAD execution, and real PTY process lifecycle need desktop smoke validation. Automated domain tests cover the underlying engineering behavior, but do not substitute for that native validation.

A complete screen-reader/accessibility audit, Windows desktop pass, high-DPI/zoom pass, and large-project performance profiling remain release work. Enterprise organization/SSO/permissions/parallel-agent concepts in `design.md` are extension contracts, not implemented backend features. Legacy installer and protocol identifiers remain unchanged.
