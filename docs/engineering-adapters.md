# Engineering adapters

## CAD — OpenSCAD

- Discovery: PATH + platform locations + user-selected executable.
- Contract: probe → version + probe render; validate_source; render (job:
  source hash, params, input revisions, tool version, timeout); inspect
  (parse STL, bounds, facets); export.
- Missing executable → `TOOL_MISSING` with `Locate OpenSCAD` repair action.

### Agent-facing CAD vocabulary

Agents get four ops (MCP tools `cad_write_source`, `cad_read_source`,
`cad_inspect`, `cad_check`). The model decides what geometry should exist;
Omen Flow renders, measures, and verifies deterministically.

| op                 | mutating | what it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cad.write_source` | yes      | Plain-text OpenSCAD source → new draft revision on a new or existing mechanical artifact. Renders synchronously (default 90 s timeout), stores source + STL, records top-level parameters, and returns a **geometry report**: render ok/warnings/errors, envelope, volume, surface area, watertightness, body count, mid-plane cross-sections (holes/slots/polygons/outlines with positions and diameters), detected parameters, and notes (inside-out mesh, disconnected bodies, coarse `$fn`, missing parameters). |
| `cad.read_source`  | no       | Source text of the newest (or given) revision with its parameters — for modification tasks.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `cad.inspect`      | no       | Same report for any revision, plus caller-chosen cutting planes and solid/empty probe points; may re-render with `-D` parameter overrides without committing.                                                                                                                                                                                                                                                                                                                                                        |
| `cad.check`        | no       | Verifies explicit expectations (`bbox`, `volume`, `solid`/`empty` points, `sections` with holes/slots/polygons/outlines, `shells`, `watertight`) and returns PASS/FAIL per assertion with measured vs expected values. Recorded as a `cad_check` job for evidence.                                                                                                                                                                                                                                                   |

Design rules behind the vocabulary:

- **No base64, no polling, no id archaeology.** Source is plain text; the
  render is awaited; every response carries `artifactId`/`revisionId`; ops
  default to the newest revision.
- **Structured failure.** A render that produces nothing returns
  `render.ok=false` with the OpenSCAD reason and the source is still saved as a
  draft; unknown `params` keys are rejected with the list of declared
  variables; OpenSCAD `WARNING` lines are returned as data.
- **Measurement, not pictures.** The mesh layer (`packages/core/src/mesh.ts`)
  computes bounds, signed volume, area, edge-manifold check, connected shells,
  ray-parity containment, and planar sections with loop nesting and circle /
  rectangle / regular-polygon recognition. Validated against OpenSCAD renders
  of closed-form shapes (`packages/engineering/src/mesh.test.ts`).
- **Legacy ops stay.** `cad.render` (background job for the GUI),
  `cad.validate_source`, `cad.probe`, and `job.*` remain valid but are marked
  `agentVisible: false` so they are not offered as agent tools.

The evaluation suite in `evals/cad/` drives this vocabulary end to end with a
real agent CLI and judges results with the same check engine.

## Analysis — restricted mathjs

- Templates: mass budget, power/current budget, battery energy, torque/load.
- Restricted expression evaluation: no imports/fs/assignments; worker
  isolation; timeout + expression-size limits; function allowlist;
  dimension checks before save.

## Wiring

- Structured pins/connections tied to component revisions.
- Checks: voltage-range incompatibility, missing ground return, duplicate
  exclusive-pin assignment, changed-component invalidation. Coverage is
  labeled; not a schematic ERC replacement.

## Research / supplier

- Generic webpage/datasheet capture via isolated research browser.
- No built-in commercial APIs; suppliers implement the same
  source/candidate/offer schema when users add connections.
