import {
  agentClose,
  agentOpen,
  type AgentOpenRequest,
} from "../api/agents";
import { terminalResize, terminalWrite, type TerminalExit } from "../api/pty";
import { decodeChunk } from "../pty/chunk";
import { sizeChanged, type TerminalSize } from "../pty/resize";

export interface AgentSessionHandlers {
  onBytes: (bytes: Uint8Array) => void;
  onExit: (exit: TerminalExit | null) => void;
}

export interface AgentSession {
  id: string;
  write: (data: string) => void;
  resize: (size: TerminalSize) => void;
  close: () => Promise<void>;
}

export async function openAgentSession(
  req: AgentOpenRequest,
  size: TerminalSize,
  handlers: AgentSessionHandlers,
): Promise<AgentSession> {
  let ended = false;
  let sent: TerminalSize | null = size;

  const end = (exit: TerminalExit | null): void => {
    if (ended) return;
    ended = true;
    handlers.onExit(exit);
  };

  const { agent_id: id } = await agentOpen(
    { ...req, cols: size.cols, rows: size.rows },
    (chunk) => {
      if (chunk.base64 !== "") handlers.onBytes(decodeChunk(chunk.base64));
      if (chunk.exit !== undefined && chunk.exit !== null) end(chunk.exit);
    },
  );

  return {
    id,
    write: (data) => {
      if (ended) return;
      void terminalWrite(id, data).catch(() => end(null));
    },
    resize: (next) => {
      if (ended || !sizeChanged(sent, next)) return;
      sent = next;
      void terminalResize(id, next.cols, next.rows).catch(() => end(null));
    },
    close: async () => {
      ended = true;
      await agentClose(id).catch(() => {});
    },
  };
}
