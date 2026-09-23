# omenflow-bridge

Production `omenflow` helper binary — the agent-facing bridge client shipped
inside the Omen Flow app bundle. Agent CLIs launched by the agent host inherit
`OMENFLOW_BRIDGE_SOCK` / `OMENFLOW_BRIDGE_TOKEN` / `OMENFLOW_PROJECT_ID` /
`OMENFLOW_SESSION_ID` and use this binary to reach the running app.

```
omenflow call <op> --input <file|'-'> [--idempotency-key k]
omenflow mcp
```

- `call` — one request/response envelope; result JSON on stdout, errors as
  JSON on stderr with exit code 2 (`APP_NOT_RUNNING` when the socket is
  unreachable), usage errors exit 3.
- `mcp` — after the handshake, pumps newline-delimited JSON-RPC between
  stdin/stdout and bridge frames; exits when the socket closes.

Wire protocol (must stay identical to `packages/agent-host/bin/omenflow.mjs`
and `packages/contracts/src/protocol.ts`): 4-byte little-endian length +
JSON frames, `protocolVersion: 1`, hello → welcome → envelopes (call) or
JSON-RPC frames (mcp).

## Build

```
cargo build --release   # produces target/release/omenflow
# or from the repo root: pnpm build:bridge
```

When `target/release/omenflow` exists, the desktop build copies it into the
app bundle as `resources/core/omenflow` and it lands on the agent session's
PATH. Without a cargo build the packaging falls back to
`packages/agent-host/bin/omenflow.mjs` (`node bin/omenflow.mjs ...`), a
self-contained equivalent — same wire protocol.
