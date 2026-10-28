# Bureau design system — Lens

Version 3.0 · 27 October 2026 · **See the whole. Focus on one. Decide.**

Lens is the interaction model of Bureau (Agentic Bureau, formerly Omen Flow): three zoom
levels in a causal grammar. Version 3.0 gives it the Bureau visual language: a Carbon window,
one sheet for the work, a navigation sidebar (never a dashboard), Mona Sans and JetBrains Mono,
one cyan signal, soft frames and square pixels taken from the mark, and dark and light themes
that share every role. The executable references are [`tokens.css`](tokens.css), the
primitives in `apps/desktop/src/renderer/ui/kit.tsx`, the icons in
`apps/desktop/src/renderer/ui/icons.tsx`, the stylesheets in
`apps/desktop/src/renderer/styles/`, and the in-app **Design system** view.

## 1. Why Lens exists

Bureau connects intent, parts, design, and evidence in one engineering record, and an agent
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
4. **Agents propose, people decide.** The agent works in a real terminal or a real headless
   run, never a scripted one. Nothing becomes the baseline until a person approves it.
   Approval never means validated.
5. **Calm until it matters.** State appears when it asks something of you. Colour always comes
   with a word. Empty means genuinely nothing waiting.

## 3. Interaction model: semantic zoom

Bureau has three zoom levels plus the agent. Navigation is the **sidebar** on the window's
left edge: the project and its census, search, the Agent, Decisions, the lenses and the
project's conversations. The work sits on one **sheet** beside it. There is no dashboard.

| Level        | What fills the stage                                                                               | How you get here                                                 |
| ------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Agent        | The conversation or the real agent terminal (PTY) under a slim session bar, with the activity rail | The first activity-bar tab, “Agent” in `⌘K`                      |
| 0 · Project  | The whole project, seen through one lens: **Flow**, Parts, Timeline, Files, Evidence               | Lenses in the sidebar, `Esc`, `⌘1–5`                             |
| 1 · Object   | One object on the stage, its inputs on the left rail, consequences on the right                    | Click a node, a link on a rail, a row anywhere, or `⌘K`          |
| 2 · Decision | One proposal: changes in the centre, impact on the right, decision pinned below                    | The “to review” pill, a Needs-you row, “Change in review”, `⌘⇧D` |

- `Esc` closes the topmost layer (menu, dialog, sheet, omnibar) and only then zooms out one
  level, to where you came from: an object returns to the lens it was opened from, a decision
  to the object it was opened from (else the project), another lens to Flow. `⌘[` and `⌘]` go
  back and forward along the path you actually took.
- Changing level moves the stage: a deeper level grows into place from what was pressed, a
  wider one settles from above (the project level fades, so the map fits to still geometry).
  Moving across a level does not move the stage.
- Edits are never silently lost. Every navigation (a click, a shortcut, `Esc`, back and
  forward, closing or switching the project) asks before it discards unsaved work, with one
  prompt that lists what would be lost; **Keep editing** is the default. Discarding takes
  effect only once the move happens: opening another project asks after the folder is chosen
  and the project has opened, and a cancelled pick, a failed open, choosing to stay, or a close
  that fails keep the edits. Back or forward with nowhere to go asks nothing. The agent cannot
  navigate over unsaved work: the view stays and a toast says why. Native window close and
  application quit use the same prompt, including parked edits; canceling either the edits
  prompt or the running-agent prompt keeps the work.
- The sheet's header names only where you are (`Calculation › Wheel torque at 15° incline`);
  the project's name is in the sidebar.
- The launcher is the only screen without a project. It asks one question — _What are you
  building?_ — creates the project in a named folder it shows before anything is written, and
  lists recent work.
- The **introduction** plays over the launcher once on first launch, and again from Settings
  (Appearance), the launcher's footer, `⌘K` or the catalogue. It is the one place that stretches
  the language: four acts play the product on the rover's own map (arrive; _see the whole_, the
  map draws itself left to right and its thread lights; _focus on one_, the camera tray zooms
  into its stage and renders live; _decide_, the person approves a proposal themselves and the
  impact travels the recorded links), then five setup steps do the real thing (detect and choose
  the agent CLI, probe OpenSCAD, pick Dark or Light, press the shortcuts, see where
  everything lives). One causal rail along the bottom is the progress; `→` and `←` move, `Esc`
  skips, nothing in it reaches a record, and it is remembered as the version seen
  (`bureau.intro`), so a reworked introduction plays again for everyone.
- Settings is a sheet (`⌘,`) with three remembered sections (Agents, Engineering tools,
  Appearance), never a destination.
- The Design system view is reachable from the launcher and `⌘K`.

### Level 0 — Project

The project identity (name and editable one-line intent) floats top-left over the canvas; the
lenses are rows in the sidebar. Opening a project shows its name and intent with a
placeholder until its record loads; a project whose record could not be read says what failed
and offers **Try again**. A project reopens on the view it was left on. A background refresh
that fails keeps the record on screen and says so in the frame strip, with Retry.

**Flow** is the primary navigation surface: a deterministic, layered map of every object.

- Columns read causally: **Intent** (requirements, assumptions) → **Parts** (sources, then
  components, as two sub-columns) → **Design** (concept, architecture, subsystem, mechanical,
  electronics, software, assembly, notes) → **Evidence** (calculations, tests).
- Within a column, objects group by type and order by the barycentre of their upstream (or,
  for pure inputs, downstream) neighbours, so links run as straight as possible. The layout is
  never hand-arranged and never random. Column widths follow the titles; a long title takes
  two lines.
- **Links** change height only inside the gutters between columns and pass a column through
  the gaps between rows. Every link ends in a small square at the consequence end. Dashed
  means related (not causal); dotted means it runs right to left; a link within one column is
  a bracket on the column's right.
- **Hover lights the thread**: the full upstream and downstream causal chain through the
  object turns signal-coloured; everything else steps back to 28 % opacity.
- **Impact** is always visible: out-of-date objects carry an amber border and dot, and only
  the links on recorded stale paths turn amber. An impact that arrives while the map is open
  is drawn once along those paths, outward from the change.
- **Agent touch**: objects the agent changed in the last 15 minutes carry a soft signal ring.
- Marks on nodes: amber dot = out of date; red diamond = missing input; branch icon = in
  review; hollow ring = no approved baseline. A node can carry several.
- **Fit** places the map in the largest free rectangle under the project header and beside
  floating islands, at 88–108 % (snapping to 100 %); below that the map pans and the controls
  offer “n off screen” and fit all. A manual viewport is remembered per project.
- **Detail levels**: full nodes from 62 %, glyph and marks from 40 %, a strip of state bars
  below. Every type group can collapse into one summary node; large groups start collapsed in
  projects of more than 80 objects.
- The key rests behind a **Key** button at the bottom left and lists only what the map shows. The peek strip below the map spells out the
  hovered or focused node. Nodes open their object.
- The map is one tab stop. ←/→ follow links (the way you came first), ↑/↓ move within a
  column, Home/End jump to its ends, ↵ opens, `T` pins the thread, `C` collapses a group,
  `+`/`−` zoom, `0` fits, `⇧0` fits all, `Esc` unpins.

**Needs you** is a floating island listing only what waits on a human: pending proposals, then
out-of-date objects (missing input first, each with its recorded reason and “Ask the agent to
re-evaluate”), then agent suggestions. Proposals returned to the agent are listed apart under
“Back with the agent” and are not counted. The quiet line says “Every baseline is current and
reviewed” only when that is true; otherwise it names what is unfinished (objects without a
baseline, drafts not proposed). It rests as a pill at every width and opens over the map;
open, at 1360 px and wider, its rows run two abreast. On other views the sheet's header
carries the same count as "n needs you".

**Parts** is two tables. **Components** (the default, so agent suggestions are visible before
human selection) groups parts as Candidates, Selected and Set aside; 2 to 4 parts can be
compared side by side with differences named. **Bill of materials** carries a totals strip:
known cost per currency (never summed across currencies), known mass, lines, and each value
excluded as unknown with its reason. Rows are sourced shopping lines: a real product image
(https only, on the photo well), name and part number, project-specific selection reason,
seller price with pack basis, observation date, availability and the exact purchase
destination. Missing or failed photos, unknown prices and unusable links remain labelled;
placeholder domains are never purchase actions. An export reports success only when the host
returns the written file.

**Timeline** is the decision record grouped by day, with adjacent revision/baseline events
merged. It pages back to the start of the record, filters by actor and object, opens what each
row refers to, and shows recorded agent tool calls between the rows when the host keeps them,
each with its input repairs and what the host also ran inside it.
A row never states a change that did not happen: a bill-of-materials row after an approval
appears only when the approval touched a component, a BOM line or a replacement (earlier
builds announced one after every approval, and those records stay in the project), and an
impact row counts only the objects reached beyond the ones that changed, and is hidden when it
reached none.

**Files** lists approved and draft working files by owning object, state and revision, with a
line-numbered preview, reveal of the actual file, the project archive, and the build package
(drafts off by default; a refused build lists its issues inline).

**Evidence** (`⌘5`) is the requirement → evidence matrix, read left to right: requirement
(statement, priority, review), target (quantity with unit and range, unknown with its reason,
or “No quantitative target”), coverage (Covered, Partly covered, Out of date, No evidence, with
the host's reason), and evidence chips (type, title, Current / Out of date / Draft / No result,
the recorded result, and Pass or Fail only when a test recorded a verdict). Current evidence is
the host's judgement: a calculation whose recorded result the engine does not reproduce is No
result, and a link an agent drew that nobody reviewed is Draft. A header sentence counts what
has current evidence and says how much of it is partial without counting a requirement twice
(“1 of 2 requirements has current evidence, but only partly. 1 has no evidence.”, or “…, 2 of
them only partly”); filters show gaps; “Ask agent to close n gaps” drafts an editable request
naming each gap. A verdict is never inferred by comparing numbers.

An empty project shows the four layers as a dashed outline and one action that opens the Agent
tab with a drafted first prompt.

### Level 1 — Object

A three-part composition: **left rail · stage · right rail**.

- **Left rail — Depends on**: upstream links (graph edges and recorded, pinned inputs) with the
  relationship in words. Below it, **Record**: origin (an agent's revision reads
  “agent · session” and the first eight characters of the session id, the full id in its
  title), recorded time, evidence
  kind, bounds, identifier, and “Reveal files”.
- **Right rail — Affects**: downstream links, then **Related** (non-causal relations), then
  **Revisions** with the baseline marked and each rationale.
- Short connector lines lead from every rail link toward the stage. Clicking a link moves focus
  along the graph.
- **Stage header**: type and subsystem, title, “Ask agent”, then labelled states — review,
  freshness, “Change in review” (opens its proposal), drafts, revision.
- If an input changed or is missing, a notice names the path, e.g.
  `Payload capacity → Rover mass budget → this`, each step clickable.

- Each rail folds to a narrow strip at its edge and unfolds from the same button; the choice
  is remembered for every object. A rail that fails to render says so while the stage and the
  other rail keep working.

Every stage resolves recorded revisions, including artifacts with no approved baseline. **The
Revisions rail is the picker**: “Latest work” follows the newest active draft descended from
the baseline, else the baseline; picking the baseline follows the pointer; picking any other
revision holds it; a save shows the saved revision; while an edit is unsaved the display stays
on its base revision. Rejected work is never selected automatically. Header, record rail,
inputs, files, and fields describe the displayed revision; freshness belongs to the baseline
and reads “Baseline: …” when another revision is on screen, and “Input not yet approved” when
a missing input exists only as a draft.

A non-baseline revision carries a banner: a draft offers **Accept as baseline** (with its
consequence stated: at once, without a review, marking what depends on it out of date) and
**Open decision** when a proposal covers it; history offers “Show latest work”. Disabled edit
controls say why. Known fields populate from the payload; unknown quantities retain their
reasons. New observations, decisions, and messages require intentional input.

Edits are held apart from incoming data: a refresh, an agent draft or a moved baseline never
resets typing. When the base moves underneath, the stage says “The record moved to rN while
you were editing” with a per-field table and **Keep my edits on rN** / **Discard my edits and
show rN**. Leaving with unsaved edits asks first; an editor that disappears without being asked
keeps its edits for its return.

The stage takes the shape of the object:

| Type                                                 | Stage                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirement                                          | Statement as large editable text; target as one quantity field (value + unit) with “The target is unknown” and its reason, so an unknown target is removed only by clearing that choice; priority; acceptance; trace impact                                                                                                                                                     |
| Assumption                                           | “Not an established fact” notice; statement, reason, owner, needs-validation                                                                                                                                                                                                                                                                                                    |
| Mechanical                                           | STL viewport first with a tool island (fit, reset, seven standard views, projection, section, two-point measure, envelope, edges, grid, baseline comparison as overlay or side by side); render/accept bar and job row; parameters scanned from the source with units and overrides, sent in the model's units (mm, deg; a unit with none is refused, never sent as mm); source |
| Calculation                                          | Result in large mono, expression, inputs as `name = quantity · source` rows with their pin state (“Pinned to r3; the baseline is now r5”), assumptions, limitations, re-run; a re-run that reproduces the record says nothing was created, and only a submitted proposal is “waiting for your review”                                                                           |
| Test                                                 | Procedure steps, conditions, recorded results, record-a-result form                                                                                                                                                                                                                                                                                                             |
| Electronics                                          | Checks run automatically for the displayed revision; sanitised diagram at stated scale with zoom; labelled findings linked to their connection, pins, voltage ranges, connections, ratings, and coverage                                                                                                                                                                        |
| Component                                            | Part number, maker, selection, sourced properties and attributes; supplier offers as a table with recorded web destinations, quantity basis, observation date, availability, and explicit unknown prices                                                                                                                                                                        |
| Source                                               | The excerpt as a quotation, publisher, kind, capture time, URL                                                                                                                                                                                                                                                                                                                  |
| Assembly                                             | Numbered steps with tools, calibration, and linked components                                                                                                                                                                                                                                                                                                                   |
| Concept · architecture · subsystem · software · note | Readable prose; editing opens a writing pane beside a live preview of what will be saved; concept dimensions, systems, alternatives, uncertainties, and saved visuals; software metadata and immutable file previews                                                                                                                                                            |

Edits appear in a save bar that only becomes prominent when something changed. Saving creates
a revision; the copy says so. The viewport's keys: arrows orbit, Shift+arrows pan, `+`/`−`
zoom, `1`–`7` standard views, `F` fit, `0` reset, `O` projection, `S` section, `M` measure,
`B` envelope, `E` edges, `W` wireframe, `G` grid, `Esc` leaves measure. Scroll zooms only with
focus, a resting pointer or a pinch; otherwise the stage scrolls.

A mechanical part's bar also carries **Export STEP**. It asks where to save, runs as an export
job row with **Cancel export** (from the job store, so an export an agent or another window
started shows too, and Export STEP waits for it), and reports only what the core answered:
“exact surfaces” with the comparison against the render (volume, bounding box, probes at the
render's faces and at the solid's own; probes set aside and points on the solid's surface are
named, never counted as agreeing), “exact surfaces except approximated hulls” with the list, or
“faceted, not exact” with the reason and what it was built from. A failure is said once: its job
row stays hidden beside the outcome and after the outcome is dismissed. A missing converter
links to Engineering tools. It is offered only for a revision with a render of its own source, outside
edits and read-only projects; the reason otherwise sits under the bar.

### Level 2 — Decision

The same three-part grammar: **queue · proposal · impact**.

- Left rail: “Needs you” lists pending proposals that nothing replaced, newest first; “n
  waiting on the agent” links to All. Rows show the reason, the objects, the state in words,
  who, when and the change count. The sidebar's Decisions count and the header's pill count the same
  proposals.
- Centre: “Proposal n of m” with previous/next, the reason as the title, who proposed it and
  when, then a phase notice when the next move is not yours: **Base moved** (approval blocked,
  “Ask the agent to rebase”), **Waiting on the agent**, **Superseded** (“Open the
  replacement”), or the recorded outcome with its rationale. A proposal that replaced earlier
  ones says “Replaces …” and links them. A proposal that changed while it was open says what
  changed and waits for “I have read the changes”.
- One section per change with the object (clickable), change kind, and `r1 → r2` (a change
  that edits only a bill of materials reads “r1 stays the baseline”). Diffs are
  field-level rows, one row when short and a stacked line diff with marked words when long;
  list items match by id or name, else content, and added or removed items show whole;
  quantities change atomically with their bounds: **0.3 kg → 0.5 kg**. A new object shows its
  complete content; files show sizes and line diffs. Mechanical changes show Proposed /
  Baseline / Side by side / Overlay without resetting the camera, verification in words with
  its readiness, the listed items of the check with what shows each one (who listed each, or
  which requirement it comes from, that requirement's review state, and who asserted it when
  the assertions are not the requirement's own; a requirement no geometry check shows says so,
  one linked or changed after the check is named without changing the recorded status, and
  requirements that disagree say that no check can run), scope acceptance with the reason when it is refused, envelope,
  parameters, source diff and provenance. A new requirement shows the features it asks of a
  linked part, read-only, with their assertions in words.
- The decision bar is pinned to the bottom of the stage: rationale (required to reject or
  request changes), then **Reject** (demoted, far left, two presses), **Request changes**, and
  **Approve changes** (`⌘↵`). One guard (`decide/guard.ts`) decides for buttons and keys:
  approval is blocked while the base moved, and while a proposed part's mesh has not yet been
  shown in the viewport or could not be read; that geometry gate holds back approval only, so
  reject and request changes stay available, and an archive change has no geometry to wait for.
  `⌘↵` approves only with focus in the decision, no open layer, the changes rendered, a proposal
  that needs you, and not within 400 ms of it appearing (a held or repeated key never approves
  the next one). A decision in flight disables the bar; its outcome is reported once, in the
  bar.
- Right rail: “Would affect”, “Approving will” in words (for a bill-of-materials edit, “the
  baseline stays rN; only its bill of materials changes”), and a standing note on what approval
  means. When the base moved it reads **Approval is refused** with the reason (“its baseline is
  newer than r1, the revision this change was prepared on”) and “Nothing changes until the agent
  rebuilds the change”. With no proposal open (the done state) only “What approval means”
  remains.
- After a decision the next pending proposal opens, else a done state lists the sitting's
  decisions and the exact handoff text; **Resume agent from decision** types it without
  sending.

### The agent

The agent surface has two panes and three presentations, mounted for the life of the open
project so the conversation, the terminal session, its scrollback and running CLI survive
navigation.

- **Panes**: the **Conversation** (Codex CLI or Claude Code run headless, once per message) and
  the **Terminal** (any agent CLI, interactive, in a real PTY). A `Segmented` switch leads the
  session bar; the window header carries the same in its menu. A project not used before opens
  on the conversation, and the choice is remembered per project. The terminal stays attached
  while the conversation shows.
- **One agent works in a project at a time.** The host refuses a conversation send while a
  terminal session runs, and a terminal start while a response runs (`BUSY`). The composer says
  so with Switch to Terminal and Stop terminal session; the terminal pane says so with Switch to
  Conversation and Stop response.
- **Conversation**: one durable thread per conversation, recorded in
  `.bureau/chat/conversations.json` (local, not part of a project archive). Each turn shows
  the request with any exact inputs, the response as it arrives (Claude Code streams partial
  text; Codex reports completed items; the host announces each change and the pane reads the
  record again), and the cards the run presented with `chat.present`:
  a part (3D, three ordinary dimensions, the rest under More), a recorded object, quantities
  (unit and unknown reason kept), an **illustrative** chart with a table and keyboard readout,
  choices, and human review. Charts are never evidence. A run's `ui.open_artifact` and
  `ui.request_review` become cards in its own turn instead of moving the stage; a terminal
  agent's still move it. Cards you open from the project record or `+` read “Opened by you”.
  Recorded activity under each turn lists the host's call ledger for that run, with what the
  host also ran inside a call; a call whose check did not pass reads “Returned” in the warning
  tone. The turn header names the model in mono: what the CLI reported, else the id Bureau
  passed, with a warning Notice when Claude Code reports another model than the full id it was
  given. Bureau never
  parses or shows a CLI's cost figure in its own interface; the Terminal pane is the CLI's own
  screen. An empty conversation asks “What are we making?” with three starters and the
  project's first objects.
- **Completion gate**: when a response ends, the host reads `work_status` for the turn's agent
  session and those of the turns it continues, and records it on the turn; a continuation's own
  `work_status` reads the same sessions. With blockers left, the turn ends with **Work not
  finished**: the eyebrow “Completion gate · work_status, recorded by Bureau” with the time it
  was read, the summary, up to five items with their `work` state and the tool that resolves
  each (“Needs you” otherwise), **Continue** (disabled while the project is busy) and **Edit
  request** (the request the chain started from); a failed turn shows it under the error. An
  earlier turn's record collapses to one dated line, which says who continued it below when a
  continuation follows. A response that called no Bureau tool and touched nothing says so in
  a quiet labelled line, with Continue. Continue sends one fixed continuation, shown as “You asked the agent to
  continue”. With Settings → Agents → **Unfinished work after a response: Continue once** (off
  by default), Bureau sends it itself once per message you sent, when a blocker is the
  agent's to resolve from the record, shown outlined as “Sent by Bureau, once, because
  work_status reported unfinished work”; sourcing and seller offers never qualify, it never
  continues its own continuation (a Continue you press counts as a message you sent, so it may
  continue once after that), and Stop prevents it. Claude Code continuations resume the CLI
  conversation; Codex continuations replay the conversation text. Agents cannot present this
  record: it is not a `chat.present` kind.
- **Prepare → Send**: editing a card's values and pressing Prepare attaches the exact literal
  values, units, artifact and revision to a readable request in the composer. Only Send starts
  the agent; an attachment pinned to an older revision is refused. Approval stays a separate
  human decision on the review card or in Decisions, with every changed file opened, every mesh
  shown, and the changed check scope accepted.
- **Zoom in from a card**: Open object focuses the object between its rails; Open in Decisions
  opens the proposal. In the floating window and the dock, cards stack in one column and 3D
  renders only on Show 3D.
- **Agent tab**: the first activity-bar tab. A slim **session bar** (status word, a pulse only
  while running, agent, model, tool profile with its source, tools listed, elapsed, recorded
  calls and failures; interrupt, restart and stop as two-press buttons, search `⌘F`, copy
  transcript, clear, activity, settings), the terminal, and the **activity rail**: only calls
  recorded in the host's ledger, grouped by pauses and sessions, failures with their selectable
  error, input repairs, what the host also ran inside a call (the check a write with `expect`
  ran, its state in the vocabulary's words, the attached work status, which a continuation
  names as read over “this turn and the one it continues”; a check that did not
  pass, or a run that did not answer, in the warning tone, so an ok call is not read as
  verified), and touched objects as links. A group names a time range only when its
  shown times differ, and headers and call details wrap only between facts. The rail is
  remembered per project; when the host keeps no ledger it stays closed and its toggle says
  “Activity is not available from this host”.
- **Stop and Restart** show their progress: the pressed control is busy and the other is
  disabled until the host answers (a CLI that ignores the polite stop is killed after 2 s). A
  session the person stopped reads “Ended” with no exit code; the host records an exit code
  only for a process that exited with one.
- **Agent window** (`⌘J`): a floating island dragged by its header and resized from the
  top-right corner by pointer or arrow keys, at most half the width and 56 % of the height of
  the area. It docks to the right (the stage narrows) or collapses to its header with a
  one-line ticker of the latest call, remembers size, place and mode, and returns focus when it
  closes. Until the person places it, it sits above the controls pinned to the bottom of the
  area that mark themselves `data-toast-avoid` (the map's key and peek strip, the decision
  bar); once placed it stays where it was put. A signal ring marks a live session.
- **States** are explicit: “Looking for agent CLIs…”, “Connect an agent CLI” (every adapter
  with its install guide, Set path…, Detect again), a one-click choice when several are
  installed, starting, “did not start” with the host's error and Try again, read-only, and
  ended (the transcript stays readable and copyable, with Start again on the same CLI; it never
  restarts on its own).
- **Autostart** happens only on the terminal pane, only for an unambiguous choice, the first
  time the surface is visible with no session, and never while a response runs.
- **Ask**: every “Ask agent” entry point (stage header, Needs you, Evidence gaps, Parts
  alternatives, rebase and handoff in decisions, the launcher brief, `⌘K`) follows the pane. On
  the conversation it joins the composer's draft and waits for Send. On the terminal it goes to
  one queue: it is pasted with bracketed paste once the CLI shows its prompt and is never
  submitted; until then it waits visibly as “Waiting to type” with **Paste now** and
  **Discard**. Any paste into a CLI that has not turned bracketed paste on (**Paste now**
  included) joins the lines with spaces, so it never presses Enter. Object references arrive as
  `{type} "{title}" (artifact {id}, revision {n})` you can edit before Enter. Nothing is
  dropped, paraphrased, summarised, or fabricated.
- **Starters** in the rail offer requests drawn from the record for a fresh session; they are
  typed, never sent, and they are gone once anything was typed or pasted into the session or
  while an ask waits (the launcher brief counts).
- **Settings** per agent: model, tool profile (Automatic, Compact, Standard, Full) and how it
  resolves, executable path, test steps, “Restart to apply”, and “Verified with this build”,
  “Documented, not verified here” or, for a Custom CLI, “Not verified here”. A Custom CLI shows
  the arguments the host reports as saved (“Leave empty to keep them”); an older host that does
  not report them is not guessed at. An agent CLI that is not installed reads neutral; red is
  for a detected one that fails.
- `⌘K`: “Ask {agent}” is always the last group and never preselected; the `>` prefix asks
  directly. Project content search finds recorded text and part numbers, shows an excerpt and
  the matched revision's review state, and opens that exact revision. Its Ask action names the
  same revision. Local commands remain available while content is loading or fails.

## 4. Visual language

### Colour

Two themes share roles: **Dark** (the default) and **Light**. `tokens.css` is the only source.

| Role          | Token                                                                                     | Use                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Field         | `--field`                                                                                 | Carbon: the window and the sidebar                                                                    |
| Surface       | `--surface`                                                                               | The sheet the work sits on: the map, the stage, the lenses                                            |
| Selected      | `--selected`                                                                              | Graphite Navy: the selected sidebar row, segment or list row                                          |
| Ice           | `--ice`                                                                                   | The mark's light pixels (Carbon on Light); baselines in the impact thread                             |
| Raised        | `--raised`, `--raised-2`                                                                  | Islands, menus, hover, inputs                                                                         |
| Inset         | `--inset`, `--terminal-bg`                                                                | Code, terminal, viewport wells                                                                        |
| Text          | `--text`, `--text-2`, `--text-3`, `--text-4`                                              | Content, support, metadata; separators and idle marks (`--text-4`, never the only carrier of meaning) |
| Signal        | `--signal`, `--signal-text`                                                               | Live agent, the lit thread, context (fills)                                                           |
| Signal stroke | `--signal-stroke`, `--focus`                                                              | Signal drawn as a line, ring, dot or border; the focus ring (deep cyan on Light)                      |
| Pressed       | `--pressed`, `--press-scale`                                                              | A control held down                                                                                   |
| Scrim         | `--overlay`                                                                               | Behind dialogs and the sheet                                                                          |
| Photo         | `--photo-bg`                                                                              | The well behind product photography                                                                   |
| Terminal      | `--terminal-bg`, `--terminal-fg`, `--terminal-cursor`, `--terminal-selection`, `--ansi-*` | The agent terminal: surface, text, cursor, selection and the sixteen ANSI colours                     |
| Positive      | `--ok`                                                                                    | Approved, current, passed                                                                             |
| Attention     | `--warn`                                                                                  | Needs review, out of date                                                                             |
| Error         | `--err`                                                                                   | Missing input, failure, rejection                                                                     |
| Primary       | `--primary`, `--primary-ink`                                                              | The one decisive action per area                                                                      |

- **Bureau Cyan is the only chromatic accent outside state.** It means _alive or selected_:
  a running agent, keyboard focus, the hovered causal thread, the context chip. It is never a
  category colour and never decoration.
- Primary actions are high-contrast neutrals (soft white on Dark, Carbon on Light), one per area.
  Cyan fills only what talks to the agent (Send).
- State colours always pair with a word (`State` renders a dot plus a label).
- Text roles and state words meet 4.5:1 on every surface in both themes; strokes, the focus
  ring and `--text-4` meet 3:1. `tests/frontend/ui-tokens.test.ts` enforces it.

### Type

Mona Sans for the interface and display; JetBrains Mono for values, identifiers, parameters,
source, and the terminal. Both are vendored in `fonts/` and declared in `fonts/bureau.css`.

| Token        | Size | Role                                  |
| ------------ | ---- | ------------------------------------- |
| `--text-4xl` | 56   | The introduction's act titles         |
| `--text-3xl` | 34   | Launcher question, calculation result |
| `--text-2xl` | 26   | Object and proposal titles            |
| `--text-xl`  | 18   | Statements, target values, totals     |
| `--text-lg`  | 15   | Lede, the composer, omnibar input     |
| `--text-md`  | 13   | Working text, navigation              |
| `--text-sm`  | 12.5 | Controls, rails, tables               |
| `--text-xs`  | 12   | Metadata, units, labels               |
| `--text-2xs` | 11   | Counts and keys                       |

Display sizes use `--tracking-display` and `.text-display`; titles use `.text-title`. Line
heights are tokens (`--leading-display`, `--leading-tight`, `--leading`, `--leading-prose`).
Numbers use tabular figures (`.num`, `.tabular`). Sentence case everywhere; no capitals, no
tags above headings. Keys are plain mono text (`Kbd`), never boxes.

### Geometry, depth, motion

- Spacing is 4-based (`--s-1` … `--s-12`). Controls are 26 / 30 / 36 px.
- **Soft frames, square pixels.** Radii: 4 (chips, keys), 6 (controls, sidebar rows), 8 (nodes,
  cards, menus, inputs), 10 (the sheet, islands, inline cards), 12 (the composer, dialogs).
  Everything that is a pixel stays square: the mark, the live pixel, state marks, the census,
  link terminals and the layer patterns.
- Depth has three planes: the **field** (Carbon, flat), the **sheet** (surface, a hairline, no
  shadow; the stage is the sheet itself), and **islands** (raised, the layered `--shadow-float`) that hover over the field or stage:
  Needs you, the agent window, viewport tools, map controls, omnibar, sheet. Menus use
  `--shadow-menu`, tooltips `--shadow-pop`.
- Layers are tokens (`--z-raised` … `--z-tooltip`): sticky heads, stage tools, the save bar,
  canvas tools, the project head, islands, the agent tab and window, the sheet header, the
  introduction, the scrim, dialogs, menus, toasts, tooltips.
- Pressed is `--pressed` with `--press-scale` at once (other controls fall back to
  `--press-filter`); disabled is `--disabled-opacity`.
- Motion is functional: 120 ms feedback and exits (`--ease-in`), 200 ms state and enters,
  320 ms zoom and sheet. Two longer durations belong to the introduction alone: 560 ms scene
  changes (`--t-scene`) and 900 ms draws (`--t-draw`: one link, one stage zoom, one wave of
  impact); its choreography is staggered delays over those two, never other durations. Five
  utilities carry it: `.motion-fade` (scrims), `.motion-rise`
  (omnibar, menus, toasts, prompts), `.motion-sheet`, `.motion-zoom-in`, `.motion-zoom-out`.
  Each plays on mount and exits while Radix marks it `data-state='closed'` or the surface sets
  `data-leaving`. Only live things pulse. `prefers-reduced-motion` zeroes every duration and
  live indicators breathe instead of pulsing; the terminal cursor stops blinking.
- Toasts rise at the bottom right and lift above any control that marks itself
  `data-toast-avoid` (the decision bar, the map's controls, a save bar), so they never cover
  one. The stack is measured (its width and height) and rises only past a control it would
  overlap both across and down, lowest first; a control beside it or above it never moves it
  (`frame/toast-clearance.ts`).

### Brand

The product is **Agentic Bureau**: that name goes on the licence, the terms, the website, the
App Store and social profiles. Everywhere else, the app included, it is **Bureau**.

The mark is two rows of the checker: ten square pixels on a 5 × 5 grid (20-unit pitch, 18-unit
pixels), Bureau Cyan (`#4FC8F0`) and Ice (`#C6F1FF`). It is drawn in code by `Mark` from the
theme's `--signal` and `--ice`, so on Light its ice pixels turn Carbon; `mono` draws it in the
current text colour. The files in `brand/`:

- `bureau-mark.svg` (two-tone, for dark grounds), `bureau-mark-light.svg` (deep cyan and Carbon,
  for light grounds), `bureau-mark-black.svg` and `bureau-mark-white.svg` (one colour), with
  PNGs of the one-colour marks.
- `app-icon.svg`: the mark on the Carbon tile (`#0A0E12`, radius 36 on 256), as supplied.
  `app-icon.png` is that tile rendered edge to edge at 1024 px, with no added margin, from which
  `apps/rust-desktop/icons/` is generated (`pnpm exec tauri icon`); `app-icon-light.svg` is the
  light tile for documents and the web.
- `favicon.svg`: the same mark drawn on its own 16-unit grid, so no pixel lands between two
  screen pixels at 16 and 32 px.
- Sizes: 16 px in the sidebar, 18–22 px lockups, 34 px launcher, 40 px introduction.
- The agent's glyph is five pixels of the mark's checker; while a run is live it steps through
  a 3×3 field (`Pulse`). Nothing else in the app moves on its own.
- Wordmark: **Bureau** in Mona Sans semibold; the official lockup sets **Agentic Bureau** after
  the mark with two pixels of clear space.
- Never round, rotate, outline, stretch or animate the mark itself.

## 5. Primitives

All live in `ui/kit.tsx` (`ErrorBoundary` in `ui/ErrorBoundary.tsx`), are styled in
`styles/kit.css`, and appear in the Design system view.

| Primitive            | Purpose                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `Mark`, `Brand`      | Identity: the pixel mark in theme colours (`mono` for one colour) and the Bureau wordmark                          |
| `TypeGlyph`, `TYPES` | Neutral object glyphs, labels, plurals, and causal layer for all 14 types                                          |
| `State`, `Pulse`     | Labelled state by dimension (`ui/vocabulary.ts`; `spec` for listed CAD items, `work` for the gate); the live pixel |
| `Button`             | `primary` · `secondary` · `ghost` · `danger` · `signal`; `sm` · `md` · `lg`; `busy` keeps its width; `shortcut`    |
| `IconButton`         | Named icon-only action, 26 / 32 / 38 px; the label is its accessible name and its tooltip; `pressed`, `shortcut`   |
| `Tooltip`            | Names a control on hover and when Tab reaches it; `TooltipProvider` wraps the application                          |
| `ConfirmButton`      | Two-press action for anything irreversible; stands down after four seconds, on blur, or on Escape                  |
| `Menu`               | A short list of actions behind one trigger, with icons, shortcuts, and a destructive tone                          |
| `Segmented`          | A radio group for lens and mode switching, one tab stop, arrow keys, optional counts                               |
| `Field`              | Label + control + hint with connected ids; `error`, `required`                                                     |
| `Checkbox`           | A labelled choice with an optional hint                                                                            |
| `QuantityField`      | Value and unit changed together; empty is not set, never zero; non-numbers are flagged, not saved                  |
| `Notice`             | Inline, toned explanation with an optional action                                                                  |
| `Empty`              | Specific empty state with a recovery                                                                               |
| `Skeleton`           | Placeholder with the rough shape of content that is still loading                                                  |
| `ErrorBoundary`      | Contains a render failure to one region, shows the recorded error, and offers a retry                              |
| `Disclosure`         | Progressive detail with contextual actions, controlled or `defaultOpen`                                            |
| `Qty`, `Time`        | One formatter for quantities (`formatQuantity`) and one for times (`formatDate`), unit attached                    |
| `Block`, `Facts`     | Quiet labelled sections and key/value metadata                                                                     |
| `Kbd`, `Spinner`     | Shortcuts and active work                                                                                          |

Composite patterns: map node, map key and peek, Needs-you row, rail link node, folding rail,
stage header, revision banner, underneath notice, save bar, viewport tool island, render and
export job rows, STEP export outcome, diff row (short and stacked), line diff, phase notice,
change-underneath notice, listed items of a CAD check, decision bar, handoff card, lens table
row, totals strip, evidence chip, sidebar and census, session bar,
pane switch, conversation turn and composer, input attachment, inline card (part, record,
quantities, chart, choices, review), work-not-finished card, continuation message, turn model
and model-mismatch notice, activity rail and call row, agent onboarding panel,
waiting-to-type bar, terminal search,
agent window (dock, collapse), island, sheet, omnibar, unsaved-work prompt, project loading
state, frame strip (failures to act on, with Retry or Dismiss), toast, introduction (acts on
the rover map, setup card, progress rail). The catalogue's “In the
product” section opens each one where it lives.

## 6. Engineering integrity

These rules outrank aesthetics.

- **Quantities keep their units**, atomically, in values, diffs, and tables, with their bounds:
  a one-sided bound (only a minimum or only a maximum) is shown, never dropped.
- **Unknown stays unknown.** It is never shown as zero, never summed, and is labelled with
  its reason when one was recorded. A recorded unknown without a reason still reads “Unknown”,
  and saving an edit never erases it.
- **Review, freshness, evidence, and execution are separate dimensions** and are shown
  separately. Approved ≠ current ≠ validated.
- **Provenance is one click away**: every sourced property links to its source; every
  recorded input shows its relationship and whether it is pinned.
- **Illustrative data is labelled** (e.g. the preview mesh). A calculation marks itself
  experimental where the engine is.
- **No fabricated agent activity.** The terminal pane is the real PTY; “Ask” writes to it with
  bracketed paste; running state comes from the session. The conversation shows only text and
  cards a real run produced, and the host's own completion-gate record, with its run state from
  the host's record; a run that ends without a completion event is Failed, never Completed.
  The activity rail shows only recorded ledger calls; counts come from the host or the ledger,
  never estimated. Starters and asks are typed or drafted, never sent; Continue sends only its
  fixed, labelled continuation, and the one automatic continuation is sent only with the
  setting on, labelled as sent by Bureau below the gate record that caused it. An ended
  session shows only an exit code the process returned.
- **The record states only what happened**: a Timeline row, an approval effect or a re-run
  message says a baseline moved, a bill of materials changed or a proposal waits only when the
  host recorded it.
- **Edits are never silently lost**: leaving unsaved work asks first, and an agent cannot
  navigate over it.
- **Coverage is recorded, not inferred**: Evidence shows Pass or Fail only from a recorded test
  result.
- **Exports report success only after the operation returns.**

## Selection and copy

Chrome is not selectable; content is. Inputs, code, values (`.mono`, `.num`, `dd`, `output`,
`time`), table cells, prose, notices, diffs, the terminal and live regions select as text;
`.copyable` marks other recorded content. Buttons, tabs, menu items, options and their
descendants never select. Never put `.copyable` on a control.

## 7. Keyboard and accessibility

| Shortcut             | Action                                             |
| -------------------- | -------------------------------------------------- |
| `⌘K` / `⌘P`          | Omnibar: go to, run, or ask                        |
| `Esc`                | Close the topmost layer, else zoom out one level   |
| `⌘[` / `⌘]`          | Back / forward                                     |
| `⌘J`                 | Show or hide the agent window                      |
| `⌘F`                 | Search the agent scrollback                        |
| `⌘⇧D`                | Decisions                                          |
| `⌘1`–`⌘5`            | Flow, Parts, Timeline, Files, Evidence             |
| `⌘↵`                 | Approve (focus in a decision)                      |
| `J` / `K`, `[` / `]` | Next and previous change, proposal (in a decision) |
| `⌘,`                 | Settings                                           |

- A shortcut never reaches the workspace while a menu, dialog, sheet or the omnibar is open,
  except that layer's own (`⌘K` closes the omnibar, `⌘,` closes Settings). A layer playing its
  exit (`data-state="closed"`) no longer holds the keyboard. Shortcuts that
  navigate never fire while typing in a field; `⌘K`, `⌘,` and `⌘J` do. Escape in the terminal
  belongs to the CLI; Escape on the agent window's controls returns focus to the workspace.
  `⌘` on macOS, Ctrl elsewhere; `Kbd` shows Ctrl on Windows and Linux, and controls with a
  shortcut carry `aria-keyshortcuts`.
- In `⌘K`, Tab moves between a row's actions and `⌘↵` asks the agent about the object; `>` asks
  directly. Arrow keys resize the agent window from its corner handle.
- The map and viewport keys are listed with their levels above.

Focus rings use `--focus` in both themes; rows inside lists draw it inset. Icon-only buttons
have names. Dialogs (omnibar, sheet, menus, the unsaved-work prompt) trap and return focus via
Radix. The map is a `role="application"` region named with its counts, and each node has an
accessible name that reads its states; the viewport documents its keyboard alternative. Toasts
use a live region. Target WCAG AA for essential text; verify with VoiceOver before release.

## 8. Layout

- The window is Carbon. The **sidebar** is 232 px on its left edge; its top 44 px hold the macOS
  traffic lights and drag the window. The **sheet** fills the rest, inset 8 px from the
  window's top, right and bottom, radius 10.
- The sheet's **header** is 48 px: back, where you are, and only what asks something of you
  (running jobs, "n needs you"). It drags the window. Without a project (the launcher) there is
  no sidebar and the sheet is the whole window.
- Rails 248 px, 216 px below 1280, 196 px below 1120; a folded rail is 40 px. The stage takes
  the rest.
- Supported from **1024 × 700**; designed at **1440 × 900**.
- Scrolling belongs to regions: rails, stage, lens pages, terminal, omnibar list, sheet. Each
  view's scroll positions are remembered and restored on return. The flow map canvas never
  scrolls; it pans by transform. Scrollbars are thin and themed (`.scroll-region`).

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

Never add: metric-card dashboards, decorative charts, gradient heroes, glowing accents, an
icon library beside `ui/icons.tsx`, round marks where a pixel belongs, capital-letter tags,
fake chat bubbles, unlabelled colour, or collaboration features that don't exist. Full pixel
fields (the four layer patterns at size) belong to the launcher, the introduction, empty states
and brand material; working screens keep to the swatch, the live pixel, the census and the
link terminal.

## 10. Implementation map

| Concern                                            | Source of truth                                                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Tokens (both themes)                               | `design-system/tokens.css`                                                                                                 |
| Fonts and licences                                 | `design-system/fonts/`                                                                                                     |
| Brand                                              | `design-system/brand/`                                                                                                     |
| Primitives                                         | `renderer/ui/kit.tsx`, `renderer/ui/ErrorBoundary.tsx`                                                                     |
| Vocabulary, formatters, shortcuts, contrast, units | `renderer/ui/vocabulary.ts`, `ui/format.ts`, `ui/shortcuts.ts`, `ui/contrast.ts`, `ui/units.ts`                            |
| Styling                                            | `renderer/styles/`, one file per surface (below)                                                                           |
| Zoom model, keyboard, events                       | `renderer/App.tsx`, `renderer/store.ts`, `renderer/lib/{navigation,shortcuts,layers,sync,dirty,view-memory}.ts`            |
| Frame: strip, unsaved-work prompt, loading, toasts | `renderer/frame/`                                                                                                          |
| Sidebar, sheet header, omnibar, settings sheet     | `renderer/shell/` (`Sidebar.tsx`, `Titlebar.tsx`), `renderer/shell/omnibar/rank.ts`                                        |
| Icons                                              | `renderer/ui/icons.tsx`: Bureau's own set on a 16-unit grid                                                                |
| Agent surface                                      | `renderer/shell/Agent.tsx`, `renderer/shell/agent/` (terminal engine, session bar, activity rail, onboarding, view-models) |
| Conversation pane and inline cards                 | `renderer/chat/` (chat store, `Conversation`, `InlineCards` and their parts); host side `crates/agent-host/src/chat.rs`    |
| Lens registry                                      | `renderer/project/lenses.ts`                                                                                               |
| Project lenses                                     | `renderer/project/` (`EvidenceLens`, `PartsLens`, `TimelineLens`, `FilesLens` and their pure models)                       |
| Flow map                                           | `renderer/project/FlowMap.tsx`, `renderer/project/flow/` (model, layout, routing, fit, keyboard, controller)               |
| Object focus and stages                            | `renderer/object/` (`stages/`, `mechanical/`, `viewport/`, `revisions.tsx`, `rails.tsx`, `useRevisionDraft.ts`)            |
| Decisions                                          | `renderer/decide/` (model, guard, memory, handoff, diff rendering, CAD review)                                             |
| Launcher                                           | `renderer/launcher/`                                                                                                       |
| Introduction                                       | `renderer/intro/` (scene model and keys, the rover map, the acts, the setup steps, the rail)                               |
| Catalogue                                          | `renderer/system/DesignSystemView.tsx`                                                                                     |
| Lineage, actions, proposals, diffs, edits          | `renderer/lib/` (`graph`, `actions`, `proposals`, `diff`, `revision-draft`, `unsaved-edits`, …)                            |
| Disposable preview                                 | `scripts/design-preview.ts` (the Rust headless host), `renderer/preview.ts`                                                |
| Screens                                            | `design-system/index.html` (links to live screens); `design-system/screenshots/` is history                                |

`renderer/styles/index.css` only imports the files below, in this order. A later file wins a tie,
so the order is the cascade order. Responsive and reduced-motion rules sit in the file of the
surface they style.

| File               | Styles                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `base.css`         | Reset, document defaults, form controls, scrollbars, utilities                                      |
| `kit.css`          | Everything `ui/kit.tsx` renders, plus shared patterns: island, menus, tables                        |
| `shell.css`        | Window frame, sidebar, the sheet and its header, stage zoom motion, omnibar, settings sheet, toasts |
| `app-frame.css`    | The frame strip, the unsaved-work prompt, the project loading state                                 |
| `agent.css`        | The agent surface, as a tab and as a floating window                                                |
| `conversation.css` | The conversation pane: thread, composer, and inline cards                                           |
| `project.css`      | Project identity, Needs you, the empty project                                                      |
| `flow.css`         | The flow map: canvas, nodes, links, headers and layer swatches, key, peek, controls                 |
| `lenses.css`       | Lens page chrome and tables, then Parts (with the part card), Timeline, Files, Evidence             |
| `launcher.css`     | The launcher                                                                                        |
| `object.css`       | The three-part grid, folding rails and stage shell that Object and Decide share, then every stage   |
| `viewport.css`     | The mechanical stage and the STL viewport                                                           |
| `decide.css`       | Queue, proposal, diff, decision bar, CAD review                                                     |
| `system.css`       | The catalogue                                                                                       |
| `intro.css`        | The introduction: the map's draw-in and impact, the acts, the setup card, the rail                  |

A lens is one entry in `LENSES` (`renderer/project/lenses.ts`) plus its component. The activity
bar, `⌘n`, the omnibar, the preview's `screen=` parameter, and the catalogue read that list.
The Object, Decision, Design system and Agent views, the omnibar and the sheet are code-split
and fetched once the first screen is up; three.js, xterm and the markdown renderer have chunks
of their own, and so do the conversation's markdown stream and chart. The renderer imports only types and the dependency-free entry points `@bureau/contracts/format`
and `@bureau/contracts/chat` from the contracts package, never its runtime barrel.

Class names are global. Name a class for its surface (`object-view`, `lens-check`,
`verify-row`), never with a bare state word such as `focus` or `check`: libraries such as xterm
add those to their own elements.
