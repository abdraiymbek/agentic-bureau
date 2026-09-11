# stark-bridge

Production `stark` helper binary — the agent-facing bridge client shipped
inside the STARK app bundle. Agent CLIs launched by the agent host inherit
`STARK_BRIDGE_SOCK` / `STARK_BRIDGE_TOKEN` / `STARK_PROJECT_ID` /
`STARK_SESSION_ID` and use this binary to reach the running app.

```
stark call <op> --input <file|'-'> [--idempotency-key k]
stark mcp
```

- `call` — one request/response envelope; result JSON on stdout, errors as
  JSON on stderr with exit code 2 (`APP_NOT_RUNNING` when the socket is
  unreachable), usage errors exit 3.
- `mcp` — after the handshake, pumps newline-delimited JSON-RPC between
  stdin/stdout and bridge frames; exits when the socket closes.

Wire protocol (must stay identical to `packages/agent-host/bin/stark.mjs`
and `packages/contracts/src/protocol.ts`): 4-byte little-endian length +
JSON frames, `protocolVersion: 1`, hello → welcome → envelopes (call) or
JSON-RPC frames (mcp).

## Build

```
cargo build --release   # produces target/release/stark
```

The release binary is packaged with the app and placed on the agent
session's PATH. During development, `packages/agent-host/bin/stark.mjs`
(`node bin/stark.mjs ...`) is a self-contained equivalent — no build needed.
