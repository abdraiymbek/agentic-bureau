# CAD eval — main suite · gpt-5.6-luna (high)

Runs passed: **41/45** · checks passed: 839/846 · tasks fully reliable: 13/15

| task | category | pass rate | checks | avg tool calls | avg tool errors | avg shell | avg time | avg out tokens | avg input tokens |
|---|---|---|---|---|---|---|---|---|---|
| basic-plate | basic | 3/3 | 21/21 | 10.7 | 1.7 | 1.3 | 86s | 3270 | 335802 |
| spacer-ring | basic | 3/3 | 39/39 | 9.0 | 1.3 | 4.0 | 83s | 3074 | 382180 |
| l-bracket-parametric | parametric | 3/3 | 60/60 | 13.0 | 2.0 | 5.3 | 173s | 6029 | 579664 |
| flanged-hub | feature-composition | 3/3 | 63/63 | 9.3 | 1.0 | 3.0 | 87s | 3129 | 387987 |
| standoff-plate | spatial | 3/3 | 57/57 | 12.3 | 1.0 | 5.0 | 134s | 4964 | 530023 |
| slotted-link | engineering-constraints | 3/3 | 45/45 | 9.7 | 1.0 | 4.0 | 104s | 4262 | 414039 |
| sensor-plate-modify | modification | 3/3 | 54/54 | 16.7 | 1.3 | 3.3 | 186s | 6103 | 670236 |
| nema17-motor-mount | complete-object | 3/3 | 87/87 | 12.0 | 1.0 | 4.7 | 115s | 4696 | 535522 |
| stepped-shaft | spatial | 3/3 | 60/60 | 11.3 | 1.3 | 7.3 | 150s | 6181 | 619335 |
| open-box | feature-composition | 3/3 | 78/78 | 13.0 | 1.0 | 5.3 | 120s | 4856 | 438528 |
| nut-trap-plate | engineering-constraints | 3/3 | 51/51 | 26.0 | 1.0 | 4.3 | 122s | 3970 | 428629 |
| inclined-foot | spatial | 0/3 | 42/48 | 10.0 | 1.0 | 4.3 | 110s | 4167 | 409385 |
| v-pulley | engineering-constraints | 3/3 | 63/63 | 9.3 | 1.0 | 4.0 | 105s | 4270 | 362269 |
| slotted-disc | spatial | 2/3 | 62/63 | 10.0 | 1.0 | 6.0 | 133s | 4954 | 466604 |
| bracket-thicken | modification | 3/3 | 57/57 | 13.3 | 1.0 | 3.0 | 169s | 5716 | 595043 |
| **all** | | 41/45 | 839/846 | 12.4 | 1.2 | 4.3 | 125s | 4643 | 477016 |

## Failed checks

- inclined-foot/r1: ✗ watertight: boundary edges 0, non-manifold 0, inverted true
- inclined-foot/r1: ✗ solid at (21.552, 15, 6.366): EMPTY — expected material
- inclined-foot/r1: ✗ empty at (18.06, 15, 7.239): MATERIAL — expected empty
- inclined-foot/r1: ✗ empty at (16.847, 15, 2.388): MATERIAL — expected empty
- inclined-foot/r2: ✗ watertight: boundary edges 0, non-manifold 0, inverted true
- inclined-foot/r3: ✗ watertight: boundary edges 0, non-manifold 0, inverted true
- slotted-disc/r2: ✗ volume: 22913.714 mm³ — expected 22155.927 ±1.5% (off by 3.42%)

## Runs

## basic-plate r1 (basic) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (100, 40, 6) — expected min (0, 0, 0) max (100, 40, 6) ±0.1
- ✓ volume: 24000 mm³ — expected 24000 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (50, 20, 3): material present

  note: 2 mechanical artifact(s) present, expected 1

  turns 1 · tool calls 10 (errors 2) · shell 4 · 98s · in 410978 (cached 377856) out 3638 (reasoning 871)
  tools: artifact_create_draft×2, cad_probe×1, cad_validate_source×1, cad_render×1, job_read×2, cad_inspect×2, artifact_read×1

## basic-plate r2 (basic) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (100, 40, 6) — expected min (0, 0, 0) max (100, 40, 6) ±0.1
- ✓ volume: 24000 mm³ — expected 24000 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (50, 20, 3): material present

  turns 1 · tool calls 10 (errors 1) · shell 0 · 60s · in 236437 (cached 213248) out 2362 (reasoning 723)
  tools: project_summary×1, cad_probe×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_history×1, artifact_read×1

## basic-plate r3 (basic) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (100, 40, 6) — expected min (0, 0, 0) max (100, 40, 6) ±0.1
- ✓ volume: 24000 mm³ — expected 24000 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (50, 20, 3): material present

  note: 2 mechanical artifact(s) present, expected 1

  turns 1 · tool calls 12 (errors 2) · shell 0 · 100s · in 359992 (cached 306688) out 3810 (reasoning 922)
  tools: project_summary×1, artifact_list×1, cad_probe×1, artifact_create_draft×2, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1, artifact_history×1

## spacer-ring r1 (basic) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-10, -10, 0) max (10, 10, 12) — expected min (-10, -10, 0) max (10, 10, 12) ±0.15
- ✓ volume: 3102.683 mm³ — expected 3104.899 ±1.5% (off by 0.07%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (7, 0, 6): material present
- ✓ solid at (0, -7, 6): material present
- ✓ empty at (0, 0, 6): empty
- ✓ empty at (0, 0, -1): empty
- ✓ section z=6: hole count: 1 hole loop(s) — expected 1
- ✓ section z=6: hole d8.4 at (x=0, y=0): found d=8.4 at (0, 0) roundness 0.999
- ✓ section z=6: outer circle d20: found d=20 at (0, 0) roundness 0.999

  turns 1 · tool calls 10 (errors 1) · shell 5 · 86s · in 340599 (cached 300288) out 3218 (reasoning 1212)
  tools: project_summary×1, cad_probe×1, artifact_import_file×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1, artifact_history×1

## spacer-ring r2 (basic) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-10, -10, 0) max (10, 10, 12) — expected min (-10, -10, 0) max (10, 10, 12) ±0.15
- ✓ volume: 3102.683 mm³ — expected 3104.899 ±1.5% (off by 0.07%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (7, 0, 6): material present
- ✓ solid at (0, -7, 6): material present
- ✓ empty at (0, 0, 6): empty
- ✓ empty at (0, 0, -1): empty
- ✓ section z=6: hole count: 1 hole loop(s) — expected 1
- ✓ section z=6: hole d8.4 at (x=0, y=0): found d=8.4 at (0, 0) roundness 0.999
- ✓ section z=6: outer circle d20: found d=20 at (0, 0) roundness 0.999

  turns 1 · tool calls 8 (errors 1) · shell 4 · 77s · in 406350 (cached 355328) out 2946 (reasoning 1091)
  tools: artifact_import_file×1, cad_validate_source×1, cad_probe×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1

## spacer-ring r3 (basic) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-10, -10, 0) max (10, 10, 12) — expected min (-10, -10, 0) max (10, 10, 12) ±0.15
- ✓ volume: 3103.652 mm³ — expected 3104.899 ±1.5% (off by 0.04%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (7, 0, 6): material present
- ✓ solid at (0, -7, 6): material present
- ✓ empty at (0, 0, 6): empty
- ✓ empty at (0, 0, -1): empty
- ✓ section z=6: hole count: 1 hole loop(s) — expected 1
- ✓ section z=6: hole d8.4 at (x=0, y=0): found d=8.4 at (0, 0) roundness 1
- ✓ section z=6: outer circle d20: found d=20 at (0, 0) roundness 1

  turns 1 · tool calls 9 (errors 2) · shell 3 · 87s · in 399590 (cached 366592) out 3058 (reasoning 1227)
  tools: artifact_import_file×2, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_history×1, artifact_read×1

## l-bracket-parametric r1 (parametric) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (60, 40, 45) — expected min (0, 0, 0) max (60, 40, 45) ±0.1
- ✓ volume: 23717.711 mm³ — expected 23717.257 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (30, 37.5, 25): material present
- ✓ empty at (30, 20, 25): empty
- ✓ empty at (15, 17.5, 2.5): empty
- ✓ section z=2.5: hole count: 2 hole loop(s) — expected 2
- ✓ section z=2.5: hole d6 at (x=15, y=17.5): found d=6 at (15, 17.5) roundness 0.999
- ✓ section z=2.5: hole d6 at (x=45, y=17.5): found d=6 at (45, 17.5) roundness 0.999
- ✓ section z=2.5: outer rectangle 60×40: found 60×40 centered (30, 20)
- ✓ section z=25: hole count: 0 hole loop(s) — expected 0
- ✓ section z=25: body count: 1 outer loop(s) — expected 1
- ✓ section z=25: outer rectangle 60×5: found 60×5 centered (30, 37.5)
- ✓ variant {"base_length":80,"height":60}: bounding box: min (0, 0, 0) max (80, 40, 60) — expected min (0, 0, 0) max (80, 40, 60) ±0.1
- ✓ variant {"base_length":80,"height":60}: volume: 37717.711 mm³ — expected 37717.257 ±1.5% (off by 0.00%)
- ✓ variant {"base_length":80,"height":60}: watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ variant {"base_length":80,"height":60}: section z=2.5: hole count: 2 hole loop(s) — expected 2

  note: 2 mechanical artifact(s) present, expected 1

  turns 1 · tool calls 15 (errors 3) · shell 11 · 288s · in 872229 (cached 817152) out 8812 (reasoning 3292)
  tools: cad_probe×1, project_summary×1, artifact_list×1, artifact_create_draft×2, cad_validate_source×1, cad_render×2, job_read×2, cad_inspect×2, artifact_read×1, artifact_update_draft×2

## l-bracket-parametric r2 (parametric) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (60, 40, 45) — expected min (0, 0, 0) max (60, 40, 45) ±0.1
- ✓ volume: 23717.711 mm³ — expected 23717.257 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (30, 37.5, 25): material present
- ✓ empty at (30, 20, 25): empty
- ✓ empty at (15, 17.5, 2.5): empty
- ✓ section z=2.5: hole count: 2 hole loop(s) — expected 2
- ✓ section z=2.5: hole d6 at (x=15, y=17.5): found d=6 at (15, 17.5) roundness 0.999
- ✓ section z=2.5: hole d6 at (x=45, y=17.5): found d=6 at (45, 17.5) roundness 0.999
- ✓ section z=2.5: outer rectangle 60×40: found 60×40 centered (30, 20)
- ✓ section z=25: hole count: 0 hole loop(s) — expected 0
- ✓ section z=25: body count: 1 outer loop(s) — expected 1
- ✓ section z=25: outer rectangle 60×5: found 60×5 centered (30, 37.5)
- ✓ variant {"base_length":80,"height":60}: bounding box: min (0, 0, 0) max (80, 40, 60) — expected min (0, 0, 0) max (80, 40, 60) ±0.1
- ✓ variant {"base_length":80,"height":60}: volume: 37717.711 mm³ — expected 37717.257 ±1.5% (off by 0.00%)
- ✓ variant {"base_length":80,"height":60}: watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ variant {"base_length":80,"height":60}: section z=2.5: hole count: 2 hole loop(s) — expected 2

  turns 1 · tool calls 13 (errors 1) · shell 2 · 115s · in 489825 (cached 408064) out 4526 (reasoning 1606)
  tools: artifact_list×1, project_summary×1, cad_probe×1, artifact_create_draft×1, cad_validate_source×1, cad_render×2, job_read×2, cad_inspect×2, artifact_read×1, artifact_read_file×1

## l-bracket-parametric r3 (parametric) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (60, 40, 45) — expected min (0, 0, 0) max (60, 40, 45) ±0.1
- ✓ volume: 23717.711 mm³ — expected 23717.257 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (30, 37.5, 25): material present
- ✓ empty at (30, 20, 25): empty
- ✓ empty at (15, 17.5, 2.5): empty
- ✓ section z=2.5: hole count: 2 hole loop(s) — expected 2
- ✓ section z=2.5: hole d6 at (x=15, y=17.5): found d=6 at (15, 17.5) roundness 0.999
- ✓ section z=2.5: hole d6 at (x=45, y=17.5): found d=6 at (45, 17.5) roundness 0.999
- ✓ section z=2.5: outer rectangle 60×40: found 60×40 centered (30, 20)
- ✓ section z=25: hole count: 0 hole loop(s) — expected 0
- ✓ section z=25: body count: 1 outer loop(s) — expected 1
- ✓ section z=25: outer rectangle 60×5: found 60×5 centered (30, 37.5)
- ✓ variant {"base_length":80,"height":60}: bounding box: min (0, 0, 0) max (80, 40, 60) — expected min (0, 0, 0) max (80, 40, 60) ±0.1
- ✓ variant {"base_length":80,"height":60}: volume: 37717.711 mm³ — expected 37717.257 ±1.5% (off by 0.00%)
- ✓ variant {"base_length":80,"height":60}: watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ variant {"base_length":80,"height":60}: section z=2.5: hole count: 2 hole loop(s) — expected 2

  note: 2 mechanical artifact(s) present, expected 1

  turns 1 · tool calls 11 (errors 2) · shell 3 · 114s · in 376937 (cached 346880) out 4748 (reasoning 1919)
  tools: artifact_create_draft×2, tool_doctor×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_history×1, artifact_read_file×1, artifact_read×1

## flanged-hub r1 (feature-composition) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-25, -25, 0) max (25, 25, 22) — expected min (-25, -25, 0) max (25, 25, 22) ±0.3
- ✓ volume: 16813.333 mm³ — expected 16820.087 ±1.5% (off by 0.04%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (8, 0, 14): material present
- ✓ solid at (22, 5, 3): material present
- ✓ empty at (19, 0, 3): empty
- ✓ empty at (0, 0, 10): empty
- ✓ empty at (20, 0, 14): empty
- ✓ section z=3: hole count: 5 hole loop(s) — expected 5
- ✓ section z=3: hole d10 at (x=0, y=0): found d=10 at (0, 0) roundness 1
- ✓ section z=3: hole d5 at (x=19, y=0): found d=5 at (19, 0) roundness 1
- ✓ section z=3: hole d5 at (x=0, y=19): found d=5 at (0, 19) roundness 1
- ✓ section z=3: hole d5 at (x=-19, y=0): found d=5 at (-19, 0) roundness 1
- ✓ section z=3: hole d5 at (x=0, y=-19): found d=5 at (0, -19) roundness 1
- ✓ section z=3: outer circle d50: found d=50 at (0, 0) roundness 1
- ✓ section z=14: hole count: 1 hole loop(s) — expected 1
- ✓ section z=14: hole d10 at (x=0, y=0): found d=10 at (0, 0) roundness 1
- ✓ section z=14: outer circle d24: found d=24 at (0, 0) roundness 1

  turns 1 · tool calls 8 (errors 1) · shell 1 · 90s · in 342631 (cached 310784) out 3010 (reasoning 1308)
  tools: cad_probe×1, artifact_import_file×2, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×1, artifact_read×1

## flanged-hub r2 (feature-composition) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-25, -25, 0) max (25, 25, 22) — expected min (-25, -25, 0) max (25, 25, 22) ±0.3
- ✓ volume: 16813.333 mm³ — expected 16820.087 ±1.5% (off by 0.04%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (8, 0, 14): material present
- ✓ solid at (22, 5, 3): material present
- ✓ empty at (19, 0, 3): empty
- ✓ empty at (0, 0, 10): empty
- ✓ empty at (20, 0, 14): empty
- ✓ section z=3: hole count: 5 hole loop(s) — expected 5
- ✓ section z=3: hole d10 at (x=0, y=0): found d=10 at (0, 0) roundness 1
- ✓ section z=3: hole d5 at (x=19, y=0): found d=5 at (19, 0) roundness 1
- ✓ section z=3: hole d5 at (x=0, y=19): found d=5 at (0, 19) roundness 1
- ✓ section z=3: hole d5 at (x=-19, y=0): found d=5 at (-19, 0) roundness 1
- ✓ section z=3: hole d5 at (x=0, y=-19): found d=5 at (0, -19) roundness 1
- ✓ section z=3: outer circle d50: found d=50 at (0, 0) roundness 1
- ✓ section z=14: hole count: 1 hole loop(s) — expected 1
- ✓ section z=14: hole d10 at (x=0, y=0): found d=10 at (0, 0) roundness 1
- ✓ section z=14: outer circle d24: found d=24 at (0, 0) roundness 1

  turns 1 · tool calls 10 (errors 1) · shell 3 · 75s · in 378514 (cached 345344) out 2929 (reasoning 1114)
  tools: project_summary×1, artifact_list×1, cad_probe×1, artifact_import_file×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1

## flanged-hub r3 (feature-composition) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-25, -25, 0) max (25, 25, 22) — expected min (-25, -25, 0) max (25, 25, 22) ±0.3
- ✓ volume: 16813.333 mm³ — expected 16820.087 ±1.5% (off by 0.04%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (8, 0, 14): material present
- ✓ solid at (22, 5, 3): material present
- ✓ empty at (19, 0, 3): empty
- ✓ empty at (0, 0, 10): empty
- ✓ empty at (20, 0, 14): empty
- ✓ section z=3: hole count: 5 hole loop(s) — expected 5
- ✓ section z=3: hole d10 at (x=0, y=0): found d=10 at (0, 0) roundness 1
- ✓ section z=3: hole d5 at (x=19, y=0): found d=5 at (19, 0) roundness 1
- ✓ section z=3: hole d5 at (x=0, y=19): found d=5 at (0, 19) roundness 1
- ✓ section z=3: hole d5 at (x=-19, y=0): found d=5 at (-19, 0) roundness 1
- ✓ section z=3: hole d5 at (x=0, y=-19): found d=5 at (0, -19) roundness 1
- ✓ section z=3: outer circle d50: found d=50 at (0, 0) roundness 1
- ✓ section z=14: hole count: 1 hole loop(s) — expected 1
- ✓ section z=14: hole d10 at (x=0, y=0): found d=10 at (0, 0) roundness 1
- ✓ section z=14: outer circle d24: found d=24 at (0, 0) roundness 1

  turns 1 · tool calls 10 (errors 1) · shell 5 · 98s · in 442815 (cached 410368) out 3449 (reasoning 1238)
  tools: artifact_list×1, cad_probe×1, project_summary×1, artifact_import_file×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1

## standoff-plate r1 (spatial) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-40, -25, 0) max (40, 25, 14) — expected min (-40, -25, 0) max (40, 25, 14) ±0.15
- ✓ volume: 16973.198 mm³ — expected 16973.894 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (30, 17, 5): material present
- ✓ solid at (32.2, 17, 10): material present
- ✓ empty at (30, 17, 10): empty
- ✓ empty at (0, 0, 8): empty
- ✓ section z=10: hole count: 4 hole loop(s) — expected 4
- ✓ section z=10: body count: 4 outer loop(s) — expected 4
- ✓ section z=10: hole d2.5 at (x=30, y=17): found d=2.5 at (30, 17) roundness 0.999
- ✓ section z=10: hole d2.5 at (x=-30, y=17): found d=2.5 at (-30, 17) roundness 0.999
- ✓ section z=10: hole d2.5 at (x=30, y=-17): found d=2.5 at (30, -17) roundness 0.999
- ✓ section z=10: hole d2.5 at (x=-30, y=-17): found d=2.5 at (-30, -17) roundness 0.999
- ✓ section z=2: hole count: 0 hole loop(s) — expected 0
- ✓ section z=2: body count: 1 outer loop(s) — expected 1
- ✓ section z=2: outer rectangle 80×50: found 80×50 centered (0, 0)

  turns 1 · tool calls 17 (errors 1) · shell 6 · 215s · in 762141 (cached 712448) out 7605 (reasoning 2725)
  tools: cad_probe×1, project_summary×1, artifact_create_draft×1, cad_validate_source×2, cad_render×2, job_read×2, artifact_update_draft×1, cad_inspect×2, artifact_read×1, build_export×1, build_preview×1, proposal_submit×1, proposal_wait×1

## standoff-plate r2 (spatial) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-40, -25, 0) max (40, 25, 14) — expected min (-40, -25, 0) max (40, 25, 14) ±0.15
- ✓ volume: 16973.198 mm³ — expected 16973.894 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (30, 17, 5): material present
- ✓ solid at (32.2, 17, 10): material present
- ✓ empty at (30, 17, 10): empty
- ✓ empty at (0, 0, 8): empty
- ✓ section z=10: hole count: 4 hole loop(s) — expected 4
- ✓ section z=10: body count: 4 outer loop(s) — expected 4
- ✓ section z=10: hole d2.5 at (x=30, y=17): found d=2.5 at (30, 17) roundness 0.999
- ✓ section z=10: hole d2.5 at (x=-30, y=17): found d=2.5 at (-30, 17) roundness 0.999
- ✓ section z=10: hole d2.5 at (x=30, y=-17): found d=2.5 at (30, -17) roundness 0.999
- ✓ section z=10: hole d2.5 at (x=-30, y=-17): found d=2.5 at (-30, -17) roundness 0.999
- ✓ section z=2: hole count: 0 hole loop(s) — expected 0
- ✓ section z=2: body count: 1 outer loop(s) — expected 1
- ✓ section z=2: outer rectangle 80×50: found 80×50 centered (0, 0)

  turns 1 · tool calls 11 (errors 1) · shell 5 · 99s · in 442602 (cached 408320) out 3886 (reasoning 1406)
  tools: cad_probe×1, project_summary×2, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1, artifact_list×1

## standoff-plate r3 (spatial) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-40, -25, 0) max (40, 25, 14) — expected min (-40, -25, 0) max (40, 25, 14) ±0.15
- ✓ volume: 16973.198 mm³ — expected 16973.894 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (30, 17, 5): material present
- ✓ solid at (32.2, 17, 10): material present
- ✓ empty at (30, 17, 10): empty
- ✓ empty at (0, 0, 8): empty
- ✓ section z=10: hole count: 4 hole loop(s) — expected 4
- ✓ section z=10: body count: 4 outer loop(s) — expected 4
- ✓ section z=10: hole d2.5 at (x=30, y=17): found d=2.5 at (30, 17) roundness 0.999
- ✓ section z=10: hole d2.5 at (x=-30, y=17): found d=2.5 at (-30, 17) roundness 0.999
- ✓ section z=10: hole d2.5 at (x=30, y=-17): found d=2.5 at (30, -17) roundness 0.999
- ✓ section z=10: hole d2.5 at (x=-30, y=-17): found d=2.5 at (-30, -17) roundness 0.999
- ✓ section z=2: hole count: 0 hole loop(s) — expected 0
- ✓ section z=2: body count: 1 outer loop(s) — expected 1
- ✓ section z=2: outer rectangle 80×50: found 80×50 centered (0, 0)

  turns 1 · tool calls 9 (errors 1) · shell 4 · 89s · in 385326 (cached 354560) out 3401 (reasoning 1016)
  tools: artifact_import_file×1, cad_validate_source×1, cad_probe×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1, artifact_history×1

## slotted-link r1 (engineering-constraints) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-45, -10, 0) max (45, 10, 6) — expected min (-45, -10, 0) max (45, 10, 6) ±0.15
- ✓ volume: 8965.885 mm³ — expected 8967.146 ±1.5% (off by 0.01%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (-40, 0, 3): material present
- ✓ solid at (0, 7, 3): material present
- ✓ empty at (0, 0, 3): empty
- ✓ empty at (20, 0, 3): empty
- ✓ empty at (-22, 0, 3): empty
- ✓ empty at (-44, 9, 3): empty
- ✓ section z=3: hole count: 1 hole loop(s) — expected 1
- ✓ section z=3: body count: 1 outer loop(s) — expected 1
- ✓ section z=3: slot 45×5 at (x=0, y=0): found cut-out bbox 45×5

  turns 1 · tool calls 8 (errors 1) · shell 4 · 81s · in 299836 (cached 259584) out 3401 (reasoning 1475)
  tools: cad_probe×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1

## slotted-link r2 (engineering-constraints) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-45, -10, 0) max (45, 10, 6) — expected min (-45, -10, 0) max (45, 10, 6) ±0.15
- ✓ volume: 8965.885 mm³ — expected 8967.146 ±1.5% (off by 0.01%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (-40, 0, 3): material present
- ✓ solid at (0, 7, 3): material present
- ✓ empty at (0, 0, 3): empty
- ✓ empty at (20, 0, 3): empty
- ✓ empty at (-22, 0, 3): empty
- ✓ empty at (-44, 9, 3): empty
- ✓ section z=3: hole count: 1 hole loop(s) — expected 1
- ✓ section z=3: body count: 1 outer loop(s) — expected 1
- ✓ section z=3: slot 45×5 at (x=0, y=0): found cut-out bbox 45×5

  turns 1 · tool calls 10 (errors 1) · shell 6 · 120s · in 517519 (cached 459008) out 4699 (reasoning 1292)
  tools: cad_probe×1, artifact_list×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1, artifact_history×1

## slotted-link r3 (engineering-constraints) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-45, -10, 0) max (45, 10, 6) — expected min (-45, -10, 0) max (45, 10, 6) ±0.15
- ✓ volume: 8966.436 mm³ — expected 8967.146 ±1.5% (off by 0.01%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (-40, 0, 3): material present
- ✓ solid at (0, 7, 3): material present
- ✓ empty at (0, 0, 3): empty
- ✓ empty at (20, 0, 3): empty
- ✓ empty at (-22, 0, 3): empty
- ✓ empty at (-44, 9, 3): empty
- ✓ section z=3: hole count: 1 hole loop(s) — expected 1
- ✓ section z=3: body count: 1 outer loop(s) — expected 1
- ✓ section z=3: slot 45×5 at (x=0, y=0): found cut-out bbox 45×5

  turns 1 · tool calls 11 (errors 1) · shell 2 · 112s · in 424761 (cached 375808) out 4685 (reasoning 1412)
  tools: project_summary×1, artifact_list×1, cad_probe×1, artifact_create_draft×1, artifact_read_file×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1

## sensor-plate-modify r1 (modification) — PASS
- ✓ new revision on the same artifact: 3 revision(s) on "Sensor mount plate"
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (60, 40, 10) — expected min (0, 0, 0) max (60, 40, 10) ±0.1
- ✓ volume: 9889.475 mm³ — expected 9889.655 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ section z=2: hole count: 5 hole loop(s) — expected 5
- ✓ section z=2: hole d3.4 at (x=5, y=5): found d=3.4 at (5, 5) roundness 0.995
- ✓ section z=2: hole d3.4 at (x=55, y=5): found d=3.4 at (55, 5) roundness 0.995
- ✓ section z=2: hole d3.4 at (x=5, y=35): found d=3.4 at (5, 35) roundness 0.995
- ✓ section z=2: hole d3.4 at (x=55, y=35): found d=3.4 at (55, 35) roundness 0.995
- ✓ section z=2: hole d3.4 at (x=30, y=20): found d=3.4 at (30, 20) roundness 0.995
- ✓ section z=2: outer rectangle 60×40: found 60×40 centered (30, 20)
- ✓ section z=7: hole count: 0 hole loop(s) — expected 0
- ✓ section z=7: body count: 1 outer loop(s) — expected 1
- ✓ section z=7: outer circle d10: found d=10 at (45, 20) roundness 0.998
- ✓ unrelated geometry preserved: 392 sample points outside change regions, 0 differ

  turns 1 · tool calls 17 (errors 1) · shell 0 · 199s · in 692156 (cached 620288) out 5557 (reasoning 1844)
  tools: project_search×1, artifact_list×1, artifact_read×2, artifact_read_file×1, artifact_update_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_history×1, proposal_list×1, proposal_submit×1, proposal_wait×1, ui_request_review×1, artifact_compare×1

## sensor-plate-modify r2 (modification) — PASS
- ✓ new revision on the same artifact: 4 revision(s) on "Sensor mount plate"
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (60, 40, 10) — expected min (0, 0, 0) max (60, 40, 10) ±0.1
- ✓ volume: 9889.475 mm³ — expected 9889.655 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ section z=2: hole count: 5 hole loop(s) — expected 5
- ✓ section z=2: hole d3.4 at (x=5, y=5): found d=3.4 at (5, 5) roundness 0.995
- ✓ section z=2: hole d3.4 at (x=55, y=5): found d=3.4 at (55, 5) roundness 0.995
- ✓ section z=2: hole d3.4 at (x=5, y=35): found d=3.4 at (5, 35) roundness 0.995
- ✓ section z=2: hole d3.4 at (x=55, y=35): found d=3.4 at (55, 35) roundness 0.995
- ✓ section z=2: hole d3.4 at (x=30, y=20): found d=3.4 at (30, 20) roundness 0.995
- ✓ section z=2: outer rectangle 60×40: found 60×40 centered (30, 20)
- ✓ section z=7: hole count: 0 hole loop(s) — expected 0
- ✓ section z=7: body count: 1 outer loop(s) — expected 1
- ✓ section z=7: outer circle d10: found d=10 at (45, 20) roundness 0.998
- ✓ unrelated geometry preserved: 392 sample points outside change regions, 0 differ

  turns 1 · tool calls 16 (errors 2) · shell 5 · 172s · in 644249 (cached 596736) out 5462 (reasoning 2139)
  tools: artifact_list×2, artifact_read×2, artifact_read_file×1, artifact_update_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_history×1, proposal_submit×1, proposal_wait×1, ui_request_review×1, proposal_read×1

## sensor-plate-modify r3 (modification) — PASS
- ✓ new revision on the same artifact: 4 revision(s) on "Sensor mount plate"
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (60, 40, 10) — expected min (0, 0, 0) max (60, 40, 10) ±0.1
- ✓ volume: 9889.475 mm³ — expected 9889.655 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ section z=2: hole count: 5 hole loop(s) — expected 5
- ✓ section z=2: hole d3.4 at (x=5, y=5): found d=3.4 at (5, 5) roundness 0.995
- ✓ section z=2: hole d3.4 at (x=55, y=5): found d=3.4 at (55, 5) roundness 0.995
- ✓ section z=2: hole d3.4 at (x=5, y=35): found d=3.4 at (5, 35) roundness 0.995
- ✓ section z=2: hole d3.4 at (x=55, y=35): found d=3.4 at (55, 35) roundness 0.995
- ✓ section z=2: hole d3.4 at (x=30, y=20): found d=3.4 at (30, 20) roundness 0.995
- ✓ section z=2: outer rectangle 60×40: found 60×40 centered (30, 20)
- ✓ section z=7: hole count: 0 hole loop(s) — expected 0
- ✓ section z=7: body count: 1 outer loop(s) — expected 1
- ✓ section z=7: outer circle d10: found d=10 at (45, 20) roundness 0.998
- ✓ unrelated geometry preserved: 392 sample points outside change regions, 0 differ

  turns 1 · tool calls 17 (errors 1) · shell 5 · 186s · in 674304 (cached 603648) out 7290 (reasoning 3806)
  tools: project_summary×1, artifact_list×2, artifact_read×2, artifact_read_file×1, artifact_update_draft×1, cad_render×1, cad_validate_source×1, job_read×1, cad_inspect×2, proposal_submit×1, proposal_wait×1, ui_request_review×1, proposal_read×1, artifact_compare×1

## nema17-motor-mount r1 (complete-object) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-30, -30, 0) max (30, 30, 30) — expected min (-30, -30, 0) max (30, 30, 30) ±0.1
- ✓ volume: 30514.066 mm³ — expected 30512.291 ±1.5% (off by 0.01%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (20, 27.5, 12): material present
- ✓ solid at (0, 27.5, 20): material present
- ✓ solid at (25, 0, 2.5): material present
- ✓ empty at (20, 27.5, 20): empty
- ✓ empty at (-20, -27.5, 20): empty
- ✓ empty at (0, 0, 2.5): empty
- ✓ empty at (0, 0, 15): empty
- ✓ section z=2.5: hole count: 5 hole loop(s) — expected 5
- ✓ section z=2.5: hole d22.5 at (x=0, y=0): found d=22.5 at (0, 0) roundness 0.999
- ✓ section z=2.5: hole d3.4 at (x=15.5, y=15.5): found d=3.4 at (15.5, 15.5) roundness 0.999
- ✓ section z=2.5: hole d3.4 at (x=-15.5, y=15.5): found d=3.4 at (-15.5, 15.5) roundness 0.999
- ✓ section z=2.5: hole d3.4 at (x=15.5, y=-15.5): found d=3.4 at (15.5, -15.5) roundness 0.999
- ✓ section z=2.5: hole d3.4 at (x=-15.5, y=-15.5): found d=3.4 at (-15.5, -15.5) roundness 0.999
- ✓ section z=2.5: outer rectangle 60×60: found 60×60 centered (0, 0)
- ✓ section y=27.5: hole count: 2 hole loop(s) — expected 2
- ✓ section y=27.5: hole d4.5 at (x=20, z=20): found d=4.5 at (20, 20) roundness 0.999
- ✓ section y=27.5: hole d4.5 at (x=-20, z=20): found d=4.5 at (-20, 20) roundness 0.999
- ✓ section y=27.5: outer rectangle 60×30: found 60×30 centered (0, 15)
- ✓ section y=-27.5: hole count: 2 hole loop(s) — expected 2
- ✓ section y=-27.5: hole d4.5 at (x=20, z=20): found d=4.5 at (20, 20) roundness 0.999
- ✓ section y=-27.5: hole d4.5 at (x=-20, z=20): found d=4.5 at (-20, 20) roundness 0.999
- ✓ section z=15: hole count: 0 hole loop(s) — expected 0
- ✓ section z=15: body count: 2 outer loop(s) — expected 2

  turns 1 · tool calls 14 (errors 1) · shell 4 · 139s · in 645470 (cached 604416) out 5238 (reasoning 2021)
  tools: cad_probe×1, artifact_import_file×1, cad_validate_source×2, cad_render×2, job_read×2, cad_inspect×3, artifact_read×2, artifact_update_draft×1

## nema17-motor-mount r2 (complete-object) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-30, -30, 0) max (30, 30, 30) — expected min (-30, -30, 0) max (30, 30, 30) ±0.1
- ✓ volume: 30514.066 mm³ — expected 30512.291 ±1.5% (off by 0.01%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (20, 27.5, 12): material present
- ✓ solid at (0, 27.5, 20): material present
- ✓ solid at (25, 0, 2.5): material present
- ✓ empty at (20, 27.5, 20): empty
- ✓ empty at (-20, -27.5, 20): empty
- ✓ empty at (0, 0, 2.5): empty
- ✓ empty at (0, 0, 15): empty
- ✓ section z=2.5: hole count: 5 hole loop(s) — expected 5
- ✓ section z=2.5: hole d22.5 at (x=0, y=0): found d=22.5 at (0, 0) roundness 0.999
- ✓ section z=2.5: hole d3.4 at (x=15.5, y=15.5): found d=3.4 at (15.5, 15.5) roundness 0.999
- ✓ section z=2.5: hole d3.4 at (x=-15.5, y=15.5): found d=3.4 at (-15.5, 15.5) roundness 0.999
- ✓ section z=2.5: hole d3.4 at (x=15.5, y=-15.5): found d=3.4 at (15.5, -15.5) roundness 0.999
- ✓ section z=2.5: hole d3.4 at (x=-15.5, y=-15.5): found d=3.4 at (-15.5, -15.5) roundness 0.999
- ✓ section z=2.5: outer rectangle 60×60: found 60×60 centered (0, 0)
- ✓ section y=27.5: hole count: 2 hole loop(s) — expected 2
- ✓ section y=27.5: hole d4.5 at (x=20, z=20): found d=4.5 at (20, 20) roundness 0.999
- ✓ section y=27.5: hole d4.5 at (x=-20, z=20): found d=4.5 at (-20, 20) roundness 0.999
- ✓ section y=27.5: outer rectangle 60×30: found 60×30 centered (0, 15)
- ✓ section y=-27.5: hole count: 2 hole loop(s) — expected 2
- ✓ section y=-27.5: hole d4.5 at (x=20, z=20): found d=4.5 at (20, 20) roundness 0.999
- ✓ section y=-27.5: hole d4.5 at (x=-20, z=20): found d=4.5 at (-20, 20) roundness 0.999
- ✓ section z=15: hole count: 0 hole loop(s) — expected 0
- ✓ section z=15: body count: 2 outer loop(s) — expected 2

  turns 1 · tool calls 11 (errors 1) · shell 6 · 95s · in 527144 (cached 476416) out 4021 (reasoning 1335)
  tools: artifact_list×1, project_summary×1, cad_probe×1, artifact_import_file×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_history×1, artifact_read×1

## nema17-motor-mount r3 (complete-object) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-30, -30, 0) max (30, 30, 30) — expected min (-30, -30, 0) max (30, 30, 30) ±0.1
- ✓ volume: 30514.066 mm³ — expected 30512.291 ±1.5% (off by 0.01%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (20, 27.5, 12): material present
- ✓ solid at (0, 27.5, 20): material present
- ✓ solid at (25, 0, 2.5): material present
- ✓ empty at (20, 27.5, 20): empty
- ✓ empty at (-20, -27.5, 20): empty
- ✓ empty at (0, 0, 2.5): empty
- ✓ empty at (0, 0, 15): empty
- ✓ section z=2.5: hole count: 5 hole loop(s) — expected 5
- ✓ section z=2.5: hole d22.5 at (x=0, y=0): found d=22.5 at (0, 0) roundness 0.999
- ✓ section z=2.5: hole d3.4 at (x=15.5, y=15.5): found d=3.4 at (15.5, 15.5) roundness 0.999
- ✓ section z=2.5: hole d3.4 at (x=-15.5, y=15.5): found d=3.4 at (-15.5, 15.5) roundness 0.999
- ✓ section z=2.5: hole d3.4 at (x=15.5, y=-15.5): found d=3.4 at (15.5, -15.5) roundness 0.999
- ✓ section z=2.5: hole d3.4 at (x=-15.5, y=-15.5): found d=3.4 at (-15.5, -15.5) roundness 0.999
- ✓ section z=2.5: outer rectangle 60×60: found 60×60 centered (0, 0)
- ✓ section y=27.5: hole count: 2 hole loop(s) — expected 2
- ✓ section y=27.5: hole d4.5 at (x=20, z=20): found d=4.5 at (20, 20) roundness 0.999
- ✓ section y=27.5: hole d4.5 at (x=-20, z=20): found d=4.5 at (-20, 20) roundness 0.999
- ✓ section y=27.5: outer rectangle 60×30: found 60×30 centered (0, 15)
- ✓ section y=-27.5: hole count: 2 hole loop(s) — expected 2
- ✓ section y=-27.5: hole d4.5 at (x=20, z=20): found d=4.5 at (20, 20) roundness 0.999
- ✓ section y=-27.5: hole d4.5 at (x=-20, z=20): found d=4.5 at (-20, 20) roundness 0.999
- ✓ section z=15: hole count: 0 hole loop(s) — expected 0
- ✓ section z=15: body count: 2 outer loop(s) — expected 2

  turns 1 · tool calls 11 (errors 1) · shell 4 · 111s · in 433953 (cached 400128) out 4828 (reasoning 1760)
  tools: cad_probe×1, artifact_list×1, project_summary×1, artifact_import_file×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_history×1, artifact_read×1

## stepped-shaft r1 (spatial) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, -6, -6) max (50, 6, 6) — expected min (0, -6, -6) max (50, 6, 6) ±0.15
- ✓ volume: 4383.579 mm³ — expected 4386.711 ±1.5% (off by 0.07%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (15, 0, 0): material present
- ✓ solid at (40, 3.5, 0): material present
- ✓ empty at (40, 4.5, 0): empty
- ✓ empty at (49.8, 3.5, 0): empty
- ✓ empty at (-0.5, 0, 0): empty
- ✓ section x=15: hole count: 0 hole loop(s) — expected 0
- ✓ section x=15: body count: 1 outer loop(s) — expected 1
- ✓ section x=15: outer circle d12: found d=12 at (0, 0) roundness 0.999
- ✓ section x=40: hole count: 0 hole loop(s) — expected 0
- ✓ section x=40: body count: 1 outer loop(s) — expected 1
- ✓ section x=40: outer circle d8: found d=8 at (0, 0) roundness 0.999
- ✓ section x=49.5: hole count: 0 hole loop(s) — expected 0
- ✓ section x=49.5: body count: 1 outer loop(s) — expected 1
- ✓ section x=49.5: outer circle d7: found d=7 at (0, 0) roundness 0.999

  turns 1 · tool calls 16 (errors 1) · shell 9 · 209s · in 808466 (cached 753920) out 9762 (reasoning 2952)
  tools: cad_probe×1, artifact_create_draft×1, cad_validate_source×2, cad_render×2, job_read×2, artifact_read_file×1, artifact_update_draft×3, cad_inspect×2, artifact_read×1, artifact_history×1

## stepped-shaft r2 (spatial) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, -6, -6) max (50, 6, 6) — expected min (0, -6, -6) max (50, 6, 6) ±0.15
- ✓ volume: 4383.579 mm³ — expected 4386.711 ±1.5% (off by 0.07%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (15, 0, 0): material present
- ✓ solid at (40, 3.5, 0): material present
- ✓ empty at (40, 4.5, 0): empty
- ✓ empty at (49.8, 3.5, 0): empty
- ✓ empty at (-0.5, 0, 0): empty
- ✓ section x=15: hole count: 0 hole loop(s) — expected 0
- ✓ section x=15: body count: 1 outer loop(s) — expected 1
- ✓ section x=15: outer circle d12: found d=12 at (0, 0) roundness 0.999
- ✓ section x=40: hole count: 0 hole loop(s) — expected 0
- ✓ section x=40: body count: 1 outer loop(s) — expected 1
- ✓ section x=40: outer circle d8: found d=8 at (0, 0) roundness 0.999
- ✓ section x=49.5: hole count: 0 hole loop(s) — expected 0
- ✓ section x=49.5: body count: 1 outer loop(s) — expected 1
- ✓ section x=49.5: outer circle d7: found d=7 at (0, 0) roundness 0.999

  turns 1 · tool calls 10 (errors 2) · shell 6 · 116s · in 530807 (cached 495616) out 3930 (reasoning 1256)
  tools: cad_probe×1, project_summary×1, artifact_import_file×2, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1

## stepped-shaft r3 (spatial) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, -6, -6) max (50, 6, 6) — expected min (0, -6, -6) max (50, 6, 6) ±0.15
- ✓ volume: 4384.949 mm³ — expected 4386.711 ±1.5% (off by 0.04%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (15, 0, 0): material present
- ✓ solid at (40, 3.5, 0): material present
- ✓ empty at (40, 4.5, 0): empty
- ✓ empty at (49.8, 3.5, 0): empty
- ✓ empty at (-0.5, 0, 0): empty
- ✓ section x=15: hole count: 0 hole loop(s) — expected 0
- ✓ section x=15: body count: 1 outer loop(s) — expected 1
- ✓ section x=15: outer circle d12: found d=12 at (0, 0) roundness 1
- ✓ section x=40: hole count: 0 hole loop(s) — expected 0
- ✓ section x=40: body count: 1 outer loop(s) — expected 1
- ✓ section x=40: outer circle d8: found d=8 at (0, 0) roundness 1
- ✓ section x=49.5: hole count: 0 hole loop(s) — expected 0
- ✓ section x=49.5: body count: 1 outer loop(s) — expected 1
- ✓ section x=49.5: outer circle d7: found d=7 at (0, 0) roundness 1

  turns 1 · tool calls 8 (errors 1) · shell 7 · 125s · in 518731 (cached 461056) out 4851 (reasoning 1446)
  tools: cad_probe×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1

## open-box r1 (feature-composition) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (80, 60, 30) — expected min (0, 0, 0) max (80, 60, 30) ±0.1
- ✓ volume: 32028.645 mm³ — expected 32028.49 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (40, 30, 1.5): material present
- ✓ solid at (1.25, 30, 15): material present
- ✓ solid at (78.75, 10, 15): material present
- ✓ empty at (40, 30, 15): empty
- ✓ empty at (78.75, 30, 15): empty
- ✓ empty at (6, 6, 1.5): empty
- ✓ section z=1.5: hole count: 4 hole loop(s) — expected 4
- ✓ section z=1.5: hole d3.2 at (x=6, y=6): found d=3.2 at (6, 6) roundness 0.999
- ✓ section z=1.5: hole d3.2 at (x=74, y=6): found d=3.2 at (74, 6) roundness 0.999
- ✓ section z=1.5: hole d3.2 at (x=6, y=54): found d=3.2 at (6, 54) roundness 0.999
- ✓ section z=1.5: hole d3.2 at (x=74, y=54): found d=3.2 at (74, 54) roundness 0.999
- ✓ section z=1.5: outer rectangle 80×60: found 80×60 centered (40, 30)
- ✓ section z=25: hole count: 1 hole loop(s) — expected 1
- ✓ section z=25: slot 75×55 at (x=40, y=30): found cut-out bbox 75×55
- ✓ section z=25: outer rectangle 80×60: found 80×60 centered (40, 30)
- ✓ section x=78.75: hole count: 1 hole loop(s) — expected 1
- ✓ section x=78.75: slot 20×10 at (y=30, z=15): found cut-out bbox 20×10
- ✓ section x=78.75: outer rectangle 60×30: found 60×30 centered (30, 15)
- ✓ section x=1.25: hole count: 0 hole loop(s) — expected 0
- ✓ section x=1.25: outer rectangle 60×30: found 60×30 centered (30, 15)

  turns 1 · tool calls 24 (errors 1) · shell 4 · 154s · in 500667 (cached 437248) out 5708 (reasoning 2132)
  tools: artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×16, cad_inspect×2, artifact_read×2, artifact_read_file×1

## open-box r2 (feature-composition) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (80, 60, 30) — expected min (0, 0, 0) max (80, 60, 30) ±0.1
- ✓ volume: 32028.645 mm³ — expected 32028.49 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (40, 30, 1.5): material present
- ✓ solid at (1.25, 30, 15): material present
- ✓ solid at (78.75, 10, 15): material present
- ✓ empty at (40, 30, 15): empty
- ✓ empty at (78.75, 30, 15): empty
- ✓ empty at (6, 6, 1.5): empty
- ✓ section z=1.5: hole count: 4 hole loop(s) — expected 4
- ✓ section z=1.5: hole d3.2 at (x=6, y=6): found d=3.2 at (6, 6) roundness 0.999
- ✓ section z=1.5: hole d3.2 at (x=74, y=6): found d=3.2 at (74, 6) roundness 0.999
- ✓ section z=1.5: hole d3.2 at (x=6, y=54): found d=3.2 at (6, 54) roundness 0.999
- ✓ section z=1.5: hole d3.2 at (x=74, y=54): found d=3.2 at (74, 54) roundness 0.999
- ✓ section z=1.5: outer rectangle 80×60: found 80×60 centered (40, 30)
- ✓ section z=25: hole count: 1 hole loop(s) — expected 1
- ✓ section z=25: slot 75×55 at (x=40, y=30): found cut-out bbox 75×55
- ✓ section z=25: outer rectangle 80×60: found 80×60 centered (40, 30)
- ✓ section x=78.75: hole count: 1 hole loop(s) — expected 1
- ✓ section x=78.75: slot 20×10 at (y=30, z=15): found cut-out bbox 20×10
- ✓ section x=78.75: outer rectangle 60×30: found 60×30 centered (30, 15)
- ✓ section x=1.25: hole count: 0 hole loop(s) — expected 0
- ✓ section x=1.25: outer rectangle 60×30: found 60×30 centered (30, 15)

  turns 1 · tool calls 7 (errors 1) · shell 5 · 85s · in 289486 (cached 266752) out 3569 (reasoning 1422)
  tools: artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_history×1

## open-box r3 (feature-composition) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (80, 60, 30) — expected min (0, 0, 0) max (80, 60, 30) ±0.1
- ✓ volume: 32028.645 mm³ — expected 32028.49 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (40, 30, 1.5): material present
- ✓ solid at (1.25, 30, 15): material present
- ✓ solid at (78.75, 10, 15): material present
- ✓ empty at (40, 30, 15): empty
- ✓ empty at (78.75, 30, 15): empty
- ✓ empty at (6, 6, 1.5): empty
- ✓ section z=1.5: hole count: 4 hole loop(s) — expected 4
- ✓ section z=1.5: hole d3.2 at (x=6, y=6): found d=3.2 at (6, 6) roundness 0.999
- ✓ section z=1.5: hole d3.2 at (x=74, y=6): found d=3.2 at (74, 6) roundness 0.999
- ✓ section z=1.5: hole d3.2 at (x=6, y=54): found d=3.2 at (6, 54) roundness 0.999
- ✓ section z=1.5: hole d3.2 at (x=74, y=54): found d=3.2 at (74, 54) roundness 0.999
- ✓ section z=1.5: outer rectangle 80×60: found 80×60 centered (40, 30)
- ✓ section z=25: hole count: 1 hole loop(s) — expected 1
- ✓ section z=25: slot 75×55 at (x=40, y=30): found cut-out bbox 75×55
- ✓ section z=25: outer rectangle 80×60: found 80×60 centered (40, 30)
- ✓ section x=78.75: hole count: 1 hole loop(s) — expected 1
- ✓ section x=78.75: slot 20×10 at (y=30, z=15): found cut-out bbox 20×10
- ✓ section x=78.75: outer rectangle 60×30: found 60×30 centered (30, 15)
- ✓ section x=1.25: hole count: 0 hole loop(s) — expected 0
- ✓ section x=1.25: outer rectangle 60×30: found 60×30 centered (30, 15)

  turns 1 · tool calls 8 (errors 1) · shell 7 · 120s · in 525430 (cached 489728) out 5292 (reasoning 1754)
  tools: cad_probe×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1

## nut-trap-plate r1 (engineering-constraints) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (40, 40, 5) — expected min (0, 0, 0) max (40, 40, 5) ±0.1
- ✓ volume: 7754.556 mm³ — expected 7754.539 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (20, 24.7, 3): material present
- ✓ solid at (20, 23, 0.5): material present
- ✓ solid at (24.7, 20, 3): material present
- ✓ empty at (20, 20, 3): empty
- ✓ empty at (20, 20, 0.5): empty
- ✓ empty at (20, 23.5, 3): empty
- ✓ section z=3: hole count: 1 hole loop(s) — expected 1
- ✓ section z=3: 6-gon across-flats 8 at (x=20, y=20): found 6 sides, across-flats 8, across-corners 9.238 (expected 8 / 9.238)
- ✓ section z=3: outer rectangle 40×40: found 40×40 centered (20, 20)
- ✓ section z=0.5: hole count: 1 hole loop(s) — expected 1
- ✓ section z=0.5: hole d5.5 at (x=20, y=20): found d=5.5 at (20, 20) roundness 0.999

  turns 1 · tool calls 30 (errors 1) · shell 3 · 133s · in 412941 (cached 359424) out 4126 (reasoning 1581)
  tools: artifact_list×2, cad_probe×1, project_summary×1, artifact_import_file×1, cad_validate_source×1, cad_render×1, job_read×20, cad_inspect×2, artifact_read×1

## nut-trap-plate r2 (engineering-constraints) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (40, 40, 5) — expected min (0, 0, 0) max (40, 40, 5) ±0.1
- ✓ volume: 7754.577 mm³ — expected 7754.539 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (20, 24.7, 3): material present
- ✓ solid at (20, 23, 0.5): material present
- ✓ solid at (24.7, 20, 3): material present
- ✓ empty at (20, 20, 3): empty
- ✓ empty at (20, 20, 0.5): empty
- ✓ empty at (20, 23.5, 3): empty
- ✓ section z=3: hole count: 1 hole loop(s) — expected 1
- ✓ section z=3: 6-gon across-flats 8 at (x=20, y=20): found 6 sides, across-flats 8, across-corners 9.238 (expected 8 / 9.238)
- ✓ section z=3: outer rectangle 40×40: found 40×40 centered (20, 20)
- ✓ section z=0.5: hole count: 1 hole loop(s) — expected 1
- ✓ section z=0.5: hole d5.5 at (x=20, y=20): found d=5.5 at (20, 20) roundness 0.999

  turns 1 · tool calls 9 (errors 1) · shell 6 · 97s · in 488135 (cached 431616) out 3550 (reasoning 1184)
  tools: project_summary×1, artifact_list×1, artifact_import_file×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1

## nut-trap-plate r3 (engineering-constraints) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (40, 40, 5) — expected min (0, 0, 0) max (40, 40, 5) ±0.1
- ✓ volume: 7754.577 mm³ — expected 7754.539 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (20, 24.7, 3): material present
- ✓ solid at (20, 23, 0.5): material present
- ✓ solid at (24.7, 20, 3): material present
- ✓ empty at (20, 20, 3): empty
- ✓ empty at (20, 20, 0.5): empty
- ✓ empty at (20, 23.5, 3): empty
- ✓ section z=3: hole count: 1 hole loop(s) — expected 1
- ✓ section z=3: 6-gon across-flats 8 at (x=20, y=20): found 6 sides, across-flats 8, across-corners 9.238 (expected 8 / 9.238)
- ✓ section z=3: outer rectangle 40×40: found 40×40 centered (20, 20)
- ✓ section z=0.5: hole count: 1 hole loop(s) — expected 1
- ✓ section z=0.5: hole d5.5 at (x=20, y=20): found d=5.5 at (20, 20) roundness 0.999

  turns 1 · tool calls 39 (errors 1) · shell 4 · 135s · in 384812 (cached 334336) out 4234 (reasoning 1899)
  tools: artifact_import_file×1, cad_probe×1, cad_validate_source×1, cad_render×1, job_read×31, cad_inspect×2, artifact_history×1, artifact_read×1

## inclined-foot r1 (spatial) — FAIL
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (40, 30, 20) — expected min (0, 0, 0) max (40, 30, 20) ±0.1
- ✓ volume: 17571.253 mm³ — expected 17562.832 ±1.5% (off by 0.05%)
- ✗ watertight: boundary edges 0, non-manifold 0, inverted true
- ✓ single body: 1 shell(s) — expected 1
- ✗ solid at (21.552, 15, 6.366): EMPTY — expected material
- ✓ solid at (14.567, 15, 8.112): material present
- ✓ solid at (18.06, 18.6, 7.239): material present
- ✓ solid at (1, 15, 19.5): material present
- ✓ solid at (38, 5, 5): material present
- ✓ empty at (19.951, 15, 14.806): empty
- ✓ empty at (19.515, 15, 13.06): empty
- ✗ empty at (18.06, 15, 7.239): MATERIAL — expected empty
- ✗ empty at (16.847, 15, 2.388): MATERIAL — expected empty
- ✓ empty at (39, 15, 12): empty

  turns 1 · tool calls 11 (errors 1) · shell 3 · 97s · in 298634 (cached 271872) out 3912 (reasoning 1578)
  tools: project_summary×2, cad_probe×1, artifact_import_file×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_history×1, artifact_read×1

## inclined-foot r2 (spatial) — FAIL
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (40, 30, 20) — expected min (0, 0, 0) max (40, 30, 20) ±0.1
- ✓ volume: 17563.146 mm³ — expected 17562.832 ±1.5% (off by 0.00%)
- ✗ watertight: boundary edges 0, non-manifold 0, inverted true
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (21.552, 15, 6.366): material present
- ✓ solid at (14.567, 15, 8.112): material present
- ✓ solid at (18.06, 18.6, 7.239): material present
- ✓ solid at (1, 15, 19.5): material present
- ✓ solid at (38, 5, 5): material present
- ✓ empty at (19.951, 15, 14.806): empty
- ✓ empty at (19.515, 15, 13.06): empty
- ✓ empty at (18.06, 15, 7.239): empty
- ✓ empty at (16.847, 15, 2.388): empty
- ✓ empty at (39, 15, 12): empty

  turns 1 · tool calls 10 (errors 1) · shell 5 · 119s · in 492258 (cached 451584) out 4214 (reasoning 1683)
  tools: cad_probe×1, artifact_list×1, artifact_import_file×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_history×1, artifact_read×1

## inclined-foot r3 (spatial) — FAIL
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (40, 30, 20) — expected min (0, 0, 0) max (40, 30, 20) ±0.1
- ✓ volume: 17563.146 mm³ — expected 17562.832 ±1.5% (off by 0.00%)
- ✗ watertight: boundary edges 0, non-manifold 0, inverted true
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (21.552, 15, 6.366): material present
- ✓ solid at (14.567, 15, 8.112): material present
- ✓ solid at (18.06, 18.6, 7.239): material present
- ✓ solid at (1, 15, 19.5): material present
- ✓ solid at (38, 5, 5): material present
- ✓ empty at (19.951, 15, 14.806): empty
- ✓ empty at (19.515, 15, 13.06): empty
- ✓ empty at (18.06, 15, 7.239): empty
- ✓ empty at (16.847, 15, 2.388): empty
- ✓ empty at (39, 15, 12): empty

  turns 1 · tool calls 9 (errors 1) · shell 5 · 116s · in 437262 (cached 386048) out 4375 (reasoning 1681)
  tools: cad_probe×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1, artifact_history×1

## v-pulley r1 (engineering-constraints) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-30, -30, 0) max (30, 30, 16) — expected min (-30, -30, 0) max (30, 30, 16) ±0.2
- ✓ volume: 40857.802 mm³ — expected 40874.215 ±1.5% (off by 0.04%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (29, 0, 2): material present
- ✓ solid at (0, 26, 11): material present
- ✓ solid at (24, 0, 8): material present
- ✓ empty at (27, 0, 8): empty
- ✓ empty at (0, 0, 8): empty
- ✓ empty at (0, 29, 10): empty
- ✓ section z=2: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (x=0, y=0)
- ✓ section z=2: hole d8 at (x=0, y=0): found d=8 at (0, 0) roundness 1
- ✓ section z=2: outer circle d60: found d=60 at (0, 0) roundness 1
- ✓ section z=8: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (x=0, y=0)
- ✓ section z=8: outer circle d50: found d=50 at (0, 0) roundness 1
- ✓ section z=10: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (x=0, y=0)
- ✓ section z=10: outer circle d55: found d=55 at (0, 0) roundness 1
- ✓ section z=14: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (x=0, y=0)
- ✓ section z=14: outer circle d60: found d=60 at (0, 0) roundness 1

  turns 1 · tool calls 10 (errors 1) · shell 3 · 89s · in 404235 (cached 372736) out 3755 (reasoning 1541)
  tools: artifact_list×1, cad_probe×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×2, cad_inspect×2, artifact_read×1

## v-pulley r2 (engineering-constraints) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-30, -30, 0) max (30, 30, 16) — expected min (-30, -30, 0) max (30, 30, 16) ±0.2
- ✓ volume: 40857.802 mm³ — expected 40874.215 ±1.5% (off by 0.04%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (29, 0, 2): material present
- ✓ solid at (0, 26, 11): material present
- ✓ solid at (24, 0, 8): material present
- ✓ empty at (27, 0, 8): empty
- ✓ empty at (0, 0, 8): empty
- ✓ empty at (0, 29, 10): empty
- ✓ section z=2: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (x=0, y=0)
- ✓ section z=2: hole d8 at (x=0, y=0): found d=8 at (0, 0) roundness 1
- ✓ section z=2: outer circle d60: found d=60 at (0, 0) roundness 1
- ✓ section z=8: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (x=0, y=0)
- ✓ section z=8: outer circle d50: found d=50 at (0, 0) roundness 1
- ✓ section z=10: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (x=0, y=0)
- ✓ section z=10: outer circle d55: found d=55 at (0, 0) roundness 1
- ✓ section z=14: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (x=0, y=0)
- ✓ section z=14: outer circle d60: found d=60 at (0, 0) roundness 1

  turns 1 · tool calls 8 (errors 1) · shell 4 · 111s · in 333812 (cached 272128) out 4281 (reasoning 1435)
  tools: project_summary×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1

## v-pulley r3 (engineering-constraints) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-30, -30, 0) max (30, 30, 16) — expected min (-30, -30, 0) max (30, 30, 16) ±0.2
- ✓ volume: 40870.111 mm³ — expected 40874.215 ±1.5% (off by 0.01%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (29, 0, 2): material present
- ✓ solid at (0, 26, 11): material present
- ✓ solid at (24, 0, 8): material present
- ✓ empty at (27, 0, 8): empty
- ✓ empty at (0, 0, 8): empty
- ✓ empty at (0, 29, 10): empty
- ✓ section z=2: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (x=0, y=0)
- ✓ section z=2: hole d8 at (x=0, y=0): found d=8 at (0, 0) roundness 1
- ✓ section z=2: outer circle d60: found d=60 at (0, 0) roundness 1
- ✓ section z=8: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (x=0, y=0)
- ✓ section z=8: outer circle d50: found d=50 at (0, 0) roundness 1
- ✓ section z=10: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (x=0, y=0)
- ✓ section z=10: outer circle d55: found d=55 at (0, 0) roundness 1
- ✓ section z=14: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (x=0, y=0)
- ✓ section z=14: outer circle d60: found d=60 at (0, 0) roundness 1

  turns 1 · tool calls 10 (errors 1) · shell 5 · 115s · in 348759 (cached 317696) out 4774 (reasoning 1331)
  tools: cad_probe×1, project_summary×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×2

## slotted-disc r1 (spatial) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-40, -40, 0) max (40, 40, 5) — expected min (-40, -40, 0) max (40, 40, 5) ±0.2
- ✓ volume: 22146.163 mm³ — expected 22155.927 ±1.5% (off by 0.04%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (16.887, 9.75, 2.5): material present
- ✓ solid at (19.445, 19.445, 2.5): material present
- ✓ solid at (37, 0, 2.5): material present
- ✓ solid at (10, 0, 2.5): material present
- ✓ empty at (23.816, 13.75, 2.5): empty
- ✓ empty at (18.62, 10.75, 2.5): empty
- ✓ empty at (13.75, 23.816, 2.5): empty
- ✓ empty at (-23.816, -13.75, 2.5): empty
- ✓ section z=2.5: hole count: 13 cut-out loop(s) — expected 13; found: cut-out circle d=10 at (x=0, y=0); cut-out shape bbox 15×3 centered (x=27.5, y=0) area 43.066; cut-out shape bbox 3×15 centered (x=0, y=27.5) area 43.066; cut-out shape bbox 15×3 centered (x=-27.5, y=0) area 43.066; cut-out shape bbox 3×15 centered (x=0, y=-27.5) area 43.066; cut-out shape bbox 13.392×9 centered (x=23.816, y=13.75) area 43.066; cut-out shape bbox 9×13.392 centered (x=13.75, y=23.816) area 43.066; cut-out shape bbox 9×13.392 centered (x=-13.75, y=23.816) area 43.066; cut-out shape bbox 13.392×9 centered (x=-23.816, y=13.75) area 43.066; cut-out shape bbox 13.392×9 centered (x=-23.816, y=-13.75) area 43.066; cut-out shape bbox 9×13.392 centered (x=-13.75, y=-23.816) area 43.066; cut-out shape bbox 9×13.392 centered (x=13.75, y=-23.816) area 43.066; cut-out shape bbox 13.392×9 centered (x=23.816, y=-13.75) area 43.066
- ✓ section z=2.5: hole d10 at (x=0, y=0): found d=10 at (0, 0) roundness 1
- ✓ section z=2.5: cut-out 15×3 at (x=27.5, y=0): found cut-out bbox 15×3
- ✓ section z=2.5: cut-out 3×15 at (x=0, y=27.5): found cut-out bbox 3×15
- ✓ section z=2.5: cut-out 15×3 at (x=-27.5, y=0): found cut-out bbox 15×3
- ✓ section z=2.5: cut-out 3×15 at (x=0, y=-27.5): found cut-out bbox 3×15
- ✓ section z=2.5: outer circle d80: found d=80 at (0, 0) roundness 1

  turns 1 · tool calls 8 (errors 1) · shell 5 · 100s · in 454662 (cached 423424) out 3749 (reasoning 1480)
  tools: cad_probe×1, artifact_import_file×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1

## slotted-disc r2 (spatial) — FAIL
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-40, -40, 0) max (40, 40, 5) — expected min (-40, -40, 0) max (40, 40, 5) ±0.2
- ✗ volume: 22913.714 mm³ — expected 22155.927 ±1.5% (off by 3.42%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (16.887, 9.75, 2.5): material present
- ✓ solid at (19.445, 19.445, 2.5): material present
- ✓ solid at (37, 0, 2.5): material present
- ✓ solid at (10, 0, 2.5): material present
- ✓ empty at (23.816, 13.75, 2.5): empty
- ✓ empty at (18.62, 10.75, 2.5): empty
- ✓ empty at (13.75, 23.816, 2.5): empty
- ✓ empty at (-23.816, -13.75, 2.5): empty
- ✓ section z=2.5: hole count: 13 cut-out loop(s) — expected 13; found: cut-out circle d=10 at (x=0, y=0); cut-out shape bbox 15×3 centered (x=27.5, y=0) area 43.064; cut-out shape bbox 3×15 centered (x=0, y=27.5) area 43.064; cut-out shape bbox 15×3 centered (x=-27.5, y=0) area 43.064; cut-out shape bbox 3×15 centered (x=0, y=-27.5) area 43.064; cut-out shape bbox 13.392×9 centered (x=23.816, y=13.75) area 43.064; cut-out shape bbox 9×13.392 centered (x=13.75, y=23.816) area 43.064; cut-out shape bbox 9×13.392 centered (x=-13.75, y=23.816) area 43.064; cut-out shape bbox 13.392×9 centered (x=-23.816, y=13.75) area 43.064; cut-out shape bbox 13.392×9 centered (x=-23.816, y=-13.75) area 43.064; cut-out shape bbox 9×13.392 centered (x=-13.75, y=-23.816) area 43.064; cut-out shape bbox 9×13.392 centered (x=13.75, y=-23.816) area 43.064; cut-out shape bbox 13.392×9 centered (x=23.816, y=-13.75) area 43.064
- ✓ section z=2.5: hole d10 at (x=0, y=0): found d=10 at (0, 0) roundness 0.999
- ✓ section z=2.5: cut-out 15×3 at (x=27.5, y=0): found cut-out bbox 15×3
- ✓ section z=2.5: cut-out 3×15 at (x=0, y=27.5): found cut-out bbox 3×15
- ✓ section z=2.5: cut-out 15×3 at (x=-27.5, y=0): found cut-out bbox 15×3
- ✓ section z=2.5: cut-out 3×15 at (x=0, y=-27.5): found cut-out bbox 3×15
- ✓ section z=2.5: outer circle d80: found d=80 at (0, 0) roundness 0.999

  turns 1 · tool calls 11 (errors 1) · shell 7 · 155s · in 553150 (cached 488704) out 6080 (reasoning 2187)
  tools: project_summary×1, artifact_list×1, cad_probe×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1, artifact_history×1

## slotted-disc r3 (spatial) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-40, -40, 0) max (40, 40, 5) — expected min (-40, -40, 0) max (40, 40, 5) ±0.2
- ✓ volume: 22146.796 mm³ — expected 22155.927 ±1.5% (off by 0.04%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (16.887, 9.75, 2.5): material present
- ✓ solid at (19.445, 19.445, 2.5): material present
- ✓ solid at (37, 0, 2.5): material present
- ✓ solid at (10, 0, 2.5): material present
- ✓ empty at (23.816, 13.75, 2.5): empty
- ✓ empty at (18.62, 10.75, 2.5): empty
- ✓ empty at (13.75, 23.816, 2.5): empty
- ✓ empty at (-23.816, -13.75, 2.5): empty
- ✓ section z=2.5: hole count: 13 cut-out loop(s) — expected 13; found: cut-out circle d=10 at (x=0, y=0); cut-out shape bbox 3×15 centered (x=0, y=-27.5) area 43.057; cut-out shape bbox 15×3 centered (x=-27.5, y=0) area 43.057; cut-out shape bbox 3×15 centered (x=0, y=27.5) area 43.057; cut-out shape bbox 15×3 centered (x=27.5, y=0) area 43.057; cut-out shape bbox 13.391×8.998 centered (x=23.816, y=-13.75) area 43.057; cut-out shape bbox 8.998×13.391 centered (x=-13.75, y=-23.816) area 43.057; cut-out shape bbox 13.391×8.998 centered (x=-23.816, y=13.75) area 43.057; cut-out shape bbox 8.998×13.391 centered (x=13.75, y=23.816) area 43.057; cut-out shape bbox 8.998×13.391 centered (x=13.75, y=-23.816) area 43.057; cut-out shape bbox 13.391×8.998 centered (x=-23.816, y=-13.75) area 43.057; cut-out shape bbox 8.998×13.391 centered (x=-13.75, y=23.816) area 43.057; cut-out shape bbox 13.391×8.998 centered (x=23.816, y=13.75) area 43.057
- ✓ section z=2.5: hole d10 at (x=0, y=0): found d=10 at (0, 0) roundness 0.999
- ✓ section z=2.5: cut-out 15×3 at (x=27.5, y=0): found cut-out bbox 15×3
- ✓ section z=2.5: cut-out 3×15 at (x=0, y=27.5): found cut-out bbox 3×15
- ✓ section z=2.5: cut-out 15×3 at (x=-27.5, y=0): found cut-out bbox 15×3
- ✓ section z=2.5: cut-out 3×15 at (x=0, y=-27.5): found cut-out bbox 3×15
- ✓ section z=2.5: outer circle d80: found d=80 at (0, 0) roundness 1

  turns 1 · tool calls 11 (errors 1) · shell 6 · 143s · in 391999 (cached 361472) out 5033 (reasoning 1432)
  tools: project_summary×1, cad_probe×1, tool_list×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_history×1, artifact_read×1

## bracket-thicken r1 (modification) — PASS
- ✓ new revision on the same artifact: 3 revision(s) on "Shelf bracket"
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (60, 40, 45) — expected min (0, 0, 0) max (60, 40, 45) ±0.1
- ✓ volume: 36508.337 mm³ — expected 36507.611 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (30, 33, 25): material present
- ✓ solid at (30, 20, 7.5): material present
- ✓ empty at (30, 31, 25): empty
- ✓ empty at (15, 17.5, 4): empty
- ✓ empty at (30, 20, 8.5): empty
- ✓ section z=4: hole count: 2 cut-out loop(s) — expected 2; found: cut-out circle d=6 at (x=15, y=17.5); cut-out circle d=6 at (x=45, y=17.5)
- ✓ section z=4: hole d6 at (x=15, y=17.5): found d=6 at (15, 17.5) roundness 0.999
- ✓ section z=4: hole d6 at (x=45, y=17.5): found d=6 at (45, 17.5) roundness 0.999
- ✓ section z=4: outer rectangle 60×40: found 60×40 centered (30, 20)
- ✓ section z=25: hole count: 0 cut-out loop(s) — expected 0
- ✓ section z=25: body count: 1 material region(s) — expected 1
- ✓ section z=25: outer rectangle 60×8: found 60×8 centered (30, 36)

  turns 1 · tool calls 11 (errors 1) · shell 2 · 115s · in 503014 (cached 451072) out 5162 (reasoning 2133)
  tools: artifact_list×1, artifact_read×2, artifact_read_file×1, artifact_update_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_history×1

## bracket-thicken r2 (modification) — PASS
- ✓ new revision on the same artifact: 4 revision(s) on "Shelf bracket"
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (60, 40, 45) — expected min (0, 0, 0) max (60, 40, 45) ±0.1
- ✓ volume: 36508.337 mm³ — expected 36507.611 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (30, 33, 25): material present
- ✓ solid at (30, 20, 7.5): material present
- ✓ empty at (30, 31, 25): empty
- ✓ empty at (15, 17.5, 4): empty
- ✓ empty at (30, 20, 8.5): empty
- ✓ section z=4: hole count: 2 cut-out loop(s) — expected 2; found: cut-out circle d=6 at (x=15, y=17.5); cut-out circle d=6 at (x=45, y=17.5)
- ✓ section z=4: hole d6 at (x=15, y=17.5): found d=6 at (15, 17.5) roundness 0.999
- ✓ section z=4: hole d6 at (x=45, y=17.5): found d=6 at (45, 17.5) roundness 0.999
- ✓ section z=4: outer rectangle 60×40: found 60×40 centered (30, 20)
- ✓ section z=25: hole count: 0 cut-out loop(s) — expected 0
- ✓ section z=25: body count: 1 material region(s) — expected 1
- ✓ section z=25: outer rectangle 60×8: found 60×8 centered (30, 36)

  turns 1 · tool calls 13 (errors 1) · shell 5 · 124s · in 552659 (cached 509184) out 5376 (reasoning 2703)
  tools: artifact_list×1, artifact_read×3, artifact_update_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_history×1, proposal_list×1, artifact_compare×1

## bracket-thicken r3 (modification) — PASS
- ✓ new revision on the same artifact: 4 revision(s) on "Shelf bracket — 8 mm plates"
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (60, 40, 45) — expected min (0, 0, 0) max (60, 40, 45) ±0.1
- ✓ volume: 36508.337 mm³ — expected 36507.611 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (30, 33, 25): material present
- ✓ solid at (30, 20, 7.5): material present
- ✓ empty at (30, 31, 25): empty
- ✓ empty at (15, 17.5, 4): empty
- ✓ empty at (30, 20, 8.5): empty
- ✓ section z=4: hole count: 2 cut-out loop(s) — expected 2; found: cut-out circle d=6 at (x=15, y=17.5); cut-out circle d=6 at (x=45, y=17.5)
- ✓ section z=4: hole d6 at (x=15, y=17.5): found d=6 at (15, 17.5) roundness 0.999
- ✓ section z=4: hole d6 at (x=45, y=17.5): found d=6 at (45, 17.5) roundness 0.999
- ✓ section z=4: outer rectangle 60×40: found 60×40 centered (30, 20)
- ✓ section z=25: hole count: 0 cut-out loop(s) — expected 0
- ✓ section z=25: body count: 1 material region(s) — expected 1
- ✓ section z=25: outer rectangle 60×8: found 60×8 centered (30, 36)

  turns 1 · tool calls 16 (errors 1) · shell 2 · 268s · in 729456 (cached 688896) out 6610 (reasoning 2616)
  tools: artifact_list×2, artifact_read×2, artifact_read_file×1, artifact_update_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, proposal_list×1, proposal_submit×1, proposal_wait×1, ui_request_review×1, proposal_read×1
