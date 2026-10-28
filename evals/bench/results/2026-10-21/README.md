# CAD benchmarks and the three-setup comparison, 21 October 2026

One run per configuration. Claude Code 2.1.287 at `xhigh` effort, OpenSCAD 2026.09.18, the
release `omenflow-host` built on 14 October (before 1.0.1). Costs are recomputed from each run's
token usage at list price (Claude Haiku 5.5: $0.10 / $0.50 per million input / output tokens up
to 100K-token prompts, $0.50 / $2.50 above; Claude Opus 5.5: $4 / $20; cache writes at 1.25× and
cache reads at 0.1× / 0.05× of input). The CLI's own cost field is not used: this CLI version
does not know Claude Haiku 5.5 and prices it like a larger model.

## Three setups on the internal CAD suite

The 15 tasks of `evals/cad` (basic to tier-3 parts, two modifications of a seeded part), 3 runs
each, in three setups: Claude Haiku 5.5 inside Omen Flow (`evals/bench/run.ts --arm omenflow`),
and Claude Haiku 5.5 and Claude Opus 5.5 in plain Claude Code with OpenSCAD available
(`--arm bare`: Read, Write, Edit and `openscad` only; the part is `part.scad`). Prompts are the
suite's, with one delivery sentence per setup. One judge for every setup
(`evals/bench/judge-cadsuite.ts`): the delivered OpenSCAD source is re-rendered independently
and checked against the task's closed-form expectation, its parameter variants and, for
modifications, untouched geometry. Correct means every check passes.

| Setup                        | Parts correct | Tasks correct in all runs | Checks passed | Cost  | Cost per correct part | Median time |
| ---------------------------- | ------------- | ------------------------- | ------------- | ----- | --------------------- | ----------- |
| Haiku 5.5 + Omen Flow        | 43/45 (96%)   | 14/15                     | 793/795       | $0.46 | $0.0106               | 40 s        |
| Haiku 5.5, plain Claude Code | 45/45 (100%)  | 15/15                     | 795/795       | $0.20 | $0.0045               | 19 s        |
| Opus 5.5, plain Claude Code  | 45/45 (100%)  | 15/15                     | 795/795       | $6.80 | $0.1512               | 33 s        |

Both misses are `v-pulley` runs 2 and 3: the cross-section at the sharp groove bottom (z = 8)
measures Ø50 as required but with roundness 0.957 against the suite's 0.97 threshold. All 45
Omen Flow runs called `cad_check`; those two passed the agent's own assertions, which did not
include that section.

The suite does not separate the setups on correctness: every setup is at or near the ceiling.
On these single-part tasks Omen Flow costs about 2.4× plain Claude Code with the same model
(its playbook reads, project record and verification calls) and about 1/14 of Opus 5.5 in
plain Claude Code. Charts: `cad-suite-comparison-dark.png`, `cad-suite-comparison-light.png`.

## Public benchmarks

**CADGenBench, generation (49 engineering drawings → STEP).** Haiku 5.5 in Omen Flow,
submitted as "Stealth Harness + Haiku 5.5 xHigh" (generation only; the 32 editing samples were
left empty and score zero in the aggregate, 0.2565). Generation score **0.424**; 49/49 valid;
shape 0.336, interface 0.412, topology 0.624; $3.96 in total ($0.081 per part). STEP files come
from OpenSCAD's CSG tree rebuilt as exact B-rep in OpenCASCADE (`csg_to_step.py`; 47 exact, 2
sewn from the mesh). For reference on the public board: build123d-mcp + Opus 5.5 (validated)
0.869, Opus 5.5 with the official baseline 0.801, Gemini 3.8 Flash + build123d-mcp 0.487.

**BenchCAD Vision2Code (seeded 100-task sample, voxel IoU).** Haiku 5.5 in Omen Flow 0.630
($4.72); Haiku 5.5 alone with BenchCAD's single-shot CadQuery prompt on the same tasks 0.602
($1.80). The difference (+0.028, 95% CI −0.014 to +0.075) is not significant.

## Limits

- One run per configuration; the internal suite's tasks and the prompts were written by the
  people who built Omen Flow.
- The internal suite measures single parts. It does not measure what Omen Flow is built for:
  requirements held across many steps, change propagation, review and honest completion.
