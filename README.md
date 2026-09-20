# Omen Flow

A local desktop engineering workspace: bring an existing AI coding/agent CLI
(Codex CLI, Claude Code, or any command-line tool) into a persistent local
engineering project. The agent runs in a real embedded terminal; structured
artifacts — requirements, components, calculations, CAD, wiring, tests — live
in the project, reviewed by a human before they become the baseline.

State lives in the project folder (`.omenflow/state.sqlite`), not in the agent's
conversation. Close the app, reopen the project, export it as a portable
archive — the engineering record survives the chat.

## What it is

- **Electron desktop app** — React renderer, dark/light workspaces, real PTY
  terminal (xterm.js + node-pty), STL viewport, inspector, review queue,
  BOM table, dependency graph.
- **Core domain layer** — every operation (GUI, MCP, CLI) goes through one
  `CoreApp.dispatch` surface with zod validation, capability enforcement,
  idempotency, and revision-conflict detection.
- **Engineering memory** — immutable artifact revisions, draft → proposed →
  approved/rejected review flow, explicit dependency edges, stale
  propagation with explanation paths, provenance on every sourced fact.
- **Agent bridge** — agents reach the project through a local unix socket
  (named pipe on Windows) via the `omenflow` CLI shim (`omenflow call <op>`,
  `omenflow mcp`) or an MCP server. Every change an agent proposes is a
  reviewable proposal; nothing self-approves.
- **Adapters** — Codex CLI, Claude Code, and a generic custom-CLI adapter;
  OpenSCAD as the first CAD tool (detected on the system, never bundled).

## Design system

The Omen Flow redesign covers the project launcher, engineering workspace,
agent/inspector panels, object editors, reviews, impact, delivery, and settings.
Read [design-system/design.md](design-system/design.md) before building new UI.
Tokens, fonts, brand assets, a live component catalog, and captured reference
screens are included. [AGENTS.md](AGENTS.md) makes this the shared design contract.

```sh
pnpm design:preview      # populated, disposable projects at http://127.0.0.1:5173
```

Open `/design-system/` on the preview server for the screen presentation.
The browser preview uses the real renderer and core; native agent execution
is disabled. Its example mesh is illustrative, not a verified CAD render.
Legacy `@omenflow` package names, `.omenflow` project storage, bridge commands, and
installer names remain compatible; the UI display name is Omen Flow.

## Layout

```
apps/desktop            Electron app (main, preload, renderer, utility proc)
packages/contracts      Entities, ops registry, units, bridge protocol
packages/storage        SQLite persistence, object store, path safety
packages/core           Dispatch, artifacts, proposals, graph, BOM, jobs
packages/engineering    OpenSCAD adapter, mathjs calc engine, wiring analyzer
packages/agent-host     PTY sessions, adapters, bridge server, CLI shim
packages/mcp-server     MCP tools riding the bridge
native/omenflow-bridge     Rust bridge helper (source; Node shim ships for dev)
fixtures/               Rover + drone reference fixtures (see fixtures/README)
design-system/          Canonical design, tokens, fonts, brand, screen references
tests/                  Golden-path integration suite
scripts/                Native rebuild + packaged smoke harnesses
```

## Develop

```sh
pnpm install
pnpm rebuild:node        # build better-sqlite3/node-pty for the Node ABI
pnpm test                # vitest suite (incl. golden-path fixtures)
pnpm typecheck && pnpm lint && pnpm format:check
pnpm dev                 # run the desktop app (Electron)
```

The natives have two ABIs in play: **Node** for vitest/scripts,
**Electron** for the packaged app. `pnpm package` rebuilds for Electron and
then restores the Node copies (see `apps/desktop/forge.config.ts`).

## Build and verify a package

```sh
pnpm package             # Electron Forge → out/Omen Flow-<platform>-<arch>/
pnpm smoke:packaged      # launch it, wait for the bridge, real `omenflow call`
pnpm make                # installers (DMG on macOS, Squirrel on Windows)
```

## Fixtures

```sh
pnpm fixture:rover /tmp/my-rover    # inspection rover reference project
pnpm fixture:drone /tmp/my-drone    # payload→propulsion→endurance chain
```

Both build through the real dispatch surface: requirements, sourced and
assumption-labeled components, review-approved selections, BOM, OpenSCAD
tray source, unit-aware calculations, wiring, and a test procedure. The
golden-path test then raises the rover payload requirement 300 g → 500 g
and checks that dependent artifacts go stale without losing history.

## CI

`.github/workflows/ci.yml` runs the unit suite on Ubuntu, packages + smokes
on macOS, packages on Windows (smoke step reports but doesn't gate yet), and
`cargo fmt`/`clippy` on the bridge helper. Node is pinned to 24 (`.nvmrc`),
pnpm to 9.15.9 (`packageManager` field).

## Status and limits

See `BUILD_STATUS.md` for the ledger — what's verified locally, what CI
covers, and what still needs real OpenSCAD / agent-CLI / Windows runs.
Fixture data is recorded, not live: `[fixture-recorded]` excerpts are not
release evidence.
