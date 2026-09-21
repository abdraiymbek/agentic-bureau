/** Bounded wait for the utility process to stop sessions, jobs and SQLite. */
export const UTILITY_QUIT_GRACE_MS = 5000;

export interface UtilityQuitDecision {
  /** Prevent Electron's default quit so the utility can finish. */
  preventDefault: boolean;
  /** First request: send shutdown and arm the forced-kill timer. */
  startShutdown: boolean;
}

/**
 * Decision table for main-process `before-quit`. Forced fallback remains a last
 * resort after this grace period; PTY startup, in-flight CAD and packaged
 * observation are separate native qualifications.
 */
export function utilityQuitDecision(input: {
  shutdownComplete: boolean;
  shutdownRequested: boolean;
  hasUtility: boolean;
}): UtilityQuitDecision {
  if (input.shutdownComplete || !input.hasUtility)
    return { preventDefault: false, startShutdown: false };
  if (input.shutdownRequested) return { preventDefault: true, startShutdown: false };
  return { preventDefault: true, startShutdown: true };
}

export function shouldForceUtilityExit(
  elapsedMs: number,
  graceMs = UTILITY_QUIT_GRACE_MS,
): boolean {
  return elapsedMs >= graceMs;
}
