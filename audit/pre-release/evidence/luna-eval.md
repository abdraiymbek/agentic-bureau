# CAD eval — main suite · gpt-5.6-luna (high)

Runs passed: **2/2** · checks passed: 34/34 · tasks fully reliable: 2/2

| task                | category     | pass rate | checks | verified runs | avg tool calls | avg tool errors | avg shell | avg time | avg out tokens | avg input tokens |
| ------------------- | ------------ | --------- | ------ | ------------- | -------------- | --------------- | --------- | -------- | -------------- | ---------------- |
| sensor-plate-modify | modification | 1/1       | 18/18  | 1/1           | 5.0            | 0.0             | 0.0       | 66s      | 2971           | 172876           |
| inclined-foot       | spatial      | 1/1       | 16/16  | 1/1           | 6.0            | 0.0             | 0.0       | 115s     | 5819           | 220825           |
| **all**             |              | 2/2       | 34/34  | 2/2           | 5.5            | 0.0             | 0.0       | 90s      | 4395           | 196851           |

## Failed checks

## Runs

## sensor-plate-modify r1 (modification) — PASS

- ✓ new revision on the same artifact: 2 revision(s) on "Sensor mount plate"
- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (60, 40, 10) — expected min (0, 0, 0) max (60, 40, 10) ±0.1
- ✓ volume: 9889.475 mm³ — expected 9889.655 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
- ✓ single body: 1 shell(s) — expected 1
- ✓ section z=2: hole count: 5 cut-out loop(s) — expected 5; found: cut-out circle d=3.4 at (x=30, y=20); cut-out circle d=3.4 at (x=5, y=5); cut-out circle d=3.4 at (x=5, y=35); cut-out circle d=3.4 at (x=55, y=5); cut-out circle d=3.4 at (x=55, y=35)
- ✓ section z=2: hole d3.4 at (x=5, y=5): found d=3.4 at (5, 5) roundness 0.995
- ✓ section z=2: hole d3.4 at (x=55, y=5): found d=3.4 at (55, 5) roundness 0.995
- ✓ section z=2: hole d3.4 at (x=5, y=35): found d=3.4 at (5, 35) roundness 0.995
- ✓ section z=2: hole d3.4 at (x=55, y=35): found d=3.4 at (55, 35) roundness 0.995
- ✓ section z=2: hole d3.4 at (x=30, y=20): found d=3.4 at (30, 20) roundness 0.995
- ✓ section z=2: outer rectangle 60×40: found 60×40 centered (30, 20)
- ✓ section z=7: hole count: 0 cut-out loop(s) — expected 0
- ✓ section z=7: body count: 1 material region(s) — expected 1
- ✓ section z=7: outer circle d10: found d=10 at (45, 20) roundness 0.998
- ✓ unrelated geometry preserved: 392 sample points outside change regions, 0 differ

  turns 1 · tool calls 5 (errors 0) · shell 0 · 66s · in 172876 (cached 133376) out 2971 (reasoning 1378)
  tools: project_search×1, cad_read_source×1, cad_write_source×1, cad_check×2 · verification: 2 cad_check call(s), last passed

## inclined-foot r1 (spatial) — PASS

- ✓ rendered by agent: STL present on latest revision
- ✓ source renders cleanly: no OpenSCAD warnings
- ✓ bounding box: min (0, 0, 0) max (40, 30, 20) — expected min (0, 0, 0) max (40, 30, 20) ±0.1
- ✓ volume: 17563.008 mm³ — expected 17562.832 ±1.5% (off by 0.00%)
- ✓ watertight: boundary edges 0, non-manifold 0, inverted false
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

  turns 1 · tool calls 6 (errors 0) · shell 0 · 115s · in 220825 (cached 191488) out 5819 (reasoning 3695)
  tools: cad_write_source×2, cad_check×2, cad_set_param×1, cad_inspect×1 · verification: 2 cad_check call(s), last passed
