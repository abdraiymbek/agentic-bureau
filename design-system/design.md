# Omen Flow design system — Lens

Version 2.0 · 23 September 2026 · **See the whole. Focus on one. Decide.**

Lens is the design language and interaction model of Omen Flow. It replaces the previous
sidebar-and-dashboard system entirely; no component, layout, or token from that system is a
compatibility constraint. The executable references are [`tokens.css`](tokens.css), the
primitives in `apps/desktop/src/renderer/ui/kit.tsx`, the stylesheet
`apps/desktop/src/renderer/styles/app.css`, and the in-app **Design system** view.

## 1. Why Lens exists

Omen Flow connects intent, parts, design, and evidence in one engineering record, and an agent
CLI does much of the authoring. The human's job shifts from _producing_ artifacts to _directing
and deciding_. An interface organised by file type and discipline — nine routes, a dashboard,
an inspector, a status bar — makes the human do the connecting. Lens organises the interface
around the three things a person actually does:

1. **See the whole system** and where a change is travelling.
2. **Focus on one thing** in the context of what it depends on and what depends on it.
3. **Decide** what the agent proposed, with the evidence and consequences in view.

## 2. Principles

1. **One thing in focus.** Everything else is context or one step away. There are no pages,
   only zoom levels.
2. **Space follows causality.** Inputs sit to the left, consequences to the right. Moving
   through the project means moving along its recorded links.
3. **The interface takes the shape of the work.** A part becomes a 3D stage, a calculation an
   equation, a requirement a statement with a target, a proposal a decision.
4. **Agents propose, people decide.** The agent types into a real terminal. Nothing becomes
   the baseline until a person approves it. Approval never means validated.
5. **Calm until it matters.** State appears when it asks something of you. Colour always comes
   with a word. Empty means genuinely nothing waiting.

## 3. Interaction model: semantic zoom

Omen Flow has three zoom levels and one agent surface. There is no navigation sidebar.

| Level        | What fills the stage                                                            | How you get here                                                 |
| ------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 0 · Project  | The whole project, seen through one lens: **Flow**, Parts, Timeline, Files      | Open a project, click the mark, `Esc` from anywhere, `⌘1–4`      |
| 1 · Object   | One object on the stage, its inputs on the left rail, consequences on the right | Click a node, a link on a rail, a row anywhere, or `⌘K`          |
| 2 · Decision | One proposal: changes in the centre, impact on the right, decision pinned below | The “to review” pill, a Needs-you row, “Change in review”, `⌘⇧D` |

- `Esc` zooms out one level. `⌘[` goes back along the path you actually took.
- The titlebar trail names only where you are (`Project › Mechanical › Camera tray`).
- The launcher is the only screen without a project. It asks one question — _What are you
  building?_ — and lists recent work.
- Settings (agents, engineering tools, appearance) is a sheet (`⌘,`), never a destination.
- The Design system view is reachable from the launcher and `⌘K`.

### Level 0 — Project

The project identity (name and editable one-line intent) floats top-left over the canvas; the
lens switcher sits top-right.

**Flow** is the primary navigation surface: a deterministic, layered map of every object.

- Columns read causally: **Intent** (requirements, assumptions) → **Parts** (sources, then
  components, as two sub-columns) → **Design** (concept, architecture, subsystem, mechanical,
  electronics, software, assembly, notes) → **Evidence** (calculations, tests).
- Within a column, objects group by type and order by the barycentre of their upstream (or,
  for pure inputs, downstream) neighbours, so links run as straight as possible. The layout is
  never hand-arranged and never random.
- **Hover lights the thread**: the full upstream and downstream causal chain through the
  object turns signal-coloured; everything else steps back to 28 % opacity.
- **Impact** is always visible: out-of-date objects carry an amber border and the edges on
  recorded stale paths turn amber. After an approval, the consequence path is legible at a
  glance.
- **Agent touch**: objects the agent changed in the last 15 minutes carry a soft signal ring.
- Marks on nodes: amber dot = out of date or in review; hollow ring = no approved baseline.
- A small legend and zoom/fit controls sit on the canvas edges. Nodes open their object.

**Needs you** is a floating island listing only what waits on a human: open proposals, then
out-of-date objects, then agent suggestions. When nothing waits it collapses to one quiet
line: “Every baseline is current and reviewed”.

**Parts** is the bill of materials (known cost, known mass, lines; unknowns labelled and
excluded from totals) with a Candidates mode for side-by-side comparison. **Timeline** is the
decision record grouped by day, with adjacent revision/baseline events merged. **Files** lists
working files by owning object and revision, with text preview, the project archive, and the
build package (drafts off by default).

An empty project shows the four layers as a dashed outline and one action that opens the agent
with a drafted first prompt.

### Level 1 — Object

A three-part composition: **left rail · stage · right rail**.

- **Left rail — Depends on**: upstream links (graph edges and recorded, pinned inputs) with the
  relationship in words. Below it, **Record**: origin, recorded time, evidence kind, bounds,
  identifier, and “Reveal files”.
- **Right rail — Affects**: downstream links, then **Related** (non-causal relations), then
  **Revisions** with the baseline marked and each rationale.
- Short connector lines lead from every rail link toward the stage. Clicking a link moves focus
  along the graph.
- **Stage header**: type and subsystem, title, “Ask agent”, then labelled states — review,
  freshness, “Change in review” (opens its proposal), drafts, revision.
- If an input changed or is missing, a notice names the path, e.g.
  `Payload capacity → Rover mass budget → this`, each step clickable.

Every stage resolves recorded revisions, including artifacts with no approved baseline. Latest
work selects the newest active draft descended from the current baseline (or the baseline when
there is no candidate). A revision picker can hold an explicit baseline or historical revision;
rejected work is never selected automatically. Header, record rail, inputs, files, and fields
must describe the displayed revision. Draft and historical content is labelled and baseline edit
controls are disabled there. Known fields populate from the payload; unknown quantities retain
their reasons. New observations, decisions, and messages require intentional input.

The stage takes the shape of the object:

| Type                                                 | Stage                                                                                                                                                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirement                                          | Statement as large editable text; target as one quantity field (value + unit); priority; acceptance; trace impact                                                                             |
| Assumption                                           | “Not an established fact” notice; statement, reason, owner, needs-validation                                                                                                                  |
| Mechanical                                           | STL viewport first, revision picker and view tools as floating islands; render/accept bar; parameters grid; source                                                                            |
| Calculation                                          | Result in large mono, expression, inputs as `name = quantity · source` rows, assumptions, limitations, re-run                                                                                 |
| Test                                                 | Procedure steps, conditions, recorded results, record-a-result form                                                                                                                           |
| Electronics                                          | Automatically drawn, sanitised diagram for the displayed revision; validate and redraw actions, labelled findings, pins, voltage ranges, connections, ratings, and coverage                   |
| Component                                            | Part number, maker, selection, sourced properties and attributes; supplier offers with recorded web destinations, quantity basis, observation time, availability, and explicit unknown prices |
| Source                                               | The excerpt as a quotation, publisher, kind, capture time, URL                                                                                                                                |
| Assembly                                             | Numbered steps with tools, calibration, and linked components                                                                                                                                 |
| Concept · architecture · subsystem · software · note | Readable prose with an edit toggle; concept dimensions, systems, alternatives, uncertainties, and saved visuals; software metadata and immutable file previews                                |

Edits appear in a save bar that only becomes prominent when something changed. Saving creates
a revision; the copy says so.

### Level 2 — Decision

The same three-part grammar: **queue · proposal · impact**.

- Left rail: “Needs you / All” and the queue.
- Centre: “Proposal n of m” with previous/next, the reason as the title, who proposed it and
  when, supersede notices, then one section per change with the object (clickable), change
  kind, and `r1 → r2`. Diffs are field-level rows; quantities change atomically:
  **0.3 kg → 0.5 kg**. Mechanical changes render the bound meshes with a baseline overlay,
  verification checks, declared scope, and coverage limits.
- The decision bar is pinned to the bottom of the stage: rationale, then **Reject** (demoted,
  far left), **Request changes**, and **Approve changes** (`⌘↵`).
- Right rail: “Would affect” and a standing note on what approval means.
- After a decision: a notice with **Resume agent from decision**, which types a precise
  continuation instruction into the running CLI.

### The agent: composer and console

The agent is docked at the bottom as a floating island, present on every project screen.

- **Collapsed**: agent chip (status light + provider; menu to switch provider or open setup),
  the composer, and the primary action — **Start {agent}** when idle, **Send** when running.
  The latest agent-originated change appears as a quiet, clickable line.
- **Context travels with focus**: on an object, the composer shows a removable `@Object`
  chip. Sending prefixes the message with the object's type, title, artifact id, and revision
  so the agent's tools can act on exactly that object.
- **Expanded** (`⌘J`): the island widens and reveals the real PTY terminal above the composer —
  resizable, searchable, with interrupt, stop, and restart. The composer writes to the same PTY
  using bracketed paste; nothing is paraphrased, summarised, or fabricated.
- `⌘K` offers “Ask {agent}: …” for any sentence typed while a session runs.

## 4. Visual language

### Colour

Two themes share roles: **Graphite** (default) and **Paper**. `tokens.css` is the only source.

| Role      | Token                            | Use                                             |
| --------- | -------------------------------- | ----------------------------------------------- |
| Field     | `--field`                        | Window, map canvas, rails                       |
| Surface   | `--surface`                      | The stage in focus                              |
| Raised    | `--raised`, `--raised-2`         | Islands, menus, hover, inputs                   |
| Inset     | `--inset`, `--terminal-bg`       | Code, terminal, viewport wells                  |
| Text      | `--text`, `--text-2`, `--text-3` | Content, support, metadata                      |
| Signal    | `--signal`, `--signal-text`      | Live agent, focus ring, the lit thread, context |
| Positive  | `--ok`                           | Approved, current, passed                       |
| Attention | `--warn`                         | Needs review, out of date                       |
| Error     | `--err`                          | Missing input, failure, rejection               |
| Primary   | `--primary`, `--primary-ink`     | The one decisive action per area                |

- **Signal lime is the only chromatic accent outside state.** It means _alive or selected_:
  a running agent, keyboard focus, the hovered causal thread, the context chip. It is never a
  category colour and never decoration.
- Primary actions are high-contrast neutrals (white on Graphite, black on Paper).
- State colours always pair with a word (`State` renders a dot plus a label).

### Type

Geist for the interface; IBM Plex Mono for values, identifiers, parameters, source, and the
terminal. Both are vendored in `fonts/`.

| Token        | Size | Role                                  |
| ------------ | ---- | ------------------------------------- |
| `--text-3xl` | 38   | Launcher question, calculation result |
| `--text-2xl` | 26   | Project and object titles             |
| `--text-xl`  | 19   | Statements, target values, totals     |
| `--text-lg`  | 15   | Lede, omnibar input                   |
| `--text-md`  | 13.5 | Working text                          |
| `--text-sm`  | 12.5 | Controls, rails, tables               |
| `--text-xs`  | 11.5 | Metadata                              |

Display sizes use `--tracking-display`. Numbers use tabular figures. Sentence case everywhere;
no all-caps labels.

### Geometry, depth, motion

- Spacing is 4-based (`--s-1` … `--s-12`). Controls are 26 / 32 / 38 px.
- Radii: 6 (small controls), 8 (controls), 11 (menus, nodes), 15 (islands), 20 (stage, sheet).
- Depth has three planes: the **field** (flat), the **stage** (surface, 1 px line, no shadow),
  and **islands** (raised, `--shadow-float`) that hover over the field or stage: Needs you,
  composer, viewport tools, map controls, menus, omnibar, sheet.
- Motion is functional: 120 ms feedback, 200 ms state, 320 ms zoom and sheet. Zooming into an
  object uses a subtle scale-in. Only live things pulse. `prefers-reduced-motion` removes all
  of it.

### Brand

The mark is three facets meeting at one point — intent, design, and evidence converging. It is
vectorised from the supplied artwork (`brand/source-mark-*.png`) as `brand/omen-mark.svg`
(`currentColor`) and rendered in code by `Mark`.

- Monochrome only: `--text` on Graphite, black on Paper. Never tinted with signal.
- Sizes: 17 px titlebar button, 18–22 px lockup, 30–34 px launcher and catalogue hero.
- Wordmark **Omen Flow** in Geist; “Omen” semibold, “Flow” regular and secondary.
- The app icon (`brand/app-icon.svg` → `apps/rust-desktop/icons/`) places the Paper mark on a
  graphite squircle with a faint rim.
- Keep clear space of half the mark's width. Don't stretch, rotate, outline, or animate it.

## 5. Primitives

All live in `ui/kit.tsx` and appear in the Design system view.

| Primitive            | Purpose                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `Mark`, `Brand`      | Identity                                                                     |
| `TypeGlyph`, `TYPES` | Neutral object glyphs, labels, plurals, and causal layer for all 14 types    |
| `State`, `Pulse`     | Labelled state (review, freshness, execution); live pulse for running things |
| `Button`             | `primary` · `secondary` · `ghost` · `danger` · `signal`; `sm` · `md` · `lg`  |
| `IconButton`         | Named icon-only action (label doubles as tooltip)                            |
| `Segmented`          | Lens and mode switching with optional counts                                 |
| `Field`              | Label + control + hint with connected ids                                    |
| `Notice`             | Inline, toned explanation with an optional action                            |
| `Empty`              | Specific empty state with a recovery                                         |
| `Disclosure`         | Progressive detail with contextual actions                                   |
| `Block`, `Facts`     | Quiet labelled sections and key/value metadata                               |
| `Kbd`, `Spinner`     | Shortcuts and active work                                                    |

Composite patterns: map node, rail link node, stage header, save bar, diff row, decision bar,
composer, island, sheet, omnibar.

## 6. Engineering integrity

These rules outrank aesthetics.

- **Quantities keep their units**, atomically, in values, diffs, and tables.
- **Unknown stays unknown.** It is never shown as zero, never summed, and is labelled with
  its reason when one was recorded.
- **Review, freshness, evidence, and execution are separate dimensions** and are shown
  separately. Approved ≠ current ≠ validated.
- **Provenance is one click away**: every sourced property links to its source; every
  recorded input shows its relationship and whether it is pinned.
- **Illustrative data is labelled** (e.g. the preview mesh). A calculation marks itself
  experimental where the engine is.
- **No fabricated agent activity.** The composer writes to the real PTY; activity lines come
  from recorded events; running state comes from the session.
- **Exports report success only after the operation returns.**

## 7. Keyboard and accessibility

| Shortcut    | Action                                |
| ----------- | ------------------------------------- |
| `⌘K` / `⌘P` | Omnibar: go to, run, or ask           |
| `Esc`       | Zoom out one level                    |
| `⌘[`        | Back                                  |
| `⌘J`        | Show or hide the agent terminal       |
| `⌘⇧D`       | Decisions                             |
| `⌘1`–`⌘4`   | Flow, Parts, Timeline, Files          |
| `⌘↵`        | Approve (in a decision)               |
| `⌘,`        | Settings                              |
| `Enter`     | Send to agent (`⇧Enter` for new line) |

Focus rings use `--focus` in both themes. Icon-only buttons have names. Dialogs (omnibar,
sheet, menus) trap and return focus via Radix. The map exposes each node with an accessible
label; the viewport documents its keyboard alternative. Toasts use a live region. Target WCAG
AA for essential text; verify with VoiceOver before release.

## 8. Layout

- Titlebar 48 px with macOS overlay traffic lights (70 px reserved); the whole bar drags.
- Rails 248 px, 216 px below 1280, 196 px below 1120. The stage takes the rest.
- Supported from **1024 × 700**; designed at **1440 × 900**.
- Scrolling belongs to regions: rails, stage, lens pages, terminal, omnibar list, sheet.

## 9. Extending Lens

Before adding a surface, answer: which zoom level, which object type, what the one decisive
action is, what evidence must be visible, and which states apply. Then:

1. Prefer a new **stage** for a new object type or a new **lens** for a new projection of the
   whole project. Don't add pages, sidebars, or dashboards.
2. Put context on rails, secondary detail in disclosures, and configuration in the sheet.
3. Use existing primitives; add a primitive only when a need repeats, with a catalogue
   specimen and both themes.
4. A new token needs a semantic role in both themes.
5. Consider empty, loading, failure, read-only, pending, and success states.
6. Verify at 1024 × 700 and 1440 × 900 in both themes, then update this document,
   `verification.md`, and the catalogue together.

Never add: metric-card dashboards, decorative charts, gradient heroes, glowing
purple, fake chat bubbles, unlabelled colour, or collaboration features that don't exist.

## 10. Implementation map

| Concern                           | Source of truth                                          |
| --------------------------------- | -------------------------------------------------------- |
| Tokens (both themes)              | `design-system/tokens.css`                               |
| Fonts and licences                | `design-system/fonts/`                                   |
| Brand                             | `design-system/brand/`                                   |
| Primitives                        | `renderer/ui/kit.tsx`                                    |
| Styling                           | `renderer/styles/app.css`                                |
| Zoom model, keyboard, events      | `renderer/App.tsx`, `renderer/store.ts`                  |
| Titlebar, omnibar, console, sheet | `renderer/shell/`                                        |
| Project lenses and flow map       | `renderer/project/`                                      |
| Object focus and stages           | `renderer/object/`                                       |
| Decisions                         | `renderer/decide/`                                       |
| Launcher                          | `renderer/launcher/`                                     |
| Catalogue                         | `renderer/system/DesignSystemView.tsx`                   |
| Lineage and actions               | `renderer/lib/graph.ts`, `renderer/lib/actions.ts`       |
| Disposable preview                | `scripts/design-preview.ts`, `renderer/preview.ts`       |
| Screens                           | `design-system/screenshots/`, `design-system/index.html` |
