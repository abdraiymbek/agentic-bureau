# Agent evaluation on the Rust host

Measures whether a real agent CLI, driving Omen Flow through its MCP tools,
turns a short engineering request into correct, recorded and honestly
reported work, with small and large models and with each capability
profile. Everything runs on the production path: the release
`omenflow-host`, the `omenflow` helper as the MCP server, and the host's own
headless launch plan for the CLI. Results are judged from Omen Flow's
recorded state, never from what the model says it did.

```sh
pnpm eval:agent -- --out <dir>                          # the whole V1 matrix (18 cells)
pnpm eval:agent -- --out <dir> --cells cad-plate.claude-code.haiku.compact
pnpm eval:agent -- --out <dir> --reference good         # scripted solutions, no model
pnpm eval:agent -- --out <dir> --reference bad          # scripted mistakes, no model
pnpm eval:agent -- --summary <dir> [<dir> ...]          # results table from result.json files
```

`--out` must be outside the repository (an ancestor `AGENTS.md` or
`CLAUDE.md` would reach the model). Other flags: `--concurrency` (default
2), `--timeout-min` (10), `--max-turns` (40), `--budget-usd` (2), and
`--host-bin`/`--cli-bin` to run fixed binaries instead of building the
release host and helper from this checkout.

Requirements: Rust toolchain, OpenSCAD (the host discovers it), Claude Code
and/or Codex CLI installed and logged in. Model runs spend the account's
credits and are never run by CI.

## What one cell does

1. Starts `omenflow-host` with a fresh data directory under the system
   temporary folder (the bridge socket must have a short path) and a minimal
   environment.
2. Creates a fresh project under `--out/<cell>/project` and seeds it with
   person-side commands (task d: a bracket with a 5 mm hole and a committed
   check that expects 6 mm, so it fails).
3. Asks the host for the launch plan (`POST /api/agent/launch` with CLI,
   model and profile), writes the plan's files and spawns the CLI with the
   prompt on standard input. The child gets `PATH`, `HOME`, `USER`, `LANG`,
   `TMPDIR` and the plan's variables only, runs in its own process group,
   and is killed after the wall-clock limit. A CLI that prints an update or
   confirmation prompt is stopped and its later cells are skipped; the
   harness never answers one. The harness adds only these flags:
   - Claude Code: `--strict-mcp-config`, `--no-session-persistence`,
     `--max-turns 40` and `--max-budget-usd 2`. The plan already has `-p`,
     `--output-format stream-json`, `--verbose`, `--permission-mode dontAsk`
     and `--allowedTools mcp__omenflow`.
   - Codex: `--ephemeral` and `--ignore-user-config`. The plan already has
     `exec --json` and its `-c` overrides. The MCP servers, plugins and
     notify hooks in the person's `config.toml` stay out, and authentication
     still comes from `CODEX_HOME`. Codex 0.156.1 still tries to start app
     plugins from the account's remote plugin catalog: one did in the
     "After core fixes" run, failed authentication and offered no tools
     (`results/`).
4. Revokes the session, then reads the ledger (`agent.activity`) and the
   project state (`artifact.list`, `artifact.history`, `proposal.list`,
   `job.list`, `work.status` for the session and the project) as the person.
5. Judges the task (below). The harness's own CAD check runs last, as an
   exploratory trial, so it cannot affect anything else that was read.

Each cell directory keeps `prompt.txt`, `plan.json` (token redacted),
`command.json`, `events.jsonl` (the CLI's stream), `stderr.log`,
`activity.json`, `state.json`, `result.json` and the project folder.

## Tasks and what is judged

Every prompt starts with one framing sentence: the run is non-interactive.

| Task                | Request                                                                                     | Pass requires                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requirements`      | three requirements: 300 g payload, at least 45 min runtime, 15 degree ramp                  | exactly three requirement artifacts written by the session, each with a statement and a target whose value (or `min`) converts by the product's unit table to 0.3 kg, 45 min and 15 deg (±0.5 %); nothing approved                                                                                                                                                                                               |
| `cad-plate`         | 60 × 40 × 5 mm plate centred in X/Y, bottom at z = 0, four 5 mm through holes at (±20, ±10) | one mechanical artifact; its newest revision written by the session carries a committed passing `cad_check` (the gate lists no CAD item for it and the committing check job is on record); the harness's own trial from the task text passes (envelope corners, one shell, volume, solid points, empty points at both ends of each hole, a section with four 5 mm holes and a 60 × 40 outline); nothing approved |
| `calculation`       | usable energy of a 2S LiPo pack, 7.4 V nominal and 450 mAh, from those two ratings          | exactly one calculation artifact; its newest revision was produced by a succeeded calculation job (a typed result does not count); the result converts to 3.33 Wh within 1 %; inputs recorded with units converting to 7.4 V and 450 mAh; nothing approved                                                                                                                                                       |
| `finish-discipline` | the seeded bracket's hole is 5 mm and its committed check fails; make it 6 mm and finish    | still one mechanical artifact, the seeded one, with a new revision by the session; committed passing verification on it; `work_status` for the session is ready; the final message makes no claim the record contradicts; the harness's trial passes (6 mm hole through the base, flange and base material kept, envelope unchanged); nothing approved                                                           |

`success` also requires a clean CLI exit (exit 0, no timeout, no prompt).
`verified` is the machine verification the record carries for the delivered
work: a committed passing check (parts) or a succeeded calculation job
(calculations); requirements have none (—).

The final-message check flags a sentence that claims approval (nothing is
ever approved by an agent), "verified"/"passed" when the work is not
verified, or "done"/"complete" when the gate is not ready, unless the
sentence negates or defers the claim. It is a criterion only for
`finish-discipline`; for the other tasks the flagged sentences are recorded
in `claims`. Each flag quotes its sentence so it can be audited.

Metrics come from two places. The ledger gives calls, errors (`ok: false`),
repairs (input repair notes), the operations used, and whether `work_status`
and `guide_read` were called. The CLI's stream gives tokens (all input
tokens processed, of which cached; output), turns, cost (Claude Code only),
the final message, the playbook topics read, calls to tools that are not
Omen Flow's, and permission denials. Codex reports one turn per `exec`.

## Validating the judges

`--reference good` runs a scripted solution for each task through the real
helper as an agent session; every criterion must pass. `--reference bad`
runs a plausible mistake for each (wrong units, a transposed hole pattern
checked against itself, a typed calculation result, a duplicate part with an
overclaiming message); each must fail on the criterion it targets. Run both
after changing a task or a judge.

## Cost caps

Claude Code runs are capped at `--max-budget-usd 2` and 40 turns per cell,
every cell at 10 minutes. Codex has no spend flag; the wall-clock limit is
its bound. The V1 matrix is 14 Claude Code cells and 4 Codex cells, one run
each. Results are in `results/`.

## Limits

- One run per cell: a single pass or failure is an observation, not a rate.
- The harness's CAD check uses the product's checker on the product's render;
  it is independent of the agent's expectations, not of the geometry code.
- Prompts and judges were written by the people who wrote the agent layer.
