# Bureau architecture

One Rust host type serves the desktop app, a headless loopback server and agents. The renderer
and every agent reach the same core through it, so the path that ships is the path the tests
exercise.

## Processes

```text
Desktop (apps/rust-desktop)                         Headless (apps/headless, bureau-host)
┌───────────────────────────────────────────┐      ┌────────────────────────────────────────┐
│ main webview: Lens renderer               │      │ loopback HTTP: POST /api/command       │
│   invoke("bureau_command") ─┐           │      │                GET  /api/events (SSE)  │
│   listen("bureau:*") ◀──────┤           │      │                /api/agent/*, /health   │
│ research webview (isolated,   │           │      │                     │                  │
│   no app IPC)                 ▼           │      │                     ▼                  │
│                    Host (crates/agent-host) ◀───── the same Host, EventSink → SSE         │
│                      │ user-origin commands      └────────────────────────────────────────┘
│                      ▼                    │
│        bureau_core::dispatch_shared ──────▶ OpenSCAD child processes (lock released)
│                      ▲                    │
│   BridgeServer ── dispatch_agent ─────────┤
│      ▲  local socket <app-data>/run/bridge.sock (0600), token per session
│      │                                    │
│   PtyHost ── agent CLI in a PTY ── bureau helper (mcp | call)
└───────────────────────────────────────────┘
```

- **Desktop.** `apps/rust-desktop` implements the host's traits for Tauri: `EventSink` (emits
  `bureau:event`, `bureau:terminal:data`, `bureau:terminal:state`,
  `bureau:agent:call`), `Shell` (reveal a path, open an http/https/mailto link in the system
  browser) and `ResearchSurface` (a hidden, incognito webview for reading public pages). It
  also owns the window, the navigation guard, window state, the macOS menu, the quit
  confirmation while an agent runs, and one running app per data directory (the
  single-instance plugin for the default directory, a lock file under `run/` for a directory
  named by `BUREAU_APP_DATA_DIR`).
- **Headless.** `bureau-host --app-data <dir>` serves the same command surface on
  `127.0.0.1` with a bearer token, and server-sent events (`event`, `terminal-data`,
  `terminal-state`, `agent-call`, with replay by `Last-Event-ID`). Research and shell operations
  answer `TOOL_MISSING`. It backs `pnpm design:preview`, `pnpm test:conformance`, the fixtures,
  `pnpm smoke:headless` and the agent evaluations (`POST /api/agent/launch` returns the exact
  launch plan a terminal session would get).
- **Agents.** A CLI runs in a PTY with four variables (`BUREAU_BRIDGE_SOCK`,
  `BUREAU_BRIDGE_TOKEN`, `BUREAU_PROJECT_ID`, `BUREAU_SESSION_ID`). It reaches Bureau
  through the bundled `bureau` helper: `bureau mcp` (MCP over stdio) or `bureau call`
  (one operation). The helper opens the local socket, sends a hello with the token, and frames
  JSON requests. A relative data folder is made absolute before the socket is named. On Windows
  the bridge is a named pipe per data folder (`bureau-<user>-<hash of the data folder>`); that
  path has been unit-tested for its name only, never built or run on Windows.

## Two entries into the core

**User origin** (the renderer, the headless API): `Host::command(op, payload, projectId,
idempotencyKey)` validates the operation name, then routes it — `research.*` and `browser.*` to
the research surface, `connection.*`, `terminal.*`, `proposal.wait`, `guide.read`,
`agent.activity` and `tool.call` to the host, everything else to the core — and returns a
`ResponseEnvelope` (`{requestId, ok, result | error}`). A panic becomes an `INTERNAL` error and
the core lock is recovered.

**Agent origin** (MCP or `bureau call`): every call goes through `dispatch_agent` in
`crates/agent-host/src/lib.rs`, the single funnel. It resolves the tool name in any form,
refuses operations that are not agent-allowed (`CAPABILITY_DENIED`), applies lossless reported
input repairs (`parse_agent_input`), asks compact sessions' operations for brief results,
shapes and bounds the result for the session's profile, and records the call in the ledger.
See [agent adapters](agent-adapters.md).

Both reach `bureau_core::dispatch_shared(_with_events)` (`crates/core/src/shared.rs`). Ordinary
operations run under the core lock. CAD operations are planned under the lock, run OpenSCAD and
the mesh analysis with the lock released, and commit under the lock (failing with
`INPUT_CHANGED` if the part moved meanwhile), so the person's reads answer while an agent's
render runs. Each recorded event is delivered once, with `projectId`, through a per-project
delivery cursor.

## Crates and apps

| Path                   | Contents                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/contracts`     | `registry.json` (generated from `packages/contracts`) with every operation's capability, mutation flag, agent visibility, tier, pack, summary, example and schemas; `parse_input`, `parse_agent_input`, `ContractError` with `repair` and `details.issues`, nearest-match suggestions                                                                                           |
| `crates/storage`       | `ProjectHandle` (create, open, read-only snapshot for newer markers), `schema_v1.sql`, `ObjectStore` (SHA-256, 64 MiB per file), path resolution that refuses paths outside the project (including through symlinks) and working-file writes into `.bureau/` or the marker                                                                                                      |
| `crates/core`          | `CoreApp` and `dispatch`; revisions and review (`review.rs`), transactions (`txn.rs`), events (`events.rs`), idempotency, freshness graph, CAD (`cad/`: engine, render cache, params, checks, verification, mesh, sections), calculations, components and BOM, wiring, test results, build package, archives, `work.status` (`gate.rs`), `project.coverage`, search, `units.rs` |
| `crates/agent-host`    | `Host` and its traits (`host.rs`), research routing (`host/research.rs`), `BridgeServer` and `dispatch_agent` (`lib.rs`), `PtyHost` (`pty.rs`), adapters, launch plans (`session.rs`), profiles, presentation (`present.rs`), MCP (`mcp.rs`), ledger, playbooks (`guide.rs`, `guides/*.md`)                                                                                     |
| `apps/rust-desktop`    | Tauri shell (`main.rs`, `window.rs`, `research.rs`, `capture.rs`, `signals.rs`, `instance.rs`, `smoke.rs`)                                                                                                                                                                                                                                                                      |
| `apps/headless`        | `bureau-host` (`server.rs` routes and checks, `http.rs` the HTTP/1.1 parser, `events.rs` the SSE hub)                                                                                                                                                                                                                                                                           |
| `native/bureau-bridge` | The `bureau` helper; its own Cargo workspace                                                                                                                                                                                                                                                                                                                                    |
| `apps/desktop`         | The renderer: `src/renderer/` (see [the design specification](../design-system/design.md) §10), Vite configs, `index.html` with the content security policy                                                                                                                                                                                                                     |

The renderer imports only types and the dependency-free entry points `@bureau/contracts/format`
and `@bureau/contracts/chat` from the contracts package, never its runtime barrel. It
talks to a host through `window.bureau` (`api.ts`): `tauri-api.ts` on the desktop,
`preview.ts` against the design preview's proxy to `bureau-host`.

## The legacy TypeScript implementation

`packages/core`, `storage`, `agent-host`, `mcp-server` and `engineering` are the TypeScript
implementation that shipped in the Electron build. They are not in the Tauri bundle. They stay
as a behaviour oracle: `pnpm test` runs the domain suites against them, and
`tests/conformance/` runs the same kind of corpus against the Rust host. Operations and inputs
only Rust implements (`RUST_HOST_OPS`, `assertLegacyInputs` in `packages/core/src/dispatch.ts`,
and `RUST_HOST_AGENT_OPS` for an agent's call) are refused there with a typed `VALIDATION` error
naming the Rust host, so the oracle never reports work it did not do, and its MCP server does not
list them. `pnpm eval:cad` and `pnpm eval:workflows` still drive this stack;
`evals/agent` drives the Rust host.

## Invariants

- A revision is immutable; an edit is a new revision with its parent. An update that names no
  revision continues the open draft that includes the baseline (else the baseline); a revision
  that starts a second line retires the open draft, and the result names it in `warnings`.
- Only a person resolves proposals or changes a baseline (`proposal.approve`, `reject`,
  `request_changes`, `artifact.accept_draft`, `apply_edit`, `revert`, `archive` are user-only).
- Approval is refused when the baseline moved since the change was drafted; a proposal whose
  objects a newer proposal covers is superseded, and so is one whose candidate a draft accepted
  as the new baseline already contains (`impact.answeredByRevisionId`).
- Freshness is derived from recorded inputs against the selected upstream revisions, recomputed
  in the same transaction as the change and reconciled when a project opens.
- Unknown values stay unknown with a reason; quantities keep their units.
- Terminal bytes are not project state. Agent calls are recorded in a ledger beside it, without
  their arguments.
