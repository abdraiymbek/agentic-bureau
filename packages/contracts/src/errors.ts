/** Stable error codes shared across IPC, bridge, MCP, and UI. */
export const ErrorCodes = {
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  TOOL_MISSING: 'TOOL_MISSING',
  INVALID_UNITS: 'INVALID_UNITS',
  MISSING_SOURCE: 'MISSING_SOURCE',
  INPUT_CHANGED: 'INPUT_CHANGED',
  PATH_OUTSIDE_PROJECT: 'PATH_OUTSIDE_PROJECT',
  CONNECTION_DENIED: 'CONNECTION_DENIED',
  JOB_INTERRUPTED: 'JOB_INTERRUPTED',
  CYCLE_DETECTED: 'CYCLE_DETECTED',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  CAPABILITY_DENIED: 'CAPABILITY_DENIED',
  APP_NOT_RUNNING: 'APP_NOT_RUNNING',
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
  ARCHIVE_INVALID: 'ARCHIVE_INVALID',
  UNSUPPORTED_SCHEMA: 'UNSUPPORTED_SCHEMA',
  MIXED_CURRENCY: 'MIXED_CURRENCY',
  READ_ONLY: 'READ_ONLY',
  BUSY: 'BUSY',
  CANCELLED: 'CANCELLED',
  TIMEOUT: 'TIMEOUT',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface OmenflowErrorBody {
  code: ErrorCode;
  message: string;
  /** Concrete repair action shown to the user/agent, e.g. 'Select agent executable'. */
  repair?: string;
  details?: unknown;
}

export class OmenflowError extends Error {
  readonly code: ErrorCode;
  readonly repair?: string;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, opts?: { repair?: string; details?: unknown }) {
    super(message);
    this.name = 'OmenflowError';
    this.code = code;
    this.repair = opts?.repair;
    this.details = opts?.details;
  }

  toBody(): OmenflowErrorBody {
    return { code: this.code, message: this.message, repair: this.repair, details: this.details };
  }

  static from(err: unknown): OmenflowError {
    if (err instanceof OmenflowError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new OmenflowError(ErrorCodes.INTERNAL, message);
  }

  static fromBody(body: OmenflowErrorBody): OmenflowError {
    return new OmenflowError(body.code, body.message, {
      repair: body.repair,
      details: body.details,
    });
  }
}

export function toErrorBody(err: unknown): OmenflowErrorBody {
  return OmenflowError.from(err).toBody();
}
