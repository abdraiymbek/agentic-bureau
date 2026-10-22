# Model a part in OpenSCAD

1. New part: cad_write_source with title, the complete source and expect. Change: cad_read_source, then cad_write_source on the same artifactId (never a second part) with expectedRevisionId from that read, the whole edited source and expect. One call saves a draft, renders, measures and checks it; the check commits when every assertion passes.
2. Write expect from the request, never from a reply: bodies 1, and in spec one item per requested dimension or feature, {"item": "<the request's words>", ...assertions}: size [x,y,z] or bbox {min,max}; holes [{at,d,axis}], at on the axis inside material; volume {value}; solid and empty points for pockets, slots and blind depths; sections [{axis, at, outer:{d|size}, holes:[{center,d}]}] through grooves, steps and profiles, center in the cut plane's two axes. An item without an assertion stays partial.
3. Read the reply. ready true: verified for this revision. failed: fix the source and resend the same expect; change an assertion only when it misread the request, and say why; never drop or loosen a failing one. Render failed: read render.errors, fix, write again. guide_read cad-verify for tilted bores or a failure you cannot explain.

Source rules against wrong geometry that still renders:

- mm, +Z up, absolute coordinates unless stated; $fn = 64; first; key dimensions as top-level name = value; lines.
- Self-contained: no include, use, import, surface, text() or rands(); say so instead of retrying an unsupported dependency.
- A cutter in difference() passes beyond the faces it cuts; one ending on a face leaves a skin.
- One body needs overlapping volumes; touching faces are not joined.
- rotate([90,0,0]) points a Z cylinder along -Y, [-90,0,0] along +Y, [0,90,0] along +X.
- A blind depth is measured from the face being drilled.
- cylinder(d = D, $fn = N): D is across corners, D*cos(180/N) across flats.

Never run OpenSCAD in a shell or edit files under artifacts/. When a reply's workStatus.ready is true, nothing recorded blocks: do the rest of the request, if any; when it is absent or false, then call work_status.
