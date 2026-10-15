# Engineering engines

The engines behind the engineering records run inside the Rust core (`crates/core`). Each says
what it covers; none turns a result into validated engineering evidence on its own.

## CAD — OpenSCAD

OpenSCAD is installed separately; it is not bundled.

- **Discovery** (`cad/engine.rs`): the executable configured in Settings (checked for execute
  permission; a stale one falls back with a note), then `OPENSCAD_PATH`, platform locations
  (including `%LOCALAPPDATA%` on Windows), `PATH`, and on macOS the login shell's `PATH`. The
  version probe is cached per executable file. A missing engine is `TOOL_MISSING` with a repair.
- **Running it**: each render runs in its own process group with standard input closed, a
  bounded head-and-tail log, a timeout (`timeoutMs`, default 90,000; at most 600,000, and
  300,000 for agent calls) and cancellation through `job.cancel`. OpenSCAD messages are mapped
  to causes with the offending source line (`render.hints`).
- **Cache** (`cad/render.rs`): results are keyed by a fingerprint of the source, parameters,
  model unit, engine version and executable, under `.omenflow/cache/render-rust-v1/`, with the
  STL bytes in the object store. Deterministic failures are cached; timeouts and crashes for
  ten minutes. Identical renders running at the same time run the engine once. An inside-out
  closed mesh is stored outward and says so.
- **The core lock is released while OpenSCAD runs** (`shared.rs`): the call is planned under the
  lock, rendered and measured without it, and committed under it. If the part's newest revision
  moved meanwhile, the call fails with `INPUT_CHANGED` and commits nothing.
- **Mesh analysis** (`cad/mesh.rs`, `cad/section.rs`): binary and ASCII STL up to 600,000
  triangles and 32 MB, bounds, signed volume, area, a welded directed-edge manifold check,
  shells by shared vertices, containment, self-intersection and wall thickness (with a
  bounded work budget that reports "not evaluated" rather than guessing), and planar sections
  with holes, slots, polygons and outlines recognised.

### Agent-facing CAD vocabulary

| Tool                                               | Mutating    | What it does                                                                                                                                                                                                                         |
| -------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cad_write_source`                                 | yes         | Plain-text OpenSCAD source → a draft revision of a new or existing mechanical artifact. Renders, stores source and mesh, scans parameters, returns a geometry report. A failed render still saves the source as a draft and says why |
| `cad_patch_source`, `cad_set_param`, `cad_compose` | yes         | Edit the source by replacement, change one parameter's effective assignment, or compose parts; each renders like a write                                                                                                             |
| `cad_read_source`                                  | no          | The source and parameters of the newest (or a given) revision, and whether it has a render                                                                                                                                           |
| `cad_inspect`                                      | no revision | The report for any revision, with chosen cutting planes, probe points and `-D` overrides; a re-render is recorded as a job, nothing is committed                                                                                     |
| `cad_check`                                        | yes         | Verifies explicit expectations and returns pass or fail per assertion with measured against expected values                                                                                                                          |

`cad_write_source`, `cad_read_source` and `cad_check` are in the compact profile; the others are
in standard. Write, check and inspect results take `detail: "brief" | "full"`; compact sessions
get `brief` automatically.

**Expectations.** The canonical form names `bbox`, `volume`, `solid` and `empty` points,
`sections` (holes, slots, polygons, outlines), `shells` and `watertight`. A short form expands to
it: `size`, `holes: [{at, d, axis?}]` (a section, a centre and diameter, and an empty probe),
`bodies` and one default `tol`.

**Verification.** A check is a trial (exploratory, binds nothing) or committed. With
`autoCommit: true` the check runs once and is recorded as committed only when it passes;
otherwise it is a trial. A committed check binds the revision and its expectation hash. The
status of a revision is `passed`, `failed`, `scope_changed` (the expectations differ from the
committed ones, for example an assertion dropped or a tolerance loosened), `partial` or
`unverified`, with `ready`
and a `nextAction` (`commit_assertions`, `repair_geometry`, `resolve_inputs`,
`request_review`, …). The same state is what `cad_check` answers, what `work_status` reports
(`cad_unverified`, `cad_check_failed`, `cad_scope_changed`, `cad_render_failed`) and what a
proposal shows. Evidence is recorded by checker `omenflow-rust-mesh-checks-v2`; evidence from
earlier checkers stays readable.

- The committed check that decides is the one committed last (numbered at commit), whatever
  order checks were asked in. Only a check that recorded evidence binds a scope; one that ended
  before measuring binds nothing.
- A `scope_changed` reply carries the committed expectations (`committedExpect`, also in brief
  results), and the gate's `cad_check_failed`, `cad_scope_changed` and “no committed check”
  items put them in `next.args.expect`, so an agent can restore them instead of guessing.
  `cad_check_failed` names `cad_check` as the next tool and says to fix the geometry with
  `cad_write_source` first.
- A part that passed its check against older revisions of its inputs is its own
  `cad_unverified` item: the next call rebuilds it (`artifact_update_draft` with the current
  inputs), or there is none while those inputs only await approval.
- A render identity in a draft's payload is kept only when its `renderJobId` names a succeeded
  `cad_render` job of this project with the same source hash, parameters and output hash;
  otherwise every derived output is removed, so a draft cannot claim a render it did not have.

**Not listed for agents but still callable** (through `tool_call` or `omenflow call`):
`cad.render` (the background job the interface uses), `cad.validate_source`, `cad.probe`,
`job.read`, `job.list`, `job.cancel`. `cad.export` is user-only.

## Calculations

`calculation.run` evaluates plain arithmetic over named quantity inputs (`calculation.rs`): the
operators `+`, `-`, `*`, `/`, `%` and `^`, parentheses, `pi`, `e`, `tau` (an input of the same
name wins), and 30 functions (`min`, `max`, `sqrt`, `round(x, n)`, `ceil`, trigonometry,
logarithms, …). Expressions are at most 2,000 characters, 512 tokens and 64 levels deep.

- Units: the result takes the declared `outputUnit`, else the template's, else the unit every
  operand shares, else the coherent SI unit of its dimension. Energy and torque share a
  dimension, so that case is refused until an `outputUnit` (`J` or `N*m`) is given. A result is
  never labelled with the first input's unit.
- Templates: `mass_budget`, `power_budget`, `battery_energy`, `torque_load`. An input a template
  can do without (`battery_energy.usable_fraction`, `power_budget.margin`) defaults to 1 when it
  is left out; the default is recorded as an input and as an assumption and returned in
  `notes`. Template descriptions carry no example values to copy.
- Refused with a repair: unit literals inside the expression, implied multiplication,
  comparisons as results, rounding across mixed units, undefined names (the nearest input is
  named).
- A re-run that reproduces the recorded formula, inputs and result creates nothing
  (`unchanged: true`). Jobs and results record the engine `omenflow-calc/2`.
- A calculation counts as computed only when this engine reproduces the result the revision
  records from the formula (or template) and inputs it records. A result typed into a payload,
  or one with an input that has no value, is not computed however it is labelled:
  `work_status` reports `calculation_not_run`, and `project.coverage` reports it as
  `no_result` with `computed: false` and the result as written in `recordedResult`. A payload
  written without `evidenceKind` gets none.
- Inputs that cite a source are recorded as dependencies; their values are used as given, not
  compared with the cited revision. Results say this in their limitations.

## Parts, offers and the bill of materials

- `component_add_candidate` records a part with its maker, part number, properties (each may
  cite a source), an optional inline `source` (captured as a source artifact) and an `offer`
  (seller, price and currency, pack quantity, availability, observation date, product URL and
  image). Placeholder domains are never purchase destinations.
- `component_propose_selection` and `bom_propose_edit` go through review. A replacement removes
  the replaced component's BOM lines on approval. An approval announces `bom.changed` only when
  it touched a component, BOM lines or a replacement.
- `bom.read` totals mass in the unit of the first known line and cost per currency (never
  summed across currencies). Unknown or unconvertible values are listed with their reason
  (`totals.unknownMass`, `totals.unknownCost`), never counted as zero.
- `bom.export` writes CSV or Markdown with sellers and observation dates.

## Wiring

Pins and connections are tied to component revisions; ids and component revisions are assigned
by the server when the agent leaves them out. `wiring.validate` reports
`VOLTAGE_INCOMPATIBLE`, `MISSING_GROUND`, `DUPLICATE_EXCLUSIVE` (an exclusive pin used twice),
`CONNECTION_UNKNOWN_PIN`, `CHANGED_COMPONENT`, `COMPONENT_UNAPPROVED` and `NO_CONNECTIONS`, in
declaration order, each as an `error`, `warning` or `info`; a supply or ground pin feeding several
loads is not an error. `wiring.render` draws a
sanitised SVG diagram (one column per component, one row per connection, `currentColor` ink).
Coverage is labelled; this is not a schematic electrical-rule check.

## Tests

`test.create_draft` records a procedure linked to the requirements it validates;
`test.record_result` records an observed result. A person's result on an approved test becomes
the new baseline in one transaction; an agent's result is a draft on top of it for a person to
accept. When a person records a result while an agent's working draft of the test is open, the
draft is carried onto the new baseline as a new draft (its content, the baseline's results and
then its own), and the result says so in `carriedDraft` and its note. A pass or fail verdict
exists only where a result recorded one.

## Build package

`build.preview` lists what an export would contain and why each item is or is not ready.
`build.export` refuses with a structured list of issues per artifact (`no_baseline`, `stale`,
`missing_input`, `file_missing`, `cad_unverified`, `cad_evidence_invalid`,
`assumption_unresolved`, `pending_proposal`, …) and otherwise writes a ZIP whose manifest names
the tool versions recorded by jobs. An agent can write the package only inside the project; a
destination outside it is refused with `PATH_OUTSIDE_PROJECT` before any work is done.

## Research

The desktop app reads public `http` and `https` pages in a separate, hidden, incognito webview
with no application IPC (`apps/rust-desktop/src/research.rs`). Destinations that are not public
(loopback, private, link-local, carrier-grade NAT, multicast and other reserved ranges, checked
on the resolved addresses) and URLs carrying credentials are refused (`CONNECTION_DENIED`); names
that do not resolve say whether the machine is offline. Extraction is bounded (40,000 characters
of text, 100 links, 30 images, 30 metadata entries, 24,000 characters of structured data), and
results returned to agents mark page content as untrusted data. Agents may use
`research_read_page`; the other browser operations are for the person. The headless host has no
research surface. There are no built-in supplier APIs.
