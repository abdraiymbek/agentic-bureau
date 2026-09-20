# Omen Flow architecture

## Processes

```text
renderer (React, sandboxed)  ──narrow preload──▶  main (Electron)
                                                    │ MessagePort
                                              core utility process
                                          (commands, SQLite, graph, jobs,
                                           PTY sessions, MCP server)
                                                    │
              agent CLI (PTY)   OpenSCAD (child)   calc worker
                    │
            omenflow bridge (stdio/MCP or JSON CLI)
                    │
            authenticated local socket → core
```

## Packages

- `packages/contracts` — entities, ops, error codes, protocol, units. Pure
  zod + types; zero runtime deps beyond zod.
- `packages/storage` — SQLite repository, migrations, content-addressed
  object store, materialization, export/import primitives.
- `packages/core` — every command/query handler. GUI, MCP, and CLI all call
  the same dispatcher. Proposals, decisions, graph, freshness, BOM, jobs.
- `packages/agent-host` — node-pty session manager + agent adapters
  (Codex CLI, Claude Code, Custom CLI), bridge socket server.
- `packages/mcp-server` — MCP protocol server bound to core handlers.
- `packages/engineering` — OpenSCAD adapter, restricted calculation engine,
  wiring checks, research/source capture helpers.
- `packages/ui` — design tokens + shared components for the renderer.
- `apps/desktop` — Electron app: `src/main`, `src/preload`, `src/renderer`,
  `src/utility` (core host entry).
- `native/omenflow-bridge` — Rust stdio/CLI → local socket forwarder.

## Invariants

- A revision is immutable; edits produce new revisions with parents.
- Only the human path resolves proposals (`proposal.approve` is user-only).
- Freshness is derived from recorded inputs vs selected upstream revisions.
- Unknown values stay `null` with a reason — never `0`.
- Terminal bytes are not project state; structured ops are.
