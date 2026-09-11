# STARK build ledger

Updated continuously during implementation. This file reflects the actual
state of the repository, not the plan.

## Completed systems

- Repository skeleton: pnpm workspace (hoisted linker), TypeScript strict,
  ESLint/Prettier, vitest root config, Apache-2.0 + community docs.
- `packages/contracts`: entity schemas, operation registry with capability
  split (agent vs user ops), stable error codes, units/quantities (incl.
  acceleration dim), bridge protocol (frames, hello/welcome, env keys,
  IPC channel names), session/adapter status types.
- `packages/storage`: SQLite schema + migrations (better-sqlite3), typed
  Repo, content-addressed object store, project create/open/reopen,
  `stark.project.json` marker, event log, idempotency table, stale records,
  materialization, backup, path-safety (PATH_OUTSIDE_PROJECT, symlink
  resolution), session rows. 6 tests pass.
- `packages/core`: single `dispatch()` for GUI/MCP/CLI (zod validation,
  capability enforcement, idempotency, REVISION_CONFLICT), revision
  lifecycle (immutable history, draft/approved/superseded), proposals +
  decisions + human-only resolution, eval-graph (depends_on/derived_from/
  validates acyclic, cycle path reporting) with stale propagation +
  explanation paths + recorded inputs, components/offers/BOM with
  provenance + unknown-stays-unknown totals, CAD job pipeline (adapter
  injected, INPUT_CHANGED commit check, job.cancel → adapter), calculations,
  wiring, sources/research via host interface, build preview + ZIP export,
  project archive export/import (traversal-guarded), external-edit watcher
  → drafts, bounded project.summary, FTS5 search. 10 domain tests pass,
  incl. 300 g → 500 g propagation and reopen persistence.
- `packages/engineering`: OpenScadAdapter (discovery: app bundle, brew,
  login-shell PATH, Windows paths, flatpak; probe does a real cube render;
  `-D` params; SIGTERM→SIGKILL cancel; STL inspect ascii+binary+bounds),
  MathJsCalcEngine (worker_threads isolation, restricted mathjs, unit-aware
  scope, 4 templates), WiringAnalyzer (voltage/ground/exclusive-pin/
  unknown-pin/moved-component + SVG diagram). 29 tests pass.

- `packages/agent-host`: real PTY via node-pty (bounded scrollback,
  session persistence), adapter registry (codex/claude/custom with
  launchSpec env + STARK_* scrubbing), framed-JSON bridge server over
  unix socket (named pipe on Windows), grant/token auth, `stark` Node
  CLI shim (`call`, `mcp`, `cap` commands).
- `packages/mcp-server`: MCP SDK server riding bridge frames — tools/list
  + tools/call mapped onto core ops with capability checks.
- `apps/desktop`: Electron Forge + Vite; main process (windows, window-state
  persistence, IPC relay, research WebContentsView, security policy,
  single-instance lock), preload (narrow contextBridge, typed API),
  utility process hosting CoreApp + bridge + PTY + MCP, renderer
  (welcome/create/open, overview, requirements, components+BOM, reviews,
  artifacts, history/graph, files, connections, terminal w/ xterm+PTY,
  STL viewport w/ three.js, inspector, command palette, status bar).

## Packaging (verified on this machine)

- `pnpm --filter @stark/desktop package` → `out/STARK-darwin-arm64/STARK.app`.
- `pnpm --filter @stark/desktop make` → `out/make/STARK.dmg` +
  `out/make/zip/darwin/arm64/STARK-darwin-arm64-0.1.0.zip`.
- Utility bundle lives at `resources/core/utility.js` (asar-unpacked —
  `utilityProcess.fork` cannot run inside asar); `calc-worker.mjs` and the
  `stark` shim ship beside it; `mathjs` + runtime dep closure vendored to
  `resources/node_modules` by `scripts/vendor-natives.mjs`, which also
  rebuilds better-sqlite3/node-pty for the Electron ABI.
- Boot smoke: packaged app launches, utility forks, better-sqlite3 loads
  (Electron ABI), bridge socket binds, `ready` reaches main.
  Evidence: `boot.log` under userData + `[core] ready` on stdout.

## Unresolved implementation problems

- No Rust toolchain on this machine: `native/stark-bridge` source is
  written per plan; the compiled helper cannot be produced here. The
  `stark` Node shim provides identical `call`/`mcp` commands in dev.
  Deviation: bridge ships as JS now; Rust helper compiles where cargo
  exists (CI).
- No OpenSCAD installed locally: adapter implements the full
  detect/probe/render/inspect contract; real-render e2e gated on
  `STARK_OPENSCAD_E2E`.
- No Windows machine: `Setup.exe` build + verification deferred to CI;
  paths are written cross-platform.
- No Claude Code installed locally: adapter + missing-exe path implemented;
  live launch unverified here.
- `calc-worker.mjs` is copied beside the utility bundle at
  `resources/core/` and resolves `mathjs` from `resources/node_modules`
  (vendored closure; unpacked from asar).
- better-sqlite3 pinned to `^13` (napi): v12.x crashed Node 24 during
  env teardown (`Assertion failed: (env) != nullptr` in `~Statement`).
  Forge's "Preparing native dependencies" rebuilds the hoisted copy to
  Electron ABI, so `postPackage` runs `scripts/rebuild-natives.mjs node`
  to restore the workspace copies — `pnpm test` needs Node ABI,
  the app needs Electron ABI, both live under different roots.

## Golden-path status

Domain level proven: draft→proposal→approve→baseline→propagation all work
in vitest. Not yet exercised inside the running Electron app or with a
live agent CLI.

## Failing tests

None.

## Platform verification

- macOS arm64 (dev): storage/core/engineering/agent-host/mcp suites pass;
  desktop `package` + `make` verified; packaged app boot-smoked.
- Windows x64: not verifiable on this machine.

## Deviations from Plan.md

1. Rust bridge not compiled in this environment (no cargo). Node shim used
   for dev/test; Rust source kept under `native/stark-bridge`.
2. `torque_load` takes `g` and `accel` as real `m/s^2` inputs (an
   `acceleration` dimension was added to contracts) instead of the
   originally planned formula-with-embedded-g — same physics, better
   provenance.

## Next highest-leverage work

- Finish agent-host + MCP integration, then run the real Codex golden path
  in the packaged app; then fixtures/tests; then packaging + hardening.
