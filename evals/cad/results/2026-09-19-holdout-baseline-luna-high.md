# CAD eval — holdout suite · gpt-5.6-luna (high)

Runs passed: **15/15** · checks passed: 318/318 · tasks fully reliable: 5/5

| task | category | pass rate | checks | verified runs | avg tool calls | avg tool errors | avg shell | avg time | avg out tokens | avg input tokens |
|---|---|---|---|---|---|---|---|---|---|---|
| hinge-block | feature-composition | 3/3 | 66/66 | 0/3 | 9.0 | 0.7 | 4.3 | 123s | 4672 | 419463 |
| keyed-bushing | engineering-constraints | 3/3 | 48/48 | 0/3 | 9.0 | 0.7 | 3.0 | 121s | 4481 | 386574 |
| battery-tray-modify | modification | 3/3 | 66/66 | 0/3 | 15.0 | 1.3 | 0.7 | 138s | 5441 | 512246 |
| pillow-block | complete-object | 3/3 | 78/78 | 0/3 | 10.0 | 1.0 | 5.0 | 101s | 3923 | 448864 |
| chamfered-plate | spatial | 3/3 | 60/60 | 0/3 | 10.7 | 1.0 | 3.3 | 135s | 4582 | 464408 |
| **all** | | 15/15 | 318/318 | 0/15 | 10.7 | 0.9 | 3.3 | 124s | 4619 | 446311 |

## Failed checks


## Runs

## hinge-block r1 (feature-composition) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (40, 30, 30) — expected min (0, 0, 0) max (40, 30, 30) ±0.1
- ✓ volume: 32237.238 mm³ — expected 32235.122 ±1.5% (off by 0.01%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (20, 25, 25): material present
- ✓ solid at (20, 15, 17): material present
- ✓ solid at (10, 12, 15): material present
- ✓ solid at (20, 5, 28): material present
- ✓ empty at (20, 25, 28): empty
- ✓ empty at (20, 15, 22): empty
- ✓ empty at (10, 6, 15): empty
- ✓ empty at (2, 15, 22): empty
- ✓ section x=20: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (y=15, z=22)
- ✓ section x=20: hole d8 at (y=15, z=22): found d=8 at (15, 22) roundness 0.999
- ✓ section z=10: hole count: 2 cut-out loop(s) — expected 2; found: cut-out circle d=4.5 at (x=10, y=6); cut-out circle d=4.5 at (x=30, y=6)
- ✓ section z=10: hole d4.5 at (x=10, y=6): found d=4.5 at (10, 6) roundness 0.999
- ✓ section z=10: hole d4.5 at (x=30, y=6): found d=4.5 at (30, 6) roundness 0.999
- ✓ section z=10: outer rectangle 40×30: found 40×30 centered (20, 15)
- ✓ section x=5: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (y=15, z=22)
- ✓ section x=5: outer rectangle 30×30: found 30×30 centered (15, 15)

  turns 1 · tool calls 10 (errors 1) · shell 4 · 107s · in 417701 (cached 387072) out 3099 (reasoning 1075)
  tools: cad_probe×1, artifact_list×1, artifact_import_file×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_history×1, artifact_read×1 · verification: 0 cad_check call(s)

## hinge-block r2 (feature-composition) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (40, 30, 30) — expected min (0, 0, 0) max (40, 30, 30) ±0.1
- ✓ volume: 32237.238 mm³ — expected 32235.122 ±1.5% (off by 0.01%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (20, 25, 25): material present
- ✓ solid at (20, 15, 17): material present
- ✓ solid at (10, 12, 15): material present
- ✓ solid at (20, 5, 28): material present
- ✓ empty at (20, 25, 28): empty
- ✓ empty at (20, 15, 22): empty
- ✓ empty at (10, 6, 15): empty
- ✓ empty at (2, 15, 22): empty
- ✓ section x=20: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (y=15, z=22)
- ✓ section x=20: hole d8 at (y=15, z=22): found d=8 at (15, 22) roundness 0.999
- ✓ section z=10: hole count: 2 cut-out loop(s) — expected 2; found: cut-out circle d=4.5 at (x=10, y=6); cut-out circle d=4.5 at (x=30, y=6)
- ✓ section z=10: hole d4.5 at (x=10, y=6): found d=4.5 at (10, 6) roundness 0.999
- ✓ section z=10: hole d4.5 at (x=30, y=6): found d=4.5 at (30, 6) roundness 0.999
- ✓ section z=10: outer rectangle 40×30: found 40×30 centered (20, 15)
- ✓ section x=5: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (y=15, z=22)
- ✓ section x=5: outer rectangle 30×30: found 30×30 centered (15, 15)

  turns 1 · tool calls 7 (errors 1) · shell 6 · 166s · in 497784 (cached 439808) out 6738 (reasoning 1975)
  tools: artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1 · verification: 0 cad_check call(s)

## hinge-block r3 (feature-composition) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (40, 30, 30) — expected min (0, 0, 0) max (40, 30, 30) ±0.1
- ✓ volume: 32237.238 mm³ — expected 32235.122 ±1.5% (off by 0.01%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (20, 25, 25): material present
- ✓ solid at (20, 15, 17): material present
- ✓ solid at (10, 12, 15): material present
- ✓ solid at (20, 5, 28): material present
- ✓ empty at (20, 25, 28): empty
- ✓ empty at (20, 15, 22): empty
- ✓ empty at (10, 6, 15): empty
- ✓ empty at (2, 15, 22): empty
- ✓ section x=20: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (y=15, z=22)
- ✓ section x=20: hole d8 at (y=15, z=22): found d=8 at (15, 22) roundness 0.999
- ✓ section z=10: hole count: 2 cut-out loop(s) — expected 2; found: cut-out circle d=4.5 at (x=10, y=6); cut-out circle d=4.5 at (x=30, y=6)
- ✓ section z=10: hole d4.5 at (x=10, y=6): found d=4.5 at (10, 6) roundness 0.999
- ✓ section z=10: hole d4.5 at (x=30, y=6): found d=4.5 at (30, 6) roundness 0.999
- ✓ section z=10: outer rectangle 40×30: found 40×30 centered (20, 15)
- ✓ section x=5: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (y=15, z=22)
- ✓ section x=5: outer rectangle 30×30: found 30×30 centered (15, 15)

  turns 1 · tool calls 10 (errors 0) · shell 3 · 95s · in 342905 (cached 314624) out 4178 (reasoning 1338)
  tools: project_summary×1, artifact_create_draft×1, artifact_read_file×1, artifact_update_draft×1, cad_probe×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×1, artifact_read×1 · verification: 0 cad_check call(s)

## keyed-bushing r1 (engineering-constraints) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-12, -12, 0) max (12, 12, 20) — expected min (-12, -12, 0) max (12, 12, 20) ±0.15
- ✓ volume: 6577.975 mm³ — expected 6576.797 ±1.5% (off by 0.02%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (0, -7.5, 10): material present
- ✓ solid at (3, 7.5, 10): material present
- ✓ solid at (0, 9.2, 10): material present
- ✓ solid at (-3, 7.5, 10): material present
- ✓ empty at (0, 7.5, 10): empty
- ✓ empty at (0, 0, 10): empty
- ✓ empty at (1.5, 8, 10): empty
- ✓ section z=10: hole count: 1 cut-out loop(s) — expected 1; found: cut-out shape bbox 12×14.5 centered (x=0, y=1.25) area 123.309
- ✓ section z=10: cut-out 12×14.5 at (x=0, y=1.25): found cut-out bbox 12×14.5
- ✓ section z=10: outer circle d24: found d=24 at (0, 0) roundness 1

  turns 1 · tool calls 8 (errors 0) · shell 3 · 104s · in 246941 (cached 221184) out 3431 (reasoning 1634)
  tools: project_summary×1, cad_probe×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×1, artifact_read×1 · verification: 0 cad_check call(s)

## keyed-bushing r2 (engineering-constraints) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-12, -12, 0) max (12, 12, 20) — expected min (-12, -12, 0) max (12, 12, 20) ±0.15
- ✓ volume: 6573.973 mm³ — expected 6576.797 ±1.5% (off by 0.04%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (0, -7.5, 10): material present
- ✓ solid at (3, 7.5, 10): material present
- ✓ solid at (0, 9.2, 10): material present
- ✓ solid at (-3, 7.5, 10): material present
- ✓ empty at (0, 7.5, 10): empty
- ✓ empty at (0, 0, 10): empty
- ✓ empty at (1.5, 8, 10): empty
- ✓ section z=10: hole count: 1 cut-out loop(s) — expected 1; found: cut-out shape bbox 12×14.5 centered (x=0, y=1.25) area 123.509
- ✓ section z=10: cut-out 12×14.5 at (x=0, y=1.25): found cut-out bbox 12×14.5
- ✓ section z=10: outer circle d24: found d=24 at (0, 0) roundness 1

  turns 1 · tool calls 9 (errors 1) · shell 6 · 147s · in 568958 (cached 510720) out 5823 (reasoning 1961)
  tools: cad_probe×1, artifact_list×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1 · verification: 0 cad_check call(s)

## keyed-bushing r3 (engineering-constraints) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-12, -12, 0) max (12, 12, 20) — expected min (-12, -12, 0) max (12, 12, 20) ±0.15
- ✓ volume: 6573.973 mm³ — expected 6576.797 ±1.5% (off by 0.04%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (0, -7.5, 10): material present
- ✓ solid at (3, 7.5, 10): material present
- ✓ solid at (0, 9.2, 10): material present
- ✓ solid at (-3, 7.5, 10): material present
- ✓ empty at (0, 7.5, 10): empty
- ✓ empty at (0, 0, 10): empty
- ✓ empty at (1.5, 8, 10): empty
- ✓ section z=10: hole count: 1 cut-out loop(s) — expected 1; found: cut-out shape bbox 12×14.5 centered (x=0, y=1.25) area 123.509
- ✓ section z=10: cut-out 12×14.5 at (x=0, y=1.25): found cut-out bbox 12×14.5
- ✓ section z=10: outer circle d24: found d=24 at (0, 0) roundness 1

  turns 1 · tool calls 10 (errors 1) · shell 0 · 112s · in 343823 (cached 313088) out 4188 (reasoning 1330)
  tools: project_summary×1, artifact_list×1, cad_probe×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1 · verification: 0 cad_check call(s)

## battery-tray-modify r1 (modification) — PASS
- ✓ new revision on the same artifact: 3 revision(s) on "Battery tray"
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (70, 50, 20) — expected min (0, 0, 0) max (70, 50, 20) ±0.1
- ✓ volume: 19255.542 mm³ — expected 19255.451 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (1.5, 25, 10): material present
- ✓ solid at (35, 48.5, 10): material present
- ✓ solid at (35, 25, 1): material present
- ✓ empty at (35, 25, 10): empty
- ✓ empty at (10, 10, 1): empty
- ✓ empty at (3.5, 25, 10): empty
- ✓ section z=1: hole count: 4 cut-out loop(s) — expected 4; found: cut-out circle d=3 at (x=60, y=40); cut-out circle d=3 at (x=10, y=40); cut-out circle d=3 at (x=60, y=10); cut-out circle d=3 at (x=10, y=10)
- ✓ section z=1: hole d3 at (x=10, y=10): found d=3 at (10, 10) roundness 0.999
- ✓ section z=1: hole d3 at (x=60, y=10): found d=3 at (60, 10) roundness 0.999
- ✓ section z=1: hole d3 at (x=10, y=40): found d=3 at (10, 40) roundness 0.999
- ✓ section z=1: hole d3 at (x=60, y=40): found d=3 at (60, 40) roundness 0.999
- ✓ section z=1: outer rectangle 70×50: found 70×50 centered (35, 25)
- ✓ section z=10: hole count: 1 cut-out loop(s) — expected 1; found: cut-out rectangle 64×44 centered (x=35, y=25)
- ✓ section z=10: cut-out 64×44 at (x=35, y=25): found cut-out bbox 64×44
- ✓ section z=10: outer rectangle 70×50: found 70×50 centered (35, 25)

  turns 1 · tool calls 15 (errors 1) · shell 0 · 125s · in 473633 (cached 436992) out 5172 (reasoning 2341)
  tools: artifact_list×2, artifact_read×2, artifact_read_file×1, artifact_update_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, proposal_submit×1, proposal_wait×1, ui_request_review×1, proposal_read×1 · verification: 0 cad_check call(s)

## battery-tray-modify r2 (modification) — PASS
- ✓ new revision on the same artifact: 3 revision(s) on "Battery tray - 3 mm walls with four drain holes"
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (70, 50, 20) — expected min (0, 0, 0) max (70, 50, 20) ±0.1
- ✓ volume: 19255.542 mm³ — expected 19255.451 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (1.5, 25, 10): material present
- ✓ solid at (35, 48.5, 10): material present
- ✓ solid at (35, 25, 1): material present
- ✓ empty at (35, 25, 10): empty
- ✓ empty at (10, 10, 1): empty
- ✓ empty at (3.5, 25, 10): empty
- ✓ section z=1: hole count: 4 cut-out loop(s) — expected 4; found: cut-out circle d=3 at (x=60, y=40); cut-out circle d=3 at (x=60, y=10); cut-out circle d=3 at (x=10, y=40); cut-out circle d=3 at (x=10, y=10)
- ✓ section z=1: hole d3 at (x=10, y=10): found d=3 at (10, 10) roundness 0.999
- ✓ section z=1: hole d3 at (x=60, y=10): found d=3 at (60, 10) roundness 0.999
- ✓ section z=1: hole d3 at (x=10, y=40): found d=3 at (10, 40) roundness 0.999
- ✓ section z=1: hole d3 at (x=60, y=40): found d=3 at (60, 40) roundness 0.999
- ✓ section z=1: outer rectangle 70×50: found 70×50 centered (35, 25)
- ✓ section z=10: hole count: 1 cut-out loop(s) — expected 1; found: cut-out rectangle 64×44 centered (x=35, y=25)
- ✓ section z=10: cut-out 64×44 at (x=35, y=25): found cut-out bbox 64×44
- ✓ section z=10: outer rectangle 70×50: found 70×50 centered (35, 25)

  turns 1 · tool calls 13 (errors 2) · shell 0 · 154s · in 448466 (cached 408576) out 5730 (reasoning 1950)
  tools: artifact_list×2, artifact_read×3, artifact_read_file×1, artifact_update_draft×2, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2 · verification: 0 cad_check call(s)

## battery-tray-modify r3 (modification) — PASS
- ✓ new revision on the same artifact: 3 revision(s) on "Battery tray"
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (70, 50, 20) — expected min (0, 0, 0) max (70, 50, 20) ±0.1
- ✓ volume: 19255.542 mm³ — expected 19255.451 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (1.5, 25, 10): material present
- ✓ solid at (35, 48.5, 10): material present
- ✓ solid at (35, 25, 1): material present
- ✓ empty at (35, 25, 10): empty
- ✓ empty at (10, 10, 1): empty
- ✓ empty at (3.5, 25, 10): empty
- ✓ section z=1: hole count: 4 cut-out loop(s) — expected 4; found: cut-out circle d=3 at (x=60, y=40); cut-out circle d=3 at (x=60, y=10); cut-out circle d=3 at (x=10, y=40); cut-out circle d=3 at (x=10, y=10)
- ✓ section z=1: hole d3 at (x=10, y=10): found d=3 at (10, 10) roundness 0.999
- ✓ section z=1: hole d3 at (x=60, y=10): found d=3 at (60, 10) roundness 0.999
- ✓ section z=1: hole d3 at (x=10, y=40): found d=3 at (10, 40) roundness 0.999
- ✓ section z=1: hole d3 at (x=60, y=40): found d=3 at (60, 40) roundness 0.999
- ✓ section z=1: outer rectangle 70×50: found 70×50 centered (35, 25)
- ✓ section z=10: hole count: 1 cut-out loop(s) — expected 1; found: cut-out rectangle 64×44 centered (x=35, y=25)
- ✓ section z=10: cut-out 64×44 at (x=35, y=25): found cut-out bbox 64×44
- ✓ section z=10: outer rectangle 70×50: found 70×50 centered (35, 25)

  turns 1 · tool calls 17 (errors 1) · shell 2 · 135s · in 614640 (cached 570368) out 5420 (reasoning 2593)
  tools: artifact_list×2, artifact_read×1, artifact_read_file×1, project_summary×1, proposal_list×1, artifact_update_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, proposal_submit×1, proposal_read×1, ui_request_review×1, artifact_history×1, ui_open_artifact×1 · verification: 0 cad_check call(s)

## pillow-block r1 (complete-object) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (70, 30, 40) — expected min (0, 0, 0) max (70, 30, 40) ±0.1
- ✓ volume: 35940.971 mm³ — expected 35932.357 ±1.5% (off by 0.02%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (35, 15, 12): material present
- ✓ solid at (22, 15, 28): material present
- ✓ solid at (48, 15, 28): material present
- ✓ solid at (35, 15, 39.5): material present
- ✓ solid at (65, 5, 5): material present
- ✓ empty at (35, 15, 28): empty
- ✓ empty at (10, 15, 5): empty
- ✓ empty at (35, 15, 20): empty
- ✓ empty at (15, 15, 20): empty
- ✓ section z=5: hole count: 2 cut-out loop(s) — expected 2; found: cut-out circle d=6.5 at (x=60, y=15); cut-out circle d=6.5 at (x=10, y=15)
- ✓ section z=5: hole d6.5 at (x=10, y=15): found d=6.5 at (10, 15) roundness 0.999
- ✓ section z=5: hole d6.5 at (x=60, y=15): found d=6.5 at (60, 15) roundness 0.999
- ✓ section z=5: outer rectangle 70×30: found 70×30 centered (35, 15)
- ✓ section z=28: hole count: 0 cut-out loop(s) — expected 0
- ✓ section z=28: body count: 2 material region(s) — expected 2
- ✓ section y=15: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=22 at (x=35, z=28)
- ✓ section y=15: hole d22 at (x=35, z=28): found d=22 at (35, 28) roundness 0.999
- ✓ section z=14: hole count: 0 cut-out loop(s) — expected 0
- ✓ section z=14: body count: 1 material region(s) — expected 1
- ✓ section z=14: outer rectangle 30×30: found 30×30 centered (35, 15)

  turns 1 · tool calls 9 (errors 1) · shell 5 · 115s · in 553106 (cached 516864) out 4109 (reasoning 1638)
  tools: cad_probe×1, artifact_import_file×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1, artifact_list×1 · verification: 0 cad_check call(s)

## pillow-block r2 (complete-object) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (70, 30, 40) — expected min (0, 0, 0) max (70, 30, 40) ±0.1
- ✓ volume: 35940.971 mm³ — expected 35932.357 ±1.5% (off by 0.02%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (35, 15, 12): material present
- ✓ solid at (22, 15, 28): material present
- ✓ solid at (48, 15, 28): material present
- ✓ solid at (35, 15, 39.5): material present
- ✓ solid at (65, 5, 5): material present
- ✓ empty at (35, 15, 28): empty
- ✓ empty at (10, 15, 5): empty
- ✓ empty at (35, 15, 20): empty
- ✓ empty at (15, 15, 20): empty
- ✓ section z=5: hole count: 2 cut-out loop(s) — expected 2; found: cut-out circle d=6.5 at (x=60, y=15); cut-out circle d=6.5 at (x=10, y=15)
- ✓ section z=5: hole d6.5 at (x=10, y=15): found d=6.5 at (10, 15) roundness 0.999
- ✓ section z=5: hole d6.5 at (x=60, y=15): found d=6.5 at (60, 15) roundness 0.999
- ✓ section z=5: outer rectangle 70×30: found 70×30 centered (35, 15)
- ✓ section z=28: hole count: 0 cut-out loop(s) — expected 0
- ✓ section z=28: body count: 2 material region(s) — expected 2
- ✓ section y=15: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=22 at (x=35, z=28)
- ✓ section y=15: hole d22 at (x=35, z=28): found d=22 at (35, 28) roundness 0.999
- ✓ section z=14: hole count: 0 cut-out loop(s) — expected 0
- ✓ section z=14: body count: 1 material region(s) — expected 1
- ✓ section z=14: outer rectangle 30×30: found 30×30 centered (35, 15)

  turns 1 · tool calls 11 (errors 1) · shell 5 · 101s · in 341873 (cached 301312) out 4084 (reasoning 1609)
  tools: cad_probe×1, artifact_list×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1, job_list×1, artifact_history×1 · verification: 0 cad_check call(s)

## pillow-block r3 (complete-object) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (70, 30, 40) — expected min (0, 0, 0) max (70, 30, 40) ±0.1
- ✓ volume: 35940.971 mm³ — expected 35932.357 ±1.5% (off by 0.02%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (35, 15, 12): material present
- ✓ solid at (22, 15, 28): material present
- ✓ solid at (48, 15, 28): material present
- ✓ solid at (35, 15, 39.5): material present
- ✓ solid at (65, 5, 5): material present
- ✓ empty at (35, 15, 28): empty
- ✓ empty at (10, 15, 5): empty
- ✓ empty at (35, 15, 20): empty
- ✓ empty at (15, 15, 20): empty
- ✓ section z=5: hole count: 2 cut-out loop(s) — expected 2; found: cut-out circle d=6.5 at (x=60, y=15); cut-out circle d=6.5 at (x=10, y=15)
- ✓ section z=5: hole d6.5 at (x=10, y=15): found d=6.5 at (10, 15) roundness 0.999
- ✓ section z=5: hole d6.5 at (x=60, y=15): found d=6.5 at (60, 15) roundness 0.999
- ✓ section z=5: outer rectangle 70×30: found 70×30 centered (35, 15)
- ✓ section z=28: hole count: 0 cut-out loop(s) — expected 0
- ✓ section z=28: body count: 2 material region(s) — expected 2
- ✓ section y=15: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=22 at (x=35, z=28)
- ✓ section y=15: hole d22 at (x=35, z=28): found d=22 at (35, 28) roundness 0.999
- ✓ section z=14: hole count: 0 cut-out loop(s) — expected 0
- ✓ section z=14: body count: 1 material region(s) — expected 1
- ✓ section z=14: outer rectangle 30×30: found 30×30 centered (35, 15)

  turns 1 · tool calls 10 (errors 1) · shell 5 · 88s · in 451613 (cached 399360) out 3575 (reasoning 1272)
  tools: cad_probe×1, artifact_import_file×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1, artifact_list×1, artifact_history×1 · verification: 0 cad_check call(s)

## chamfered-plate r1 (spatial) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (50, 50, 6) — expected min (0, 0, 0) max (50, 50, 6) ±0.1
- ✓ volume: 14229.097 mm³ — expected 14228.761 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (44, 44, 3): material present
- ✓ solid at (49, 39, 3): material present
- ✓ solid at (39, 49, 3): material present
- ✓ solid at (49, 1, 3): material present
- ✓ empty at (48, 48, 3): empty
- ✓ empty at (46, 46, 3): empty
- ✓ empty at (10, 10, 3): empty
- ✓ section z=3: hole count: 4 cut-out loop(s) — expected 4; found: cut-out circle d=5 at (x=40, y=40); cut-out circle d=5 at (x=40, y=10); cut-out circle d=5 at (x=10, y=40); cut-out circle d=5 at (x=10, y=10)
- ✓ section z=3: body count: 1 material region(s) — expected 1
- ✓ section z=3: hole d5 at (x=10, y=10): found d=5 at (10, 10) roundness 0.999
- ✓ section z=3: hole d5 at (x=40, y=10): found d=5 at (40, 10) roundness 0.999
- ✓ section z=3: hole d5 at (x=10, y=40): found d=5 at (10, 40) roundness 0.999
- ✓ section z=3: hole d5 at (x=40, y=40): found d=5 at (40, 40) roundness 0.999
- ✓ section z=3: material area: 2371.516 mm² — expected 2371.46 ±1.5%

  turns 1 · tool calls 11 (errors 1) · shell 4 · 116s · in 415358 (cached 361472) out 3725 (reasoning 1333)
  tools: project_summary×1, artifact_list×1, cad_probe×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, job_list×1, artifact_read×1 · verification: 0 cad_check call(s)

## chamfered-plate r2 (spatial) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (50, 50, 6) — expected min (0, 0, 0) max (50, 50, 6) ±0.1
- ✓ volume: 14229.097 mm³ — expected 14228.761 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (44, 44, 3): material present
- ✓ solid at (49, 39, 3): material present
- ✓ solid at (39, 49, 3): material present
- ✓ solid at (49, 1, 3): material present
- ✓ empty at (48, 48, 3): empty
- ✓ empty at (46, 46, 3): empty
- ✓ empty at (10, 10, 3): empty
- ✓ section z=3: hole count: 4 cut-out loop(s) — expected 4; found: cut-out circle d=5 at (x=40, y=40); cut-out circle d=5 at (x=10, y=40); cut-out circle d=5 at (x=40, y=10); cut-out circle d=5 at (x=10, y=10)
- ✓ section z=3: body count: 1 material region(s) — expected 1
- ✓ section z=3: hole d5 at (x=10, y=10): found d=5 at (10, 10) roundness 0.999
- ✓ section z=3: hole d5 at (x=40, y=10): found d=5 at (40, 10) roundness 0.999
- ✓ section z=3: hole d5 at (x=10, y=40): found d=5 at (10, 40) roundness 0.999
- ✓ section z=3: hole d5 at (x=40, y=40): found d=5 at (40, 40) roundness 0.999
- ✓ section z=3: material area: 2371.516 mm² — expected 2371.46 ±1.5%

  turns 1 · tool calls 11 (errors 1) · shell 5 · 164s · in 575561 (cached 536320) out 5340 (reasoning 1854)
  tools: cad_probe×1, artifact_list×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1, artifact_history×1, artifact_read_file×1 · verification: 0 cad_check call(s)

## chamfered-plate r3 (spatial) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (50, 50, 6) — expected min (0, 0, 0) max (50, 50, 6) ±0.1
- ✓ volume: 14229.518 mm³ — expected 14228.761 ±1.5% (off by 0.01%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (44, 44, 3): material present
- ✓ solid at (49, 39, 3): material present
- ✓ solid at (39, 49, 3): material present
- ✓ solid at (49, 1, 3): material present
- ✓ empty at (48, 48, 3): empty
- ✓ empty at (46, 46, 3): empty
- ✓ empty at (10, 10, 3): empty
- ✓ section z=3: hole count: 4 cut-out loop(s) — expected 4; found: cut-out circle d=5 at (x=10, y=10); cut-out circle d=5 at (x=40, y=10); cut-out circle d=5 at (x=10, y=40); cut-out circle d=5 at (x=40, y=40)
- ✓ section z=3: body count: 1 material region(s) — expected 1
- ✓ section z=3: hole d5 at (x=10, y=10): found d=5 at (10, 10) roundness 0.999
- ✓ section z=3: hole d5 at (x=40, y=10): found d=5 at (40, 10) roundness 0.999
- ✓ section z=3: hole d5 at (x=10, y=40): found d=5 at (10, 40) roundness 0.999
- ✓ section z=3: hole d5 at (x=40, y=40): found d=5 at (40, 40) roundness 0.999
- ✓ section z=3: material area: 2371.586 mm² — expected 2371.46 ±1.5%

  turns 1 · tool calls 10 (errors 1) · shell 1 · 124s · in 402304 (cached 369920) out 4680 (reasoning 1066)
  tools: cad_probe×1, artifact_list×1, project_summary×1, artifact_create_draft×1, cad_validate_source×1, cad_render×1, job_read×1, cad_inspect×2, artifact_read×1 · verification: 0 cad_check call(s)
