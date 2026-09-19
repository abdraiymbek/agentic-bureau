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

## Tested versions

Recorded in `packages/agent-host/src/adapters/*/manifest.ts` and release notes.
