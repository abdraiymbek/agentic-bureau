# Verify a part

Only a committed cad_check with verificationStatus "passed" and ready true is verification. Measurements, a render or a trial are not.

1. Write the expectations from the request, never copied from the report: bbox min and max, volume when you can compute it, shells 1 for one part, sections with each hole's center and d, and solid and empty points for pockets, blind depths and chamfers. Cover every requested dimension and feature.
2. Trial first: cad_check with the artifactId, expect and exploratory true.
3. Trial fails: fix the geometry and trial again. Change an expectation only when it misread the request, and say why. Never drop, weaken or move a valid failing expectation, and never pick expectations to match the measurement.
4. Trial passes: send the identical expect on the same revision with exploratory false. Do not stop after the trial.
5. Read ready, verificationStatus and the next action. passed: verified for this revision and scope. failed: fix the geometry and repeat the same expect. scope_changed: restore the committed expectations, or stop and ask the reviewer to accept the corrected scope. partial: add the missing dimensions. unverified: commit against the current render.
6. A committed scope stays binding. A new revision or a new request does not erase earlier evidence.

Getting sections right:

- Cut through the middle of a feature, never on a face. center is [x,y] for a z cut, [x,z] for a y cut, [y,z] for an x cut.
- An open edge pocket changes the outer outline; it is not a closed hole or slot.
- Tilted bore: for the plane z = a*x + b*y + c a normal is [-a,-b,1]; reversing it flips all three components. Its dot products with [1,0,a] and [0,1,b] must be zero. Take test points from entry + t*normal. In an axis-aligned cut a tilted round bore is an ellipse, and a higher $fn does not change that: use cad_inspect with origin and normal.
- cad_inspect is for debugging only and never verifies. Optional diagnostics do not block; do not chase them.
- preserve.changeRegions checks that geometry outside the change stayed put.

Name any state other than passed in your answer, then call work_status.
