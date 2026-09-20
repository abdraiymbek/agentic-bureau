# CAD eval — holdout suite · gpt-5.6-luna (high)

Runs passed: **15/15** · checks passed: 318/318 · tasks fully reliable: 5/5

| task | category | pass rate | checks | verified runs | avg tool calls | avg tool errors | avg shell | avg time | avg out tokens | avg input tokens |
|---|---|---|---|---|---|---|---|---|---|---|
| hinge-block | feature-composition | 3/3 | 66/66 | 3/3 | 3.0 | 0.0 | 0.0 | 102s | 3800 | 115453 |
| keyed-bushing | engineering-constraints | 3/3 | 48/48 | 3/3 | 2.3 | 0.0 | 0.0 | 92s | 3294 | 97792 |
| battery-tray-modify | modification | 3/3 | 66/66 | 3/3 | 5.0 | 0.0 | 0.0 | 67s | 2462 | 154746 |
| pillow-block | complete-object | 3/3 | 78/78 | 3/3 | 2.7 | 0.0 | 0.0 | 61s | 2564 | 103526 |
| chamfered-plate | spatial | 3/3 | 60/60 | 3/3 | 3.0 | 0.0 | 0.0 | 65s | 2419 | 113941 |
| **all** | | 15/15 | 318/318 | 15/15 | 3.2 | 0.0 | 0.0 | 78s | 2908 | 117092 |

## Failed checks


## Runs

## hinge-block r1 (feature-composition) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (40, 30, 30) — expected min (0, 0, 0) max (40, 30, 30) ±0.1
- ✓ volume: 32239.882 mm³ — expected 32235.122 ±1.5% (off by 0.01%)
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
- ✓ section z=10: hole count: 2 cut-out loop(s) — expected 2; found: cut-out circle d=4.5 at (x=30, y=6); cut-out circle d=4.5 at (x=10, y=6)
- ✓ section z=10: hole d4.5 at (x=10, y=6): found d=4.5 at (10, 6) roundness 0.999
- ✓ section z=10: hole d4.5 at (x=30, y=6): found d=4.5 at (30, 6) roundness 0.999
- ✓ section z=10: outer rectangle 40×30: found 40×30 centered (20, 15)
- ✓ section x=5: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (y=15, z=22)
- ✓ section x=5: outer rectangle 30×30: found 30×30 centered (15, 15)

  turns 1 · tool calls 3 (errors 0) · shell 0 · 97s · in 106879 (cached 87808) out 3179 (reasoning 1543)
  tools: cad_write_source×1, cad_check×2 · verification: 2 cad_check call(s), last passed

## hinge-block r2 (feature-composition) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (40, 30, 30) — expected min (0, 0, 0) max (40, 30, 30) ±0.1
- ✓ volume: 32239.882 mm³ — expected 32235.122 ±1.5% (off by 0.01%)
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
- ✓ section z=10: hole count: 2 cut-out loop(s) — expected 2; found: cut-out circle d=4.5 at (x=30, y=6); cut-out circle d=4.5 at (x=10, y=6)
- ✓ section z=10: hole d4.5 at (x=10, y=6): found d=4.5 at (10, 6) roundness 0.999
- ✓ section z=10: hole d4.5 at (x=30, y=6): found d=4.5 at (30, 6) roundness 0.999
- ✓ section z=10: outer rectangle 40×30: found 40×30 centered (20, 15)
- ✓ section x=5: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (y=15, z=22)
- ✓ section x=5: outer rectangle 30×30: found 30×30 centered (15, 15)

  turns 1 · tool calls 3 (errors 0) · shell 0 · 134s · in 120488 (cached 96000) out 4710 (reasoning 3063)
  tools: cad_write_source×1, cad_check×2 · verification: 2 cad_check call(s), last passed

## hinge-block r3 (feature-composition) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (40, 30, 30) — expected min (0, 0, 0) max (40, 30, 30) ±0.1
- ✓ volume: 32239.882 mm³ — expected 32235.122 ±1.5% (off by 0.01%)
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
- ✓ section z=10: hole count: 2 cut-out loop(s) — expected 2; found: cut-out circle d=4.5 at (x=30, y=6); cut-out circle d=4.5 at (x=10, y=6)
- ✓ section z=10: hole d4.5 at (x=10, y=6): found d=4.5 at (10, 6) roundness 0.999
- ✓ section z=10: hole d4.5 at (x=30, y=6): found d=4.5 at (30, 6) roundness 0.999
- ✓ section z=10: outer rectangle 40×30: found 40×30 centered (20, 15)
- ✓ section x=5: hole count: 1 cut-out loop(s) — expected 1; found: cut-out circle d=8 at (y=15, z=22)
- ✓ section x=5: outer rectangle 30×30: found 30×30 centered (15, 15)

  turns 1 · tool calls 3 (errors 0) · shell 0 · 75s · in 118991 (cached 91904) out 3512 (reasoning 1843)
  tools: cad_write_source×1, cad_check×2 · verification: 2 cad_check call(s), last passed

## keyed-bushing r1 (engineering-constraints) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-12, -12, 0) max (12, 12, 20) — expected min (-12, -12, 0) max (12, 12, 20) ±0.15
- ✓ volume: 6575.814 mm³ — expected 6576.797 ±1.5% (off by 0.01%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (0, -7.5, 10): material present
- ✓ solid at (3, 7.5, 10): material present
- ✓ solid at (0, 9.2, 10): material present
- ✓ solid at (-3, 7.5, 10): material present
- ✓ empty at (0, 7.5, 10): empty
- ✓ empty at (0, 0, 10): empty
- ✓ empty at (1.5, 8, 10): empty
- ✓ section z=10: hole count: 1 cut-out loop(s) — expected 1; found: cut-out shape bbox 12×14.5 centered (x=0, y=1.25) area 123.276
- ✓ section z=10: cut-out 12×14.5 at (x=0, y=1.25): found cut-out bbox 12×14.5
- ✓ section z=10: outer circle d24: found d=24 at (0, 0) roundness 0.999

  turns 1 · tool calls 3 (errors 0) · shell 0 · 118s · in 117317 (cached 90880) out 4008 (reasoning 2562)
  tools: cad_write_source×1, cad_check×2 · verification: 2 cad_check call(s), last passed

## keyed-bushing r2 (engineering-constraints) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-12, -12, 0) max (12, 12, 20) — expected min (-12, -12, 0) max (12, 12, 20) ±0.15
- ✓ volume: 6575.814 mm³ — expected 6576.797 ±1.5% (off by 0.01%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (0, -7.5, 10): material present
- ✓ solid at (3, 7.5, 10): material present
- ✓ solid at (0, 9.2, 10): material present
- ✓ solid at (-3, 7.5, 10): material present
- ✓ empty at (0, 7.5, 10): empty
- ✓ empty at (0, 0, 10): empty
- ✓ empty at (1.5, 8, 10): empty
- ✓ section z=10: hole count: 1 cut-out loop(s) — expected 1; found: cut-out shape bbox 12×14.5 centered (x=0, y=1.25) area 123.276
- ✓ section z=10: cut-out 12×14.5 at (x=0, y=1.25): found cut-out bbox 12×14.5
- ✓ section z=10: outer circle d24: found d=24 at (0, 0) roundness 0.999

  turns 1 · tool calls 2 (errors 0) · shell 0 · 68s · in 87342 (cached 53248) out 2480 (reasoning 1604)
  tools: cad_write_source×1, cad_check×1 · verification: 1 cad_check call(s), last passed

## keyed-bushing r3 (engineering-constraints) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (-12, -12, 0) max (12, 12, 20) — expected min (-12, -12, 0) max (12, 12, 20) ±0.15
- ✓ volume: 6571.782 mm³ — expected 6576.797 ±1.5% (off by 0.08%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ solid at (0, -7.5, 10): material present
- ✓ solid at (3, 7.5, 10): material present
- ✓ solid at (0, 9.2, 10): material present
- ✓ solid at (-3, 7.5, 10): material present
- ✓ empty at (0, 7.5, 10): empty
- ✓ empty at (0, 0, 10): empty
- ✓ empty at (1.5, 8, 10): empty
- ✓ section z=10: hole count: 1 cut-out loop(s) — expected 1; found: cut-out shape bbox 12×14.5 centered (x=0, y=1.25) area 123.477
- ✓ section z=10: cut-out 12×14.5 at (x=0, y=1.25): found cut-out bbox 12×14.5
- ✓ section z=10: outer circle d24: found d=24 at (0, 0) roundness 0.999

  turns 1 · tool calls 2 (errors 0) · shell 0 · 92s · in 88718 (cached 53248) out 3395 (reasoning 2380)
  tools: cad_write_source×1, cad_check×1 · verification: 1 cad_check call(s), last passed

## battery-tray-modify r1 (modification) — PASS
- ✓ new revision on the same artifact: 2 revision(s) on "Battery tray"
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

  turns 1 · tool calls 5 (errors 0) · shell 0 · 77s · in 138295 (cached 101888) out 2453 (reasoning 1313)
  tools: project_summary×1, project_search×1, cad_read_source×1, cad_write_source×1, cad_check×1 · verification: 1 cad_check call(s), last passed

## battery-tray-modify r2 (modification) — PASS
- ✓ new revision on the same artifact: 2 revision(s) on "Battery tray"
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

  turns 1 · tool calls 5 (errors 0) · shell 0 · 68s · in 163339 (cached 136448) out 2366 (reasoning 1058)
  tools: project_summary×1, artifact_list×1, cad_read_source×1, cad_write_source×1, cad_check×1 · verification: 1 cad_check call(s), last passed

## battery-tray-modify r3 (modification) — PASS
- ✓ new revision on the same artifact: 2 revision(s) on "Battery tray"
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

  turns 1 · tool calls 5 (errors 0) · shell 0 · 56s · in 162603 (cached 139520) out 2568 (reasoning 1262)
  tools: project_summary×1, artifact_list×1, cad_read_source×1, cad_write_source×1, cad_check×1 · verification: 1 cad_check call(s), last passed

## pillow-block r1 (complete-object) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (70, 30, 40) — expected min (0, 0, 0) max (70, 30, 40) ±0.1
- ✓ volume: 35951.733 mm³ — expected 35932.357 ±1.5% (off by 0.05%)
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

  turns 1 · tool calls 3 (errors 0) · shell 0 · 63s · in 105964 (cached 82688) out 2982 (reasoning 1411)
  tools: cad_write_source×1, cad_check×2 · verification: 2 cad_check call(s), last passed

## pillow-block r2 (complete-object) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (70, 30, 40) — expected min (0, 0, 0) max (70, 30, 40) ±0.1
- ✓ volume: 35951.733 mm³ — expected 35932.357 ±1.5% (off by 0.05%)
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

  turns 1 · tool calls 3 (errors 0) · shell 0 · 61s · in 116711 (cached 79616) out 2748 (reasoning 1298)
  tools: cad_write_source×2, cad_check×1 · verification: 1 cad_check call(s), last passed

## pillow-block r3 (complete-object) — PASS
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (70, 30, 40) — expected min (0, 0, 0) max (70, 30, 40) ±0.1
- ✓ volume: 35951.733 mm³ — expected 35932.357 ±1.5% (off by 0.05%)
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

  turns 1 · tool calls 2 (errors 0) · shell 0 · 59s · in 87903 (cached 68608) out 1961 (reasoning 875)
  tools: cad_write_source×1, cad_check×1 · verification: 1 cad_check call(s), last passed

## chamfered-plate r1 (spatial) — PASS
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

  turns 1 · tool calls 3 (errors 0) · shell 0 · 71s · in 108013 (cached 85760) out 2479 (reasoning 980)
  tools: cad_write_source×1, cad_check×2 · verification: 2 cad_check call(s), last passed

## chamfered-plate r2 (spatial) — PASS
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
- ✓ section z=3: hole count: 4 cut-out loop(s) — expected 4; found: cut-out circle d=5 at (x=10, y=10); cut-out circle d=5 at (x=10, y=40); cut-out circle d=5 at (x=40, y=10); cut-out circle d=5 at (x=40, y=40)
- ✓ section z=3: body count: 1 material region(s) — expected 1
- ✓ section z=3: hole d5 at (x=10, y=10): found d=5 at (10, 10) roundness 0.999
- ✓ section z=3: hole d5 at (x=40, y=10): found d=5 at (40, 10) roundness 0.999
- ✓ section z=3: hole d5 at (x=10, y=40): found d=5 at (10, 40) roundness 0.999
- ✓ section z=3: hole d5 at (x=40, y=40): found d=5 at (40, 40) roundness 0.999
- ✓ section z=3: material area: 2371.586 mm² — expected 2371.46 ±1.5%

  turns 1 · tool calls 3 (errors 0) · shell 0 · 67s · in 115222 (cached 92928) out 2362 (reasoning 864)
  tools: cad_write_source×1, cad_check×2 · verification: 2 cad_check call(s), last passed

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

  turns 1 · tool calls 3 (errors 0) · shell 0 · 57s · in 118588 (cached 96000) out 2417 (reasoning 882)
  tools: cad_write_source×1, cad_check×2 · verification: 2 cad_check call(s), last passed
