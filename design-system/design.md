# Omen Flow design system

Version 1.0 · 19 September 2026 · **Precision in flow**

This is the canonical design specification for Omen Flow. It replaces the previous renderer’s visual language. New features must extend this system. The executable references are `tokens.css`, the shared renderer components, and the in-app **Design system** page. The accompanying `index.html` presents the redesign with captured screens.

## 1. Product and design intent

Omen Flow is an AI engineering workspace for builders and engineering teams. It connects intent, constraints, physical and software design, sourced components, calculations, validation, and human decisions in one persistent project. The engineering record lives independently of any agent conversation.

The product must feel calm enough for daily personal work and precise enough for serious engineering review. Its identity comes from continuous context and trustworthy state: a requirement connects to a model, a calculation, a part, a test, and a decision. The name “Omen” suggests seeing what comes next; “Flow” describes how those decisions remain connected. Do not turn that idea into mystical imagery or science-fiction instrumentation.

Three principles govern every screen:

1. **Intent before decoration.** Give the engineer a legible object, its context, and the action they need. Prefer typography, rows, and alignment to ornamental panels.
2. **Evidence before confidence.** Preserve units, provenance, uncertainty, revisions, and limitations. An approved record can still be out of date. A calculated result is not a measured result.
3. **One continuous workspace.** Navigation, engineering content, and the agent share a stable shell. Changes of discipline should not feel like changes of product.

The quality benchmarks are the focus of modern developer workspaces, the clarity of conversational tools, and the canvas hierarchy of professional CAD. This is an original Omen Flow system, not a reproduction of another product’s brand or UI.

## 2. Architecture and levels

| Level            | Purpose                             | Surface                                                                             |
| ---------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| Application      | Find or begin work                  | Project launcher, recent projects, new-project dialog, appearance                   |
| Project          | Understand intent and health        | Overview, engineering record, attention queue, recent decisions                     |
| Discipline       | Browse coherent engineering objects | Requirements, Design files, Parts & materials                                       |
| Object           | Inspect and work on one item        | Type-specific editor or canvas, baseline revision, draft and freshness states       |
| Evidence         | Explain a value or decision         | Inspector, source record, input binding, calculation assumptions, test observations |
| Decision         | Review a proposed change            | Review queue, before/after diff, downstream impact, rationale, approval             |
| System           | See connections through time        | History & impact graph and change log                                               |
| Delivery         | Move a reproducible record          | Files, source preview, BOM export, build export, project archive                    |
| Configuration    | Make tools available                | Agent connections, engineering tools, diagnostics, appearance                       |
| Design reference | Keep extensions consistent          | Live component catalog and this specification                                       |

Internal domain terms remain valid in APIs. Prefer the user-facing names in navigation. “Design files” includes structured objects as well as files; do not silently collapse the engineering record into a filesystem tree.

### Navigation

Primary order: **Overview → Requirements → Design files → Parts & materials → Review queue → History & impact → Files & exports**. Project object shortcuts sit below these routes in their own scrolling region. Connections and Design system stay at the bottom. The project switcher opens another active project or the launcher. Long names truncate with their full text available through tooltips or the selected detail.

Only show counts from actual project state. Pending reviews and out-of-date objects are useful interruptions; decorative activity counters are not.

## 3. Brand assets

Use `brand/omen-symbol.svg`. Its two opposing directional arcs form an open O and imply iteration. Render in one color using `currentColor`/CSS mask. Do not redraw, stretch, rotate, animate continuously, add gradients, or place it inside an unrelated icon tile.

- Symbol: 21 px in titlebar, 26 px in ordinary lockups, approximately 36 px at project entry.
- Wordmark: **Omen Flow** in Geist. Omen is medium/semibold, Flow regular and secondary. Sentence casing is fixed.
- Maintain at least half a symbol’s width of clear space around standalone marks.
- Keep the brand present at entry and in global chrome. Do not stamp it on every object or chart.
- Previous Michroma lettering, aircraft artwork, ASCII aircraft, and STARK display branding are retired from the renderer. Original assets may remain for provenance; they are not design resources for new work.

The display name is Omen Flow. The existing `@stark/*` packages, bridge identifiers, `.stark` storage, archive compatibility, and installer names are legacy technical contracts. Their migration is a separate release task; do not rename them incidentally while building UI.

## 4. Foundations

### Color

`tokens.css` is the single source of truth. The renderer imports it. Both themes use the same semantic roles; never scatter copied hex values through feature components.

| Role                 | Dark      | Light     | Meaning                                    |
| -------------------- | --------- | --------- | ------------------------------------------ |
| Application          | `#161719` | `#eeeef0` | Global chrome and agent surroundings       |
| Workspace            | `#1c1d20` | `#fafafb` | Main working surface                       |
| Raised               | `#25272b` | `#ffffff` | Menus, selected navigation, controls       |
| Inset                | `#131416` | `#f1f2f4` | Editors, search, code regions              |
| Primary text         | `#eff0f2` | `#25272d` | Content and headings                       |
| Secondary text       | `#b2b4bd` | `#575d69` | Supporting explanations                    |
| Muted text           | `#90949f` | `#666d7a` | Metadata, captions, secondary icons        |
| Accent               | `#a8bcfa` | `#355cc7` | Focus and active selection                 |
| Selection background | `#28334c` | `#e4eaf9` | Selected engineering object                |
| Positive state       | `#9ac7ac` | `#34694d` | Approved/current/passed, always labeled    |
| Attention            | `#e0bb80` | `#856019` | Pending/out of date/needs review           |
| Error                | `#eea3a6` | `#ad3946` | Missing required input, failure, rejection |
| Divider              | `#303237` | `#dbdde3` | Passive grouping                           |
| Control boundary     | `#4d5059` | `#aaafba` | Interactive or elevated boundaries         |

Primary buttons are high-contrast neutrals. Blue is not a fill for every action. Status colors must never be repurposed as category decoration. CAD uses dedicated canvas, grid, and model tokens. Shadows belong on overlays, not every row or section.

### Typography

Fonts are vendored in `fonts/` with licenses and subset declarations in `fonts/fonts.css`. There is no runtime font CDN dependency.

| Role                            | Typeface      | Size / treatment                         |
| ------------------------------- | ------------- | ---------------------------------------- |
| Project identity                | Geist         | 24–32 px, medium, tight tracking         |
| Launcher statement              | Geist         | Up to 38 px, medium, one clear headline  |
| Page title                      | Geist         | 20 px, medium/semibold                   |
| Object title                    | Geist         | 18–19 px, medium/semibold                |
| Section heading                 | Geist         | 13–15 px, medium                         |
| Working content                 | Geist         | 13 px, regular, 1.5 line height          |
| Tables, controls, detail labels | Geist         | 12–13 px                                 |
| Metadata and badges             | Geist         | 11–12 px; 10 px only for tertiary chrome |
| Source, expressions, terminal   | IBM Plex Mono | 12–13 px; results may use 20 px          |

Use tabular numerals for measurements and monetary values. Do not set whole tables in monospace. Never reduce essential information to tiny text just to fit. Use horizontal table scrolling or collapse optional panels.

### Spacing, geometry, motion

The spacing scale is **4, 8, 12, 16, 24, 32, 48 px**. Standard page padding is 24–30 px; groups have 20–24 px separation; paired controls use 8 px. Small optical offsets are acceptable in chrome, not a reason to create another spacing system.

Controls: 32 px comfortable, 28 px compact. Tables: 40 px minimum row height, 32 px compact, expanding for secondary lines. Compact density changes padding, not font legibility. Icon buttons are approximately 30 px. Desktop interaction targets must stay at least 24 px.

Radii: 6 px controls, 10 px menus, 12 px panels. Capsules are not the default shape. Use 1 px divisions, avoid repeated nested cards. Motion is functional: 120 ms control feedback, up to 180 ms panel movement. Respect `prefers-reduced-motion`. No ambient animation, entrance choreography, animated gradients, or decorative particle effects.

## 5. Workspace composition

The titlebar is 46 px and reserves macOS traffic-light space. The navigation rail is 218 px, reducing to 190 px near the native minimum size. Main content occupies the remaining flexible area. An optional right side panel starts at 29% of the workspace, is resizable, and contains **Agent / Inspector**. The status strip is 26 px.

- Main content gets a restrained top corner radius and one enclosing boundary.
- Breadcrumbs remain 43 px high above the current workspace.
- Object browsers are 224 px, reducing to about 184 px when the working surface narrows.
- The agent, object list, editor, and timeline own their scrolling independently. Keep global navigation and the status strip available.
- Closing the side panel returns its area to the engineering workspace. Switching to Inspector preserves the terminal session.
- Dense tables scroll horizontally inside their own container; the entire application must not overflow horizontally.
- Desktop support baseline: **1024 × 700**, typical **1440 × 900**. Validate both, plus the actual preview viewport. This release is a desktop workbench, not a shipped mobile application.

## 6. Screen contracts

### Project launcher and creation

A personal workspace rail, one deliberate project brief composer, and recent project rows. An idea can become a project without navigating a marketing page. Creation asks for name, optional brief, and a real folder. Keep the typed brief when the dialog opens. Show local ownership and actual paths. Recent project loading, no projects, no search results, and failure/retry are distinct states.

The preview uses disposable projects. Production keeps native folder and archive pickers. Do not fabricate recency timestamps, collaborators, storage quotas, or cloud synchronization.

### Overview

Start with project name and intent. Then show compact actual counts and actionable attention items. Follow with engineering disciplines, the engineering record, and recent decisions. Attention rows link to review or affected objects. Empty projects explain how an agent begins the record. Avoid a generic dashboard grid of unrelated cards or vanity metrics.

### Requirements and assumptions

Use a searchable object list beside a readable form. Every requirement exposes its statement, numeric target and unit, priority, acceptance criterion, review state, revision, and freshness. Keep units adjacent to values. Save only when changed. Preview impact shows named affected objects. Assumptions retain their reason, ownership, and validation need; they must remain distinguishable from requirements and established facts.

### Design files

One grouped browser serves multiple engineering disciplines. Object type determines the working surface:

| Type                                | Primary surface                                                             | Evidence/context                                                     |
| ----------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Mechanical                          | STL canvas, view controls, parameters, source editor, render/export actions | Revision, tool availability, mesh provenance, downstream inputs      |
| Wiring                              | Pin/connection tables and derived diagram                                   | Validation messages and coverage limits                              |
| Calculation                         | Expression, recorded inputs, unit-bearing result                            | Source bindings, changed inputs, assumptions, limitations, tool/time |
| Software                            | Language, entry point, notes and attached files                             | Revision and dependencies                                            |
| Test                                | Procedure and observations/results                                          | Conditions, measured vs planned evidence, related requirements       |
| Assembly                            | Numbered instructions, tools, linked components                             | Calibration and sequence                                             |
| Component                           | Manufacturer/part number, selection, engineering properties                 | A source for each sourced property, unknowns and missing fields      |
| Source                              | Publisher, URL/location, capture time, excerpt                              | Origin and recorded evidence                                         |
| Concept/architecture/subsystem/note | Readable structured text and relationships                                  | Alternatives, uncertainties, revision and provenance                 |

The canvas is functional engineering space. Use neutral model material and quiet grid. Never use an attractive placeholder mesh without clearly identifying it. The included preview tray is **illustrative geometry, not a verified OpenSCAD render or manufacturing model**.

A calculation action must describe which inputs it uses. Re-running recorded inputs creates a proposal for the same object; it does not silently rewrite bindings or certify an out-of-date design. Preserve baseline history and show an explicit changed-source notice.

### Parts & materials

BOM and Candidates are adjacent modes. BOM keeps part identity, quantity, cost, mass, subsystem, and engineering state in aligned columns. Known totals are labeled as known totals; absent prices or masses do not become zero. Candidates support deliberate selection and side-by-side property comparison. Export acts on real project data. Keep full part numbers readable through wrapping, tooltips, or scrolling.

### Review queue

The review list stays distinct from the selected proposal. Present a human title, change count, baseline/proposed values, named downstream impact, and decision rationale. Quantities remain atomic in the diff: **0.3 kg → 0.5 kg**, not disconnected value and unit changes.

Approval is the single primary decision action. Request changes and Reject remain distinct, clearly labeled alternatives. Pending, approved, rejected, and changes requested have different states. Disable controls during a decision. A successful decision refreshes the project record and its impact state. Human approval never means the model has passed validation or become fit for manufacture.

### History & impact

Provide a dependency graph and a chronological change log. Use horizontal directional links and named object nodes. When inputs have changed, default to the affected path so the engineer can read the consequence. “Entire project” remains available. Nodes navigate to the proper object workspace. Keep the graph functional: zoom, pan, fit, labels, and a legend. A graph is not a decorative hero illustration.

### Files & exports

Use a file table with object and revision context. Text previews preserve source formatting; binary files explain why no text preview exists. Distinguish a complete project archive from a build package. The include-drafts option is explicit and off by default. Do not claim an export is ready before the operation returns successfully.

### Connections and appearance

Show actual agent availability, setup instructions, and test outcomes. Support the existing Codex CLI, Claude Code, and custom CLI adapters, plus engineering tools such as OpenSCAD. Progressive disclosure holds advanced executable arguments and diagnostics. Show the difference between “not detected,” “configured,” and “working.” Theme and density controls share this system.

### Agent and Inspector

The Agent panel explains project context before connecting and provides a real embedded terminal after connection. Keep provider, find, expand, interrupt, stop, and restart discoverable. Display actual session state. Do not replace the functioning CLI with fabricated conversational bubbles or invented progress.

Inspector explains the selected object without forcing a route change: baseline, review/freshness, properties, sources, inputs, dependents, and stale reasons. Empty selection, loading, and read failures must remain intelligible. Technical identifiers belong in metadata, not as the first or only label.

## 7. Component and interaction rules

Shared primitives live in `apps/desktop/src/renderer/components/ui.tsx`:

- `Brand`, `ArtifactIcon`: consistent identity and object language.
- `IconButton`: accessible name, native hover title, focus ring, forwarded ref for Radix.
- `PageHeader`, `SectionHeading`: stable heading and action placement.
- `StatusBadge`: text plus icon plus semantic color.
- `ObjectRow`: selected state, name, revision metadata, attention indicator.
- `SearchField`: visible query, accessible label, clear action.
- `FormField`: connected label, input ID, optional described hint.
- `EmptyState`: specific explanation and a relevant recovery or first action.

Use native controls and the installed Radix primitives before adding UI libraries. Use Phosphor regular icons: generally 14 px in tight controls, 16 px navigation, 20–24 px major empty states. Category icons remain neutral; active selection can use accent. Do not mix emoji, several icon families, or arbitrary colored tiles.

One primary action per decision area. Button text describes the outcome: “Approve changes”, “Save requirement”, “Export build”. Loading states keep their width and use active verbs. Do not use generic “Submit” when the result has a clear name. Hover must not move layout. Keyboard focus must be visible independently of hover.

### State model

| Dimension    | States                                                  | Display rule                                         |
| ------------ | ------------------------------------------------------- | ---------------------------------------------------- |
| Review       | Draft, in review, approved, rejected, changes requested | Persistent labeled badge                             |
| Freshness    | Current, out of date, missing input                     | Separate from review; explain the changed dependency |
| Evidence     | Assumed, sourced, calculated, measured, unverified      | Preserve original evidence kind and limitations      |
| Execution    | Idle, starting, running, complete, failed, cancelled    | Actual tool/session state, actionable errors         |
| Data loading | Loading, ready, empty, failed                           | Never show “nothing here” while still loading        |
| Permissions  | Editable, read-only, unavailable capability             | Explain the reason and disable mutation controls     |

Never infer a successful tool run from a rendered UI. Never collapse unknown into zero, missing into false, or approved into validated. Failure text must name what failed and the next useful action. Preserve user input after failures and surface conflicts rather than overwriting another revision.

### Keyboard and accessibility

`⌘/Ctrl K` opens commands; `⌘/Ctrl P` finds objects; `⌘/Ctrl J` toggles Agent; `⌘/Ctrl B` toggles navigation; `⌘/Ctrl Shift I` opens Inspector. The palette supports arrows, Enter, and Escape. Dialogs trap focus and return it on close. Hidden panes must not capture keyboard focus. Inputs have explicit labels; icon-only buttons have names; status is never color-only; toasts use live regions.

Target WCAG AA for essential text and controls, including focus state in both themes. Passive dividers need not be high contrast. Treat the captured checks as implementation verification, not an accessibility certification. Before broad release, test with keyboard-only navigation, VoiceOver/NVDA, scaling, and real long project content.

## 8. Enterprise extension contracts

These are **future feature design contracts**, not claims of implemented organization, SSO, synchronization, billing, or policy features.

- **Workspace/organization:** Extend the launcher’s scope switcher with Personal and named organizations. Each row has a text identity and role. Keep actual project navigation identical after entry.
- **Members and permissions:** Use a settings table with person, role, scope, status, and last relevant event. Separate invitation drafts from sent invitations. Permission editing belongs in a focused dialog with an explicit affected scope.
- **Project policy:** Put review rules, allowed tools, and external-data restrictions in Project settings with clear inheritance from organization. Show a policy reason at the blocked action, not only in settings.
- **Review at scale:** Extend the existing proposal row with author, reviewer, and age. Add filters and assignment without replacing the readable diff. Required reviewer decisions must remain distinct from simulation/test results.
- **Release/build readiness:** Summarize blocking requirements, stale calculations, missing evidence, unreviewed changes, and the exact artifact revisions included. Offer export only according to actual backend policy. Do not add a cosmetic “ready for production” score.
- **Parallel agents:** Show an agent/session list with scope, running task, tools, and waiting decisions. Activity feeds link to immutable proposals. Agent identity must never be mistaken for a human reviewer.
- **Audit:** Extend History with actor, timestamp, operation, object/revision, and rationale. Preserve access to raw identifiers in a details disclosure. No invented audit certificates.
- **Remote/sync failure:** Show local, syncing, offline, and conflict states only when supported. Conflicts require explicit revision comparison and resolution. The current app is local-first.

New enterprise features should reuse the table, object/detail, review, settings, and dialog patterns. “Enterprise” means reliable behavior, information density, permissions, and traceability—not more chrome.

## 9. Implementation map and resources

| Resource                                      | Source of truth                                        |
| --------------------------------------------- | ------------------------------------------------------ |
| Semantic themes, type scale, spacing, density | `design-system/tokens.css`                             |
| Fonts and licenses                            | `design-system/fonts/`                                 |
| Brand symbol                                  | `design-system/brand/omen-symbol.svg`                  |
| Shared primitives                             | `apps/desktop/src/renderer/components/ui.tsx`          |
| Layout and component styling                  | `apps/desktop/src/renderer/global.css`                 |
| Launcher styling                              | `apps/desktop/src/renderer/views/welcome.css`          |
| Shell, keyboard, panel behavior               | `apps/desktop/src/renderer/App.tsx`                    |
| Preferences and project state                 | `apps/desktop/src/renderer/store.ts`                   |
| Interactive component catalog                 | `apps/desktop/src/renderer/views/DesignSystemView.tsx` |
| Screen reference gallery                      | `design-system/index.html` and `screenshots/`          |
| Disposable preview                            | `scripts/design-preview.ts`, renderer `preview.ts`     |
| Resource provenance                           | `design-system/resources.json`                         |
| Verification record                           | `design-system/verification.md`                        |

No stock photography or AI-generated raster imagery is required. Engineering output is the product’s visual content. Font licenses accompany the vendored files. Package libraries retain their own licenses in the dependency tree; versions are pinned by `pnpm-lock.yaml`.

Design references consulted: [Cursor theme customization](https://cursor.com/help/customization/themes) for consistent editor themes, and [Autodesk Fusion UI tour](https://www.autodesk.com/learn/ondemand/tutorial/tour-the-fusion-user-interface) for the separation of navigation, canvas, and contextual work. These are references for design interpretation, not endorsements or resources copied into Omen Flow.

## 10. Extending the system

Before implementation, identify the product level, object type, primary action, evidence requirements, and states. Reuse an existing surface where possible. Read `tokens.css` and the closest view, then add or extend a shared primitive if the need repeats. A new token requires a semantic purpose in both themes. Add a catalog specimen for a new reusable component.

A feature is ready for design review only when:

- It uses the canonical fonts, tokens, icons, spacing, and terminology.
- Real engineering values retain units, sources, uncertainty, and revision context.
- Empty, loading, failure, read-only, pending, and success states are considered where applicable.
- Its controls perform their stated actions and preserve the human review boundary.
- It works with long names and at the native minimum size; scroll belongs to the right region.
- Keyboard focus is visible, input and icon labels are present, and dialogs behave correctly.
- Both themes and density choices remain coherent.
- Relevant tests and a visual pass succeed; changed reference screens and this specification are updated together.

Do not introduce gradient hero panels, arbitrary purple glow, metric-card grids, fake agent conversations, random charts, gratuitous border boxes, glassmorphism, excessive all-caps labels, or unsupported collaboration controls. The project itself should command attention.
