import { ErrorCodes, OmenflowError } from '@omenflow/contracts';
import type { ProjectContext } from './context.js';

/** Newest historical terminal rows kept in the live project. Older rows are pruned. */
export const SESSION_DATA_KEEP_LAST = 2000;
export const TERMINAL_EXPORT_CONSENT_META = 'terminal.exportConsent';

export function pruneHistoricalSessionData(ctx: ProjectContext): number {
  if (ctx.readOnly) return 0;
  return ctx.repo.tx(() => ctx.repo.pruneSessionData(SESSION_DATA_KEEP_LAST));
}

export function terminalExportConsent(ctx: ProjectContext): boolean {
  return ctx.repo.meta(TERMINAL_EXPORT_CONSENT_META) === 'true';
}

export function setTerminalExportConsent(ctx: ProjectContext, granted: boolean): void {
  ctx.assertWritable();
  ctx.repo.tx(() => {
    ctx.repo.setMeta(TERMINAL_EXPORT_CONSENT_META, granted ? 'true' : 'false');
    ctx.emit('project.export_consent', 'user', {
      kind: 'terminal_history',
      granted,
    });
  });
}

export function assertTerminalExportAllowed(
  ctx: ProjectContext,
  includeTerminalHistory: boolean,
  grantConsent: boolean,
): boolean {
  if (!includeTerminalHistory) return false;
  if (grantConsent) setTerminalExportConsent(ctx, true);
  if (!terminalExportConsent(ctx)) {
    throw new OmenflowError(
      ErrorCodes.VALIDATION,
      'Terminal history is excluded from ordinary archives until export consent is granted',
      {
        repair:
          'Pass grantTerminalExportConsent with includeTerminalHistory, or export without it.',
      },
    );
  }
  return true;
}
