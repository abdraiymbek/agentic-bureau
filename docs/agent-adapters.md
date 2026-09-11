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

Adapters receive `stark mcp` (MCP stdio) or `stark call <op> --input <file>`
(CLI). The session environment carries `STARK_BRIDGE_SOCK`,
`STARK_BRIDGE_TOKEN`, `STARK_PROJECT_ID`, `STARK_SESSION_ID` — random,
short-lived, per-session credentials. Never written to project files.

## Tested versions

Recorded in `packages/agent-host/src/adapters/*/manifest.ts` and release notes.
