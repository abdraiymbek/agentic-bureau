# Engineering adapters

## CAD — OpenSCAD

- Discovery: PATH + platform locations + user-selected executable.
- Contract: probe → version + probe render; validate_source; render (job:
  source hash, params, input revisions, tool version, timeout); inspect
  (parse STL, bounds, facets); export.
- Missing executable → `TOOL_MISSING` with `Locate OpenSCAD` repair action.

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
