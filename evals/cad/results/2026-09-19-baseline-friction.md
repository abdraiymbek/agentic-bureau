# Friction classification — /tmp/omen-eval/baseline  (45 runs)

- runs with zero friction events: 0
-  58 events in 34 runs — shell: filesystem exploration (no bootstrap context delivered)
      e.g. basic-plate/r1: /bin/zsh -lc 'find . -maxdepth 4 -type f -print | sort'
      e.g. bracket-thicken/r3: /bin/zsh -lc "rg --files -g '*' | head -100"
-  47 events in 33 runs — shell: git in a non-git project
      e.g. basic-plate/r1: /bin/zsh -lc "rg --files -g '"'!*.stl'"' -g '"'!*.png'"' -g '"'!*.jpg'"' | head -200 && git status --short"
      e.g. bracket-thicken/r2: /bin/zsh -lc "rg --files -g '"'!*.stl'"' -g '"'!*.png'"' -g '"'!*.jpg'"' | sort && git status --short"
-  45 events in 45 runs — agent-loop: job polling required for render
-  45 events in 45 runs — state-tracking: had to read artifact/history to find render revision
-  45 events in 45 runs — validation gap: only bounding-box inspection available/used
-  44 events in 44 runs — state-tracking: inspect on pre-render revision (render committed a new revision silently)
      e.g. basic-plate/r1: {
  "code": "NOT_FOUND",
  "message": "No STL output on revision"
}
      e.g. basic-plate/r2: {
  "code": "NOT_FOUND",
  "message": "No STL output on revision"
}
-  36 events in 36 runs — shell: reading README/project.json for orientation
      e.g. basic-plate/r1: /bin/zsh -lc "sed -n '1,200p' omenflow.project.json; sed -n '1,160p' README.md"
      e.g. bracket-thicken/r2: /bin/zsh -lc "sed -n '1,260p' README.md && sed -n '1,260p' omenflow.project.json"
-  34 events in 34 runs — unverified done: final message claims verification with only bounds/manifold evidence
      e.g. basic-plate/r1: Created and rendered the mechanical artifact.

- [OpenSCAD source](</private/var/folders/nk/5wlz1lmd63z6h9x2yh8pcgxm0000gn/T/omenflow-eval-basic-plate-NWrjbq/pr
      e.g. basic-plate/r2: Created and rendered the mechanical artifact in Omen Flow.

- Source: `plate.scad`
- Rendered STL: `artifacts/mechanical/100-x-40-x-6-mm-rectangular-plate-2.stl
-  27 events in 21 runs — shell: other
      e.g. basic-plate/r1: /bin/zsh -lc "sed -n '1,120p' plate.scad; shasum -a 256 plate.scad artifacts/mechanical/100-x-40-x-6-mm-rectangular-plate-2.stl"
      e.g. bracket-thicken/r2: /bin/zsh -lc "sed -n '1,240p' artifacts/mechanical/shelf-bracket.scad && sed -n '1,240p' artifacts/mechanical/shelf-bracket.json"
-  21 events in 15 runs — shell: base64-encoding source by hand
      e.g. bracket-thicken/r1: /bin/zsh -lc "python3 -c 'import base64;print(base64.b64decode(\"Ly8gU2hlbGYgYnJhY2tldCDigJQgbWlsbGltZXRyZXMuIEJhc2UgNjAgeCA0MCwgdmVydGljYWwgcGxhdGUgb24gdGhlIGJ
      e.g. bracket-thicken/r1: /bin/zsh -lc "printf '%s' '// Shelf bracket — millimetres. Base 60 x 40, vertical plate on the back edge.
"'$fn = 64;
difference() {
    union() {
        cube(
-  18 events in 16 runs — poor abstraction: scad source base64-encoded into tool args
-   7 events in  7 runs — duplicate artifacts created (retry after error)
-   5 events in  5 runs — scope creep: export/proposal/review detour
-   5 events in  5 runs — render retried
-   4 events in  4 runs — poor error: create_draft payload → raw zod INTERNAL
      e.g. basic-plate/r1: {
  "code": "INTERNAL",
  "message": "[\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"array\",\n    \"received\": \"undefined\",\n    \"path\": [\n
      e.g. basic-plate/r3: {
  "code": "INTERNAL",
  "message": "[\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"array\",\n    \"received\": \"undefined\",\n    \"path\": [\n
-   3 events in  3 runs — litter: .omenflow-conflict files seen by agent
      e.g. bracket-thicken/r2: /bin/zsh -lc "find artifacts -maxdepth 3 -type f -print | sort && sed -n '1,80p' artifacts/mechanical/shelf-bracket.scad"
      e.g. nema17-motor-mount/r1: /bin/zsh -lc "sed -n '1,220p' artifacts/mechanical/nema-17-stepper-motor-mount.json && printf '\\n--- conflict ---\\n' && sed -n '1,120p' artifacts/mechanical/n
-   3 events in  3 runs — tool error: artifact_import_file PATH_OUTSIDE_PROJECT
      e.g. flanged-hub/r1: {
  "code": "PATH_OUTSIDE_PROJECT",
  "message": "Absolute path not allowed: /private/var/folders/nk/5wlz1lmd63z6h9x2yh8pcgxm0000gn/T/omenflow-eval-flanged-hub-
      e.g. spacer-ring/r3: {
  "code": "PATH_OUTSIDE_PROJECT",
  "message": "Absolute path not allowed: /private/var/folders/nk/5wlz1lmd63z6h9x2yh8pcgxm0000gn/T/omenflow-eval-spacer-ring-
-   3 events in  2 runs — shell: bypassed Omen Flow, ran openscad directly
      e.g. inclined-foot/r2: /bin/zsh -lc "sed -n '1,240p' inclined_foot.scad && sed -n '1,240p' artifacts/mechanical/inclined-wedge-foot-openscad-source.json"
      e.g. nema17-motor-mount/r3: /bin/zsh -lc "pwd && rg --files -g '"'!*.png'"' -g '"'!*.stl'"' -g '"'!*.3mf'"' | head -200 && printf '\\n--- tool hints ---\\n' && rg -n \"omenflow|openscad|re
-   2 events in  2 runs — backend bug: quantity params not unwrapped in cad.render (degenerate render)
      e.g. l-bracket-parametric/r1: {"artifactId": "e70a7319-72b2-4848-bbce-dc73b719c1f7", "revisionId": "c6625bf1-04ee-4957-bf2d-d9645273742c", "idempotencyKey": "l-bracket-render-v1", "timeoutMs
      e.g. l-bracket-parametric/r2: {"artifactId": "a1c2daf2-9ce6-41a0-bd5d-4eec2e3bf0a1", "revisionId": "914980b9-e9da-4b32-850d-c66e57dc6ad8", "params": {"base_length": {"value": 60, "unit": "mm
-   1 events in  1 runs — tool error: artifact_update_draft ERR
      e.g. l-bracket-parametric/r1: MCP error -32602: Input validation error: Invalid arguments for tool artifact_update_draft: Invalid uuid at draftRevisionId
-   1 events in  1 runs — tool error: artifact_read_file NOT_FOUND
      e.g. sensor-plate-modify/r2: {
  "code": "NOT_FOUND",
  "message": "Revision not found: fac7c998-6749-4632-a85a-bf2a081acc10"
}
