import { invoke } from "./transport";

export interface TerminalExit {
  code: number | null;
  signal: string | null;
}

export interface TerminalChunk {
  base64: string;
  exit?: TerminalExit | null;
}

export function terminalWrite(terminalId: string, data: string): Promise<void> {
  return invoke("terminal_write", { terminalId, data });
}

export function terminalResize(
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("terminal_resize", { terminalId, cols, rows });
}

export function terminalBusy(terminalId: string): Promise<boolean> {
  return invoke<boolean>("terminal_busy", { terminalId });
}

export function terminalClose(terminalId: string): Promise<void> {
  return invoke("terminal_close", { terminalId });
}
