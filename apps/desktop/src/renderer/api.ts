import type { ResponseEnvelope, StarkErrorBody } from '@stark/contracts';

export interface StarkApi {
  command(op: string, payload: unknown, opts?: { projectId?: string; idempotencyKey?: string }): Promise<ResponseEnvelope>;
  setActiveProject(id: string | null): Promise<void>;
  onEvent(cb: (e: unknown) => void): () => void;
  onTerminalData(cb: (chunk: string) => void): () => void;
  onTerminalState(cb: (s: unknown) => void): () => void;
  onJobProgress(cb: (d: unknown) => void): () => void;
  pickDirectory(title?: string): Promise<string | null>;
  pickFile(opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  saveFile(opts?: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  revealPath(p: string): Promise<void>;
  toggleResearch(): Promise<void>;
}

declare global {
  interface Window {
    stark: StarkApi;
  }
}

export class CommandError extends Error {
  body: StarkErrorBody;
  constructor(body: StarkErrorBody) {
    super(body.message);
    this.body = body;
  }
  get code(): string {
    return this.body.code;
  }
  get repair(): string | undefined {
    return this.body.repair;
  }
}

/** Invoke a core op; throws CommandError with stable code on failure. */
export async function cmd<T = unknown>(op: string, payload: unknown = {}, opts?: { idempotencyKey?: string; projectId?: string }): Promise<T> {
  const res = await window.stark.command(op, payload, opts);
  if (!res.ok) throw new CommandError((res.error as StarkErrorBody | undefined) ?? { code: 'INTERNAL', message: 'unknown error' });
  return res.result as T;
}
