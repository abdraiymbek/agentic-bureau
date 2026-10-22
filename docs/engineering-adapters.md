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
| `cad_check`                                        | yes         | Verifies explicit expectations and returns pass or fail per assertion, with measured against expected values, and per listed item                                                                                                    |
| `cad_view`                                         | no revision | Draws a revision or a `-D` variant as one picture: views at one scale, an isometric view and sections. A variant or a missing render runs as a render job. Writes the picture under `.omenflow/cache/views-v1/`                      |
| `image_view`                                       | no          | A PNG or JPEG file in the project with a grid labelled in fractions of its size, or a region of it enlarged up to 4x. Writes the picture under `.omenflow/cache/views-v1/`                                                           |
| `cad_export`                                       | yes         | Writes a part as STEP (exact `brep` or `faceted`, below), STL or SCAD; full profile, and only when the person asked for a file                                                                                                       |

`cad_write_source`, `cad_read_source`, `cad_check`, `cad_view` and `image_view` are in the
compact profile, `cad_export` is in full, and the others are in standard. Write, check and
inspect results take `detail: "brief" | "full"`; compact sessions get `brief` automatically.

**Pictures** (`cad/view.rs`). `cad_view` rasterizes the revision's stored mesh in software, the
mesh verification measured, with no engine run unless a variant or a missing render needs one.
Front, top and right (and back, left, bottom when asked) are placed as in a third-angle drawing
and share one round scale in mm per pixel; the result gives each panel's rectangle, view
direction, scale and origin, so a pixel maps to a model coordinate. Faces are shaded, feature
edges (creases over 30°, silhouettes, open edges) are ink, and edges behind a surface are dashed;
the isometric view has no hidden edges and is not to scale. A section is a cut normal to x, y or
z (`{axis, at}`) from `section.rs`, filled by parity so holes stay empty, and listed with its
outlines; with no `sections` one is drawn through the middle normal to y (`auto: true`), and
`sections: []` draws none. The same mesh and request give the same bytes. `image_view` decodes
the file once, after checking its header (at most 16,384 px a side, 50 megapixels and 32 MB),
applies EXIF orientation, lays transparency over white, and reads a `region` given in pixels
(any value above 1) as pixels and says so. Both are diagnostic: the result says the picture binds
and verifies nothing, and only `cad_check` verifies.

**Expectations.** The canonical form names `bbox`, `volume`, `solid` and `empty` points,
`sections` (holes, slots, polygons, outlines), `shells` and `watertight`. A short form expands to
it: `size`, `holes: [{at, d, axis?}]` (a section, a centre and diameter, and an empty probe),
`bodies` and one default `tol`.

**Spec items.** `expect.spec` lists the request item by item: `{item, requirementId?, …}` with
the item in the request's words (at most 200 characters) and its assertions under the same keys
as the top level (`size`, `holes`, `bodies`, `shells`, `bbox`, `volume`, `solid`, `empty`,
`sections`). The core checks each item's assertions strictly, whoever sends them.

- Every item's assertions are merged into the top level before anything is measured: lists join
  without repeats, sections join by plane, and a single value that disagrees (two diameters for
  one plane's outline) is refused with both places named: the item path and the other item, the
  top level of `expect`, or the requirement that states it. The canonical form keeps the items
  under `spec`, so they are hashed, committed and bound by the scope guard like any assertion.
  At most 128 items.
- Each check line belongs to the items whose assertions produce it, so every item gets a state:
  `passed`, `failed`, or `unasserted` when it has no assertion. Lines no item asks for
  (`watertight`, `self-intersections`) belong to none.
- Identity across checks: an item that had assertions is kept by any item that still asserts all
  of them, whatever its words; one without assertions is kept by the same words, case and
  spacing aside. A `requirementId` may be added to an item, never changed or removed. Dropping
  an item, or the words of one without assertions, is a scope change.
- Replies and the gate echo the request form: the top level keeps only what no item asserts, so
  each assertion appears once.
- **Linked requirements add items.** A requirement counts when it is a revision input or a manual
  edge (`validates`, `derived_from`, `depends_on`) of the part, or when the check names it in
  `requirementIds` or an item's `requirementId`. One that a committed check named in
  `requirementIds` stays in every later check that check binds (`via` `check`, linked by a
  person when a person ran a check that named it, otherwise by the agent), and the reply's
  `notes` say so: leaving it out does not drop it. A check reads that list again as it commits,
  so one that ran beside the check naming it keeps it too; when the requirement has features,
  which that check did not measure, it is refused with `INPUT_CHANGED` and repeated. The gate,
  readiness and the next expect read the same list. Each of its `features`
  (`{label, quantity?, expect?}`, validated on write; a blank label is refused) becomes an item;
  the feature's `expect` is taken only when the requirement links to this one mechanical part,
  since it is written in that part's frame. A requirement without features whose target is a
  length, area, volume or angle gives one row that only an item naming it with a dimensional
  assertion (`size`, `bbox`, `volume`, `sections` or `holes`) shows; a body count or points alone
  do not. An item in the words of the requirement's title is that row, not a second one (a blank
  title gives way to the statement). A requirement with no target, an unknown one, or another
  quantity (mass, time, a percentage) gives a row no check shows ("No check shows this
  requirement"): it never blocks and never passes. A requirement archived after a committed check
  named it is accepted, and its items are checked as listed items.
- A requirement's own assertions replace those sent for its feature; a listed value that
  disagrees with them is refused, naming both. Two linked requirements that state one assertion
  differently (one a committed check named among them) leave no check of the part to run: every
  `cad_check` is refused, and `work_status` names both requirements with no `next`, since a
  person has to reconcile them.
- A requirement row says whose assertions show it (`assertedBy`): the requirement's own, or ones
  listed for it (a statement row, or a feature of a requirement linked to several parts).
- The limit, plainly: without recorded requirements the item list is the agent's own reading of
  the request, and a requested feature left out of it is not checked. It adds independence only
  when a person records or approves the requirements behind it. Evidence says which:
  `requirementAuthority` is `requirements_and_declared` only when some item is shown by a
  requirement's own assertions, and every requirement whose assertions the check took is
  approved and linked by a person.

**Verification.** A check is a trial (exploratory, binds nothing) or committed. With
`autoCommit: true` the check runs once and commits when every assertion passes and no committed
assertion is dropped or changed; items without assertions stay partial, and a check of generic
mesh properties alone stays a trial. In an agent session `cad_write_source`, `cad_patch_source`
and `cad_set_param` also take `expect` and run that check on the revision they saved, in the
same call: the agent host chains it, and the core refuses `expect` from any other caller. A
reply that committed a check carries the session's `workStatus`. A committed check binds the
revision and its expectation hash. The status of a revision is `passed`, `failed`,
`scope_changed` (the expectations differ from the committed ones, for example an assertion
dropped or a tolerance loosened), `partial` (only generic checks ran, or listed items have no
assertion) or `unverified`, with `ready`
and a `nextAction` (`commit_assertions`, `repair_geometry`, `resolve_inputs`,
`request_review`, …; `accept_scope` when only linked requirements changed the scope, which a
person accepts). The same state is what `cad_check` answers, what `work_status` reports
(`cad_unverified`, `cad_spec_unasserted`, `cad_check_failed`, `cad_scope_changed`,
`cad_render_failed`) and what a proposal shows. A scope with listed items that lack an assertion
cannot be accepted. Evidence is recorded by checker `omenflow-rust-mesh-checks-v3` (0.2.4: a
section keeps a corner the cut meets twice next to a hole's vertex, which v2 could lose, and
closes a loop whose crossing falls on a rounding boundary, which v2 left as open chains);
evidence from earlier checkers stays readable. A 0.2.3 build ignores v3 checks and goes by its
own newest check (see [going back to 0.2.3](project-format.md#going-back-to-023)).

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
  inputs), or there is none while those inputs only await approval. A draft requirement as an
  input therefore leaves the part unverified until a person approves it; an edge does not.
- `cad_spec_unasserted` names a draft whose committed check has listed items without an
  assertion, or does not show a linked requirement as it stands: not taken into account
  (`not_considered`, for example a check made before 0.2.4), linked after the check
  (`linked_after`, from the edge's time), or changed since (`revised`, when what the check
  derives from it differs). Its `next` is a `cad_check` with the committed expect as the linked
  requirements state it now, the new requirement items, and an item naming each statement
  requirement no item shows yet, without assertions: the agent adds them. For a changed
  statement target it names the items that show the requirement, to restate. When the call
  changes committed values (a changed requirement, or one whose values differ from committed
  ones) it has no `autoCommit`, so the changed scope is recorded for a person.
- A check's scope changes are split by cause. What linked requirements now state differently
  (changed since, or linked since with other values) is listed in the evidence's
  `spec.replaced`, what the check changed itself in `spec.checkChanges`; every earlier scope is
  read as the requirements state it now, so a failed check in between does not move the blame.
  When only requirements changed it, the `cad_scope_changed` item has no `next` and the reply no
  `committedExpect`: a person accepts the new scope. When the check also dropped something
  itself, the item names that and its `next` restores it.
- Requirements linked or changed after an approved baseline's check do not change its recorded
  status: review shows a notice, and `build.preview` lists them under the item's `notices`
  without refusing the export.
- A render identity in a draft's payload is kept only when its `renderJobId` names a succeeded
  `cad_render` job of this project with the same source hash, parameters and output hash;
  otherwise every derived output is removed, so a draft cannot claim a render it did not have.

**Not listed for agents but still callable** (through `tool_call` or `omenflow call`):
`cad.render` (the background job the interface uses), `cad.validate_source`, `cad.probe`,
`job.read`, `job.list`, `job.cancel`.

### STEP export

`cad_export` with `format: "step"` writes a STEP (AP214) solid that matches the revision's
checked render, the mesh `cad_check` measured (`cad/step.rs`). The result says which of two
methods made it (`method`, `exact`) and how it compares with the render (`checks`):

- **brep, exact surfaces.** OpenSCAD evaluates the stored source with the recorded parameters
  into its CSG tree (`-o output.csg`, the same `-D` values as the render). An optional Python
  with OCP rebuilds that tree with OpenCASCADE (`cad/csg_to_step.py`, which needs only the
  standard library and OCP), writes the file and reads it back. The core uses the file only
  when, as read back, it is valid, every shell is closed, it has no free edges and every face
  tessellates; it has as many solids as the render has bodies; its volume is within 0.5 % of the
  render's and its bounding box within max(0.05 mm, 0.5 % of the largest extent); at most 3 of
  512 points through the bounding box classify differently (one the converter finds on the exact
  surface is not compared, and is counted as `sampleOnSurface`); and the probe pairs agree.
- **Probe pairs.** Each sits just inside and just outside a face. The core places them on every
  smooth surface of the render (a planar face, a cylinder wall, a sphere: triangles meeting at under
  30°), four on each while 2,048 pairs allow, never fewer than two (the budget grows to 8,192); the
  converter places them on the exact solid's own faces the same way, away from the edges of its mesh
  triangles, and the core classifies those against the render. At most 2 pairs may disagree on each
  side, and at the render's faces only where the facets or rounding could explain it: a face of the
  render must lie within 1.5 times the facet bound plus the rounding of the point that disagrees, or
  the pair is a lost feature however few there are (a pair that had to move in to 1.5 times the
  bound has its own face that near, and is held to the count). The rounding is 1e-5 mm plus
  the single-precision step at the part's largest coordinate (about 0.000022 mm for a 100 mm part at
  the origin). On a tree of flat faces (no curved primitive; cylinders and circles of 3 to 8 facets
  count as flat), whose facets are its exact faces, the facet bound is 0, so the rounding alone
  explains a disagreement, and the same rule holds at the solid's own faces. On a curved tree the
  count alone applies there: on the corpus below, a correct rebuild had one pair there 0.117 mm from
  every face of the render, beyond its 0.108 mm reach, where the render's facets lie farther from
  the exact surface than the bound says. No surface may lose most of its pairs: a hole or boss the
  rebuild lost, or material it added, takes its own surface's pairs with it. The first offset is
  three times the facet bound: the largest r(1 − cos(π/f)) of any curved primitive in the CSG tree
  (about twice that for a sphere's faces, a revolution's at its profile's farthest point, 0.01 mm
  for an approximated `hull()`), stretched by that primitive's own enclosing transforms only. Guard
  points a margin further out (1.5 times the facet bound, at least the smallest offset) must
  classify as the pair does, so neither point lies near another face. A pair that crosses a wall or
  gap is tried elsewhere on the surface, then at half the offset, down to 0.001 mm or 1e-5 of the
  part's size. A pair nearer the face than 1.5 times the facet bound counts only when it agrees,
  since the facets themselves may lie that far from the exact surface; one that disagrees is set
  aside (`surfaceSetAside`, `solidSetAside`). A surface left with fewer than two pairs that count is
  never vouched for: the export is faceted with that reason. A lost hole, boss or pocket with faces
  of its own is found however small it is beside the part. A feature of the render that blends into
  a face at under 30° (a shallow dimple, groove or blend) shares that face's pairs, which are spread
  by area (about one per 11 mm² on a 100 × 100 × 5 mm plate), and a lost one is found only where a
  pair lands on it and it is deeper there than the probe offset (`checks.probeOffsetMm`); otherwise
  it can be lost unseen and the file still called exact. Material the rebuild added brings faces of
  its own to the exact solid, each with pairs of its own: it is found where it stands higher than
  the offset under most of a face's pairs, or under one on a tree of flat faces. Added material that
  merges into a face the solid already had shares that face's pairs and, on a curved tree, is found
  only when three of them land on it. On that plate with OCP 7.9.3: with 64-facet sphere cutters
  (offset 0.072 mm), a lost dimple 2.8 to 4.4 mm across and 0.1 to 0.25 mm deep was refused, and one
  1.9 mm across or less, or 0.08 mm deep or less, was not seen (one 1.3 mm across that meets the
  plate at 41°, and so has its own surface, was refused); with a hexagonal pyramid cutter, a tree of
  flat faces (offset 0.0014 mm), a lost dimple 3 to 8 mm across and 0.05 to 0.3 mm deep was refused,
  as was the pyramid added as a bump, and one 2.5 mm across or less, or 4 mm across and 0.01 mm
  deep, was not seen. Not probed: slivers a boolean left between faces, narrower across than the
  smallest offset (`surfaceSlivers`, `solidSlivers`), and faces of the exact solid on which no pair
  fits (`solidUnprobedFaces`); added material that thin would go unseen.
- **What else is checked.** Rust also checks the file's own bytes (its size, ISO 10303-21
  framing, the AP214 schema, a solid); `checks.basis` names the OCP version that read it back,
  and the job and `converter` name the OCP and Python versions the converter ran with. A
  `hull()` other than of upright cylinders or circles is rebuilt as planar facets
  (`exact: false`, listed in `approximations`). Cylinders and circles OpenSCAD drew with 3 to 8
  facets stay the polygons they are; with more, and spheres and revolutions with any number,
  they are rebuilt as true surfaces, and those drawn with fewer than 32 facets are named in
  `notes`. As in OpenSCAD, an empty operand (a false `if()`, `cube(0)`) empties an
  `intersection()` and a `difference()` from it, a 2D outline is one region when it is swept or
  offset, and a `rotate_extrude` sweeps from its `start` angle.
- **faceted, planar faces.** The render's own triangles as a solid (`cad/faceted.rs`, no CAD
  kernel): coplanar neighbours merge into polygonal faces with inner loops, each body is one
  closed shell, a cavity is a void. Every vertex is a render vertex; nothing moves. It is always
  available, up to 250,000 render triangles, and it is the fallback: `reason` says why exact was
  not used. `method: "faceted"` asks for it directly.

Not rebuilt exactly (the export is then faceted, with the reason): `minkowski()`, `resize()`,
`offset()` with chamfer, `linear_extrude` with twist or scale, `roof()`, `projection()`,
`text()`. OpenCASCADE's own `offset` can fail or be slow.

- **One deadline.** `timeoutMs` (default 120,000, at most 300,000) covers finding the Python,
  the CSG run and the converter; reaching it falls back to faceted. The work runs as a
  `cad_export` job (tool `omenflow-step`) with the core lock released and stops on
  `job.cancel`; a cancelled export writes nothing. The job does not bring the part into the
  session's `work_status` scope: exporting someone else's draft is not working on it.
- **Which revision.** `revisionId`, else a person's baseline, else an agent's newest revision.
  It needs a render of its own source and parameters (`details.reason: "NO_RENDER"`) that is one
  closed solid (`"NOT_A_SOLID"`). Notes say when the revision is a draft, proposed, rejected or
  superseded, or has no passing `cad_check`.
- **Where.** A person writes anywhere (an absolute path) or inside the project. An agent writes
  only under `exports/` inside the project, judged on the resolved path, with the format's
  extension (`.step` or `.stp`, `.stl`, `.scad`), and never over a file that no earlier export
  wrote.
- **Record.** Every export emits `cad.exported` (Timeline: “Exported STEP”, “Exported STEP
  (faceted)”, “Exported STL”). The job records the file's hash and the programs by file name;
  its inputs hold no machine path, and its error names a destination outside the project by its
  file name (its log names the Pythons it tried in full; a project archive cuts them to their
  file names). Nothing is cached, and exports are not revision files.
- **STL and SCAD** copy the revision's stored file of any artifact type, as before. They are
  not staged, run no job, and honour `idempotencyKey`.

**The converter is optional and installed separately.** OpenCASCADE (LGPL) is never bundled or
downloaded. The core looks, in order, at Settings → Engineering tools → STEP converter
(`toolPaths.python`), `OMENFLOW_PYTHON`, `~/.omenflow-step/bin/python3`, `python3` and `python`
on `PATH`, `/opt/homebrew/bin/python3` and `/usr/local/bin/python3` (Linux: `/usr/bin/python3`),
and on macOS the login shell's `python3`. macOS's `/usr/bin/python3` is used only when it is
configured. A Python counts when `python -E -c "import OCP"` works (30 s limit). An export's
search remembers a success until the executable file changes and a failure for a minute, and
forgets the success when the converter then cannot import OCP; Settings and `tool_doctor` (which
reports it as `results.python`) always check again, since installing or removing OCP with pip
leaves the interpreter untouched. To set one up (Python 3.11 to 3.14):

```sh
python3.12 -m venv ~/.omenflow-step
~/.omenflow-step/bin/python -m pip install cadquery-ocp-novtk==7.9.3.1.1
# or, with uv:
uv venv --python 3.12 ~/.omenflow-step
uv pip install --python ~/.omenflow-step/bin/python cadquery-ocp-novtk==7.9.3.1.1
```

OCP 7.9.3 is the release CADGenBench's own STEP validity check uses.

Measured on the 49 parts of an earlier CADGenBench run with OCP 7.9.3 on a loaded machine: 46
exact (42 without approximations, 4 with an approximated `hull()`), 3 faceted (an `offset()`
OpenCASCADE could not make, one rebuilt 5.8 % off in volume, one face that does not tessellate).
Every exact file is one solid, as every render is one body. The accepted parts differed from
their renders by at most 0.075 % in volume and 0.016 mm in bounding box, with at most 1 of 512
points through the box, no probe pair at the render's faces and 1 at a solid's own faces
disagreeing, and no pair set aside. A copy of each part's CSG tree without the last child of its
first `difference()` was refused every time (32 by volume, 15 by the probes, 2 parts that were
faceted anyway); a copy without one cutter primitive was refused 41 times in 42 (27 by the
probes, 12 by volume, 2 faceted anyway), and the one accepted copy had lost a cutter that cut
nothing (the same volume to the cubic millimetre). CADGenBench's own validity check passed all 49
files the exports chose, the faceted ones included, in at most 62 s each. Exports took 3 s median
and 14 s at the 90th percentile (99 s at most). Faceted files of all 49: median 1,258 faces and
1.3 MB, at most 9,817 faces and 7.5 MB, every volume within 0.000002 % of the render's; the three
largest (5.1–7.5 MB) ran past that validity check's 180 s tessellation limit on the same machine.
Run again with the rule that a pair at the render's faces must disagree within the facets' reach
plus the rounding of a face, the 49 parts chose the same methods and the seeded copies were refused
for the same reasons; that rule refused none of them. Every one of the 49 has a curved primitive,
so none ran on the flat-face rule; 12 trees of flat faces written for it (rotated and scaled
cubes, polygons, a polyhedron, 3- to 8-facet holes, 0.5 mm walls, a 2 m plate, a plate 2.2 m from
the origin; `exact_rebuilds_of_flat_trees_agree_everywhere`) were all accepted with no pair or
point disagreeing.

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
