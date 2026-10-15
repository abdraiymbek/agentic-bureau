# Model a part in OpenSCAD

1. New part: cad_write_source with title and the complete source as plain text. Change to an existing part: cad_read_source first, then work on the same artifactId. Use cad_set_param for one top-level value, cad_patch_source to replace one snippet that occurs once, cad_write_source for a rewrite. Never create a second part for a change, and do not pass params that equal the defaults.
2. Each of these saves a draft revision, renders it and returns a measured report: envelope, volume, watertightness, bodies, mid-plane sections with holes and outlines, parameters, warnings. Compare it with the request. A wrong envelope, a missing hole, two bodies or a warning means: fix the source and write again.
3. A measured report is not verification. Continue with guide_read topic cad-verify.

Source rules that prevent wrong geometry which still renders:

- Units are millimetres, +Z is up, request coordinates are absolute unless stated.
- Self-contained and deterministic: no include, use, import, surface, text() or rands(). Say so instead of retrying an unsupported dependency.
- Set $fn = 64; at the top so round features are round.
- Expose key dimensions as top-level name = value; lines.
- A cutter inside difference() must pass beyond the faces it cuts (start below, end above); one that stops on a face leaves a zero-thickness skin.
- One body needs overlapping volumes. Faces that only touch are not joined.
- polyhedron(): list each face's points clockwise seen from outside. An inside-out source is not verified even when it displays; reverse the winding and rewrite.
- rotate([90,0,0]) points a Z cylinder along -Y, rotate([-90,0,0]) along +Y, rotate([0,90,0]) along +X.
- A blind depth is measured from the face being drilled, not from the origin.
- cylinder(d = D, $fn = N) is a polygon: D is across corners; across flats is D*cos(180/N).
- cad_compose only places existing parts with translate and rotate; there are no mates.

Do not run OpenSCAD in a shell or edit files under artifacts/. After the part renders as requested, verify it, then call work_status.
