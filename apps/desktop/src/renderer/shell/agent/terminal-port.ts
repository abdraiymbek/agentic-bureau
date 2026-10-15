/**
 * What the rest of the renderer may ask of the open project's terminal. It lives apart from the
 * engine so that actions and the store can reach the terminal without loading xterm.
 */
export interface TerminalPort {
  readonly projectId: string;
  /**
   * Paste as the person would, never submitting: bracketed when the CLI asked for it, otherwise on
   * one line so no line break acts as Enter. False when input is off.
   */
  paste(text: string): boolean;
  /** Raw input after everything already queued, such as the Return that submits a paste. */
  write(data: string): Promise<void>;
  /** The CLI has shown its prompt: bracketed paste is on and output has settled. */
  readyForInput(): boolean;
  /** Columns and rows the terminal shows, measured now when it is visible. */
  size(): { cols: number; rows: number } | null;
  focus(): void;
}

let current: TerminalPort | null = null;

export function setTerminalPort(port: TerminalPort | null, owner?: TerminalPort): void {
  // A disposed engine only clears the port if it still holds it.
  if (port === null && owner && current !== owner) return;
  current = port;
}

export function terminalPort(projectId: string | null): TerminalPort | null {
  return current && projectId && current.projectId === projectId ? current : null;
}
