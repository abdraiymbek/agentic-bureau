# Agent adapters

Shipped adapters: **Codex CLI**, **Claude Code**, **Custom CLI**.

Each adapter owns: executable discovery, version check, launch args,
project-scoped tool configuration, bootstrap context delivery, optional resume.

## Contract

```ts
interface AgentAdapter {
  id: string;
  label: string;
  discover(): Promise<AdapterStatus>;
  launchSpec(ctx): { path: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string };
  prepareProjectConfig(projectDir): Promise<() => void>; // returns restore fn
  resumeArgs?(session): string[] | null;
}
```

## Tool access

Adapters receive `omenflow mcp` (MCP stdio) or `omenflow call <op> --input <file>`
(CLI). The session environment carries `OMENFLOW_BRIDGE_SOCK`,
`OMENFLOW_BRIDGE_TOKEN`, `OMENFLOW_PROJECT_ID`, `OMENFLOW_SESSION_ID` — random,
short-lived, per-session credentials. Never written to project files.

`omenflow call <op> --help` prints an op's purpose and input JSON schema
(backed by the `tool.describe` op), so CLI-only agents are not left guessing.

### Which ops become tools

Every `capability: 'both'` op is granted to the session, but only ops with
`agentVisible: true` are listed as MCP tools. Ops superseded by a clearer tool
(`cad.render`, `cad.probe`, `cad.validate_source`, `job.*`, `tool.list`) stay
callable via `omenflow call` and the GUI but do not appear in the agent's tool
vocabulary. Field-level `.describe()` text on op schemas becomes JSON-schema
descriptions in `tools/list`. Schemas avoid zod tuples: tuple JSON schemas are
rejected by some model-side validators and silently drop the tool.

### Approval

MCP tools are registered with annotations (`readOnlyHint` for non-mutating
ops, `destructiveHint: false`, `openWorldHint: false`) because every op is
already gated by Omen Flow's capability + proposal model — agents only create
drafts. Without annotations Codex treats every MCP call as needing approval
(prompt per call in the TUI; hard denial under `approval_policy=never`). The
Codex adapter additionally passes
`mcp_servers.omenflow.default_tools_approval_mode="approve"`.

## Bootstrap context

At session start `writeBootstrapBrief()` writes
`.omenflow/work/<session>/bootstrap.md` (project intent, requirements,
assumptions, work queues, artifact index) **and** keeps `<project>/AGENTS.md`
current with the Omen Flow agent guide (`adapters/guide.ts`). Agent CLIs read
`AGENTS.md` from the working directory on their own; that is the one channel
that reliably reaches the model without the user pasting anything. A
user-authored `AGENTS.md` is preserved and the guide is appended below a
marker.

The guide is short and general: the project/revision model, the
write → report → check → repeat loop that earns "done", and the OpenSCAD
conventions that most often produce wrong-but-rendering geometry.

## Tested versions

Recorded in `packages/agent-host/src/adapters/*/manifest.ts` and release notes.
