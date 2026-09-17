import { Channel } from "@tauri-apps/api/core";

import type { TerminalChunk } from "./pty";
import { invoke } from "./transport";

export interface AgentProviderDto {
  id: string;
  name: string;
  command: string;
  available: boolean;
  path: string | null;
  prompt_style: "positional" | "flag" | string;
}

export interface AgentsDetectResponse {
  providers: AgentProviderDto[];
}

export interface AgentOpenRequest {
  vault_id: string;
  provider: string;
  cwd?: string | undefined;
  command?: string | undefined;
  prompt?: string | undefined;
  cols: number;
  rows: number;
}

export interface AgentOpenResponse {
  agent_id: string;
  cwd: string;
}

export interface AgentChangeDto {
  path: string;
  status: "added" | "modified" | "deleted" | string;
}

export interface AgentChangesResponse {
  changes: AgentChangeDto[];
  provider: string;
  cwd: string;
  started_at: number;
}

export interface AgentDiffResponse {
  path: string;
  status: string;
  old: string | null;
  new: string | null;
}

export function agentsDetect(): Promise<AgentsDetectResponse> {
  return invoke<AgentsDetectResponse>("agents_detect", {});
}

export function agentOpen(
  req: AgentOpenRequest,
  onOutput: (chunk: TerminalChunk) => void,
): Promise<AgentOpenResponse> {
  const channel = new Channel<TerminalChunk>();
  channel.onmessage = onOutput;
  return invoke<AgentOpenResponse>("agent_open", { req, onOutput: channel });
}

export function agentChanges(agentId: string): Promise<AgentChangesResponse> {
  return invoke<AgentChangesResponse>("agent_changes", { agentId });
}

export function agentDiff(
  agentId: string,
  path: string,
): Promise<AgentDiffResponse> {
  return invoke<AgentDiffResponse>("agent_diff", { agentId, path });
}

export function agentClose(agentId: string): Promise<void> {
  return invoke("agent_close", { agentId });
}
