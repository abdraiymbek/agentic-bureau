# Verify a part

Only a committed check with verificationStatus "passed" and ready true is verification; a measured report, a render, a picture or a trial is not.

1. Check in the same call: cad_write_source with expect, or cad_check with the artifactId, expect and autoCommit true. It commits when every assertion passes; items without assertions stay partial, and a failing run binds nothing.
2. Take expect from the request, never from a reply: one expect.spec item per requested dimension and feature, in the request's words, with the assertions that show it (size or bbox, holes, volume when computable, solid and empty points, sections). For a part built to requirements, give cad_check their requirementIds, or name one on its item with requirementId.
3. Read ready, verificationStatus and next. passed: verified for this revision and scope. failed: fix the geometry and repeat the same expect. scope_changed: restore committedExpect, or stop and ask the reviewer to accept the new scope. partial: add the missing assertions. unverified: make the call next names.
4. Change an assertion only when it misread the request, and say why. Never drop, weaken, move or reword a failing assertion or an item; never pick values to match the measurement. A committed scope stays binding across revisions: send every item again.

Sections:

- Cut through the middle of a feature, never on a face. center is [x,y] for a z cut, [x,z] for a y cut, [y,z] for an x cut.
- holes take center and d; slots center and size; outer the outline (d or size); holeCount and outerCount catch missing or extra cuts.
- A groove, step or chamfer changes the outline: assert outer in a section through it, or solid and empty points at its flanks and bottom.
- An open edge pocket changes the outer outline; it is not a closed hole or slot.
- Tilted bore: for the plane z = a*x + b*y + c a normal is [-a,-b,1]; its dot products with [1,0,a] and [0,1,b] are zero. Take test points from entry + t*normal. An axis-aligned cut shows a tilted bore as an ellipse at any $fn: use cad_inspect with origin and normal.
- cad_inspect and cad_view are for debugging; they never verify. preserve.changeRegions checks that geometry outside the change stayed put.

Name any state other than passed in your answer. If the last reply's workStatus.ready is true, do the rest of the request, if any; if not, then call work_status.
