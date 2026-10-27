# bureau-bridge

Production `bureau` helper binary — the agent-facing bridge client shipped
inside the Bureau app bundle. Agent CLIs launched by the agent host inherit
`BUREAU_BRIDGE_SOCK` / `BUREAU_BRIDGE_TOKEN` / `BUREAU_PROJECT_ID` /
`BUREAU_SESSION_ID` and use this binary to reach the running app.

```
bureau mcp
bureau call <tool> [--input <file|-|json>] [--idempotency-key k] [--pretty]
bureau call <tool> --help
bureau guide [topic]
bureau status [--scope session|project]
bureau help
```

- `mcp` — after the handshake, pumps newline-delimited JSON-RPC between
  stdin/stdout and bridge frames; exits when either side closes. A malformed
  input line is reported on stderr and skipped.
- `call` — one request/response envelope. `<tool>` may be a tool name
  (`cad_check`) or an operation name (`cad.check`); the app resolves both and
  any letter case. `--input` is optional for tools without arguments and takes
  a file, `-` for standard input, or inline JSON (`--input '{"artifactId":"…"}'`).
  The result is compact JSON on stdout (`--pretty` indents it). A failure is
  one JSON line on stderr carrying the app's `code`, `message`, `repair` and
  `details` (validation `issues`, an `example` of a valid call, `notes` of
  repairs already applied), exit code 2.
- `call <tool> --help` — the tool's schema and an example (`tool_describe`).
  `bureau call tool_describe` with no input lists every tool.
- `guide [topic]` — prints a playbook as text (`guide_read`), then the list of
  topics. Without a topic it prints the start guide.
- `status` — the completion gate (`work_status`): what is unfinished and the
  exact next call for each item. Run it before saying the work is done.

Exit codes: 0 ok · 2 bridge or app error (`APP_NOT_RUNNING` when no session
credentials are set or the socket is unreachable) · 3 usage.

Wire protocol (must stay identical to `packages/agent-host/bin/bureau.mjs`
and `packages/contracts/src/protocol.ts`): 4-byte little-endian length +
JSON frames, `protocolVersion: 1`, hello → welcome → envelopes (call) or
JSON-RPC frames (mcp).

## Build

```
cargo build --release --locked   # produces target/release/bureau
# or from the repo root: pnpm build:bridge
```

`apps/rust-desktop/tauri.conf.json` copies `target/release/bureau` into the
app bundle's resource root as `bureau`; the agent host puts its folder first
on the agent session's PATH and names it by absolute path in each CLI's MCP
configuration.

## Test

```
cargo test --locked    # this crate is outside the workspace; no CARGO_TARGET_DIR
```

The agent host's test `the_built_helper_reaches_the_bridge_both_ways`
(`cargo test -p bureau-agent-host -- --ignored`) runs the built helper
against a real bridge.
