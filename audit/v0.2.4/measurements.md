# Omen Flow 0.2.4 benchmark measurements

Measured on 22 October 2026 on one Apple M5 Mac with Claude Code 2.1.287 at `--effort xhigh`,
Claude Haiku 5.5 (`claude-haiku-5-5`) and OpenSCAD 2026.09.18. Every setup is a single run per
task unless stated, and several benchmarks shared the machine, so times are inflated and noisy.
Costs are recomputed from each run's token usage at list price (Haiku 5.5: $0.10 / $0.50 per
million input / output tokens up to 100K-token prompts; cache writes 1.25×, cache reads 0.1×);
the CLI's own cost field is not used. The harness is `evals/bench/run.ts` from the benchmark
work of 21 October (not part of this repository), run with the 0.2.3 host (main at 6572c34)
and a 0.2.4 host built from `release/0.2.4`.

Which 0.2.4 build:

- CAD suite: `db377e4`, the merged tree before the drawing guidance was tuned. The tuning
  changed only the drawing step of the CAD playbook and the image size default, which these
  single-part tasks do not use.
- BenchCAD and drawings, "tuned": `6f3a1c3`, which has the release's agent guidance. Later
  commits fix review findings (gate scope, STEP export, conversation continuation, docs) and
  change no agent-facing tool or text used here.

## A judge correction first

The CAD-suite judge (`evals/bench/judge-cadsuite.ts`, built on the legacy TypeScript checks)
moved a section plane that ran through mesh vertices by 1e-6 mm, the size of its own point grid.
At the bottom ring of a revolved V-groove the outline then lost corners: a 64-facet Ø50 circle
read as roundness 0.957 against the 0.97 limit. That was the cause of the two `v-pulley` misses
reported on 21 October; the parts were round (0.999 at z = 7.99 and 8.001). Fixed in this
release (`packages/core/src/mesh.ts`, with a regression test). All figures below use the
corrected judge, and the 21 October runs were re-judged with it.

## Internal CAD suite (15 tasks × 2 runs, same machine load)

| Setup                    | Correct | Cost per correct part | Median time | Median tool calls | Playbook reads   |
| ------------------------ | ------- | --------------------- | ----------- | ----------------- | ---------------- |
| Omen Flow 0.2.3          | 30/30   | $0.0107               | 45.9 s      | 8                 | 92 (`parts`: 28) |
| Omen Flow 0.2.4          | 30/30   | $0.0085               | 38.3 s      | 1                 | 2                |
| Plain Claude Code, Haiku | 30/30   | $0.0049               | 24.1 s      | 3                 | n/a              |

Re-judged 21 October runs (3 runs per task): Omen Flow on the 14 October host 45/45 (it was
reported as 43/45), plain Claude Code with Haiku 45/45, with Opus 45/45.

In 0.2.4 a part is usually written and checked in one `cad_write_source` call, and no playbook
is read on the CAD path. Cost per correct part falls by about a fifth and stays about 1.7× plain
Claude Code's: the Omen Flow session prompt is larger (≈25K cache-write tokens per run against
≈14K) and the agent writes more (≈9K output tokens against ≈4K: spec items with their
assertions, and a final answer that states the recorded state).

## Drawings (8 CADGenBench drawings, framing without "act through tool calls")

| Setup                   | Parts | Median time | Cost per drawing | Bash crop attempts | `image_view` per drawing | Runs using `cad_view` |
| ----------------------- | ----- | ----------- | ---------------- | ------------------ | ------------------------ | --------------------- |
| Omen Flow 0.2.3         | 8/8   | 234 s       | $0.063           | 5 runs             | n/a                      | n/a                   |
| Omen Flow 0.2.4 (first) | 8/8   | 449 s       | $0.195           | 0                  | 7.5                      | 2                     |
| Omen Flow 0.2.4 (tuned) | 8/8   | 383 s       | $0.174           | 0                  | 6.1                      | 6                     |

No drawing stopped early on either host (the finding-5 early stop did not reproduce). These
drawings were not scored: CADGenBench scores only through its own service, which was not used.

## BenchCAD (34 of the 100-task sample, every third task, voxel IoU)

| Setup                                          | Mean IoU | Parts | Cost per task | Median time |
| ---------------------------------------------- | -------- | ----- | ------------- | ----------- |
| Plain Haiku 5.5, single-shot CadQuery (21 Oct) | 0.601    | 34/34 | n/a           | n/a         |
| Omen Flow, 14 October host (21 Oct)            | 0.655    | 34/34 | n/a           | n/a         |
| Omen Flow 0.2.3, run 1                         | 0.700    | 34/34 | $0.064        | 212 s       |
| Omen Flow 0.2.3, run 2                         | 0.571    | 34/34 | $0.051        | 184 s       |
| Omen Flow 0.2.4 (first build)                  | 0.717    | 32/34 | $0.106        | 314 s       |
| Omen Flow 0.2.4 (tuned)                        | 0.752    | 34/34 | $0.110        | 339 s       |

Paired against the mean of the two 0.2.3 runs, tuned 0.2.4 scores +0.117 IoU (bootstrap 95 %
interval +0.048 to +0.185; better on 26 tasks, worse on 8). Run-to-run noise is large: the two
0.2.3 runs differ by 0.13 in the mean and by 0.20 per task on average. The first 0.2.4 build
lost two tasks to the 12-minute task limit while re-reading the composite image; after the
tuning (at most three crops, then a `cad_view` comparison with the drawing) agents compared
their part with the views in 30 of 34 runs and none timed out. 0.2.4 costs about twice as much
per task, mostly image tokens.

## Not measured

- CADGenBench scores (shape, interface, topology) and the editing track (STEP import is not in
  0.2.4).
- Repeat runs beyond those shown; no confidence statement is made for the CAD suite or the
  drawings.
- Codex, or any model other than Claude Haiku 5.5.
