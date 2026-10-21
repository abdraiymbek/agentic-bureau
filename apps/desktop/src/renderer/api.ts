import type { ResponseEnvelope, OmenflowErrorBody } from '@omenflow/contracts';

export interface NativeShutdownRequest {
  requestId: string;
  action: 'close' | 'quit';
}

export interface ChatChange {
  projectId: string;
  seq: number;
}

export interface OmenflowApi {
  command(
    op: string,
    payload: unknown,
    opts?: { projectId?: string; idempotencyKey?: string },
  ): Promise<ResponseEnvelope>;
  setActiveProject(id: string | null): Promise<void>;
  onEvent(cb: (e: unknown) => void): () => void;
  onTerminalData(
    cb: (data: { projectId: string; sessionId: string; chunk: string; seq?: number }) => void,
  ): () => void;
  onTerminalState(cb: (s: unknown) => void): () => void;
  onJobProgress(cb: (d: unknown) => void): () => void;
  onServiceState?(cb: (data: { available: boolean; message?: string }) => void): () => void;
  /** One record per agent tool call, as the host ledger writes it. Not every transport has it. */
  onAgentCall?(cb: (call: unknown) => void): () => void;
  /**
   * A project's conversation record changed. Carries no record: read it with `chat.read`. `seq`
   * grows with every change the host makes. Not every transport has it.
   */
  onChat?(cb: (change: ChatChange) => void): () => void;
  /** Desktop-only: native close/quit must ask about edits before destroying the webview. */
  onShutdownRequest?(cb: (request: NativeShutdownRequest) => void): () => void;
  replyToShutdown?(requestId: string, decision: 'received' | 'cancel' | 'discard'): Promise<void>;
  pickDirectory(title?: string): Promise<string | null>;
  pickFile(opts?: {
    title?: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<string | null>;
  saveFile(opts?: {
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  revealPath(p: string): Promise<void>;
  toggleResearch(): Promise<void>;
}

declare global {
  interface Window {
    omenflow: OmenflowApi;
  }
}

export class CommandError extends Error {
  body: OmenflowErrorBody;
  /** The operation that failed, when the error came from `cmd`. */
  op: string | undefined;
  constructor(body: OmenflowErrorBody, op?: string) {
    super(body.message);
    this.body = body;
    this.op = op;
  }
  get code(): string {
    return this.body.code;
  }
  get repair(): string | undefined {
    return this.body.repair;
  }
}

/** A failed operation as the frame reports it. */
export interface RecoverableCommandError {
  op: string;
  code: string;
  message: string;
  repair?: string;
}

/** Error text for toasts: appends the repair hint when the op provided one. */
export function errMsg(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const repair = e instanceof CommandError ? e.repair : undefined;
  return repair ? `${msg} — ${repair}` : msg;
}

export function formatRecoverableError(error: RecoverableCommandError): string {
  return error.repair ? `${error.message} — ${error.repair}` : error.message;
}

/**
 * Invoke a core op. A refusal from the host and a transport failure both throw a
 * `CommandError` with a stable code. Nothing is reported globally here: the caller decides
 * how to tell the person, and a failure no caller handles reaches the frame as an unhandled
 * rejection, which shows it once.
 */
export async function cmd<T = unknown>(
  op: string,
  payload: unknown = {},
  opts?: { idempotencyKey?: string; projectId?: string },
): Promise<T> {
  let res: Awaited<ReturnType<OmenflowApi['command']>>;
  try {
    res = await window.omenflow.command(op, payload, opts);
  } catch (e) {
    throw new CommandError(
      { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) },
      op,
    );
  }
  if (!res.ok) {
    const body = (res.error as OmenflowErrorBody | undefined) ?? {
      code: 'INTERNAL',
      message: 'unknown error',
    };
    throw new CommandError(body, op);
  }
  return res.result as T;
}
