/** Keep in lockstep with `packages/core/src/lifecycle.ts`. */
export const UTILITY_QUIT_GRACE_MS = 5000;

export function utilityQuitDecision(input: {
  shutdownComplete: boolean;
  shutdownRequested: boolean;
  hasUtility: boolean;
}): { preventDefault: boolean; startShutdown: boolean } {
  if (input.shutdownComplete || !input.hasUtility)
    return { preventDefault: false, startShutdown: false };
  if (input.shutdownRequested) return { preventDefault: true, startShutdown: false };
  return { preventDefault: true, startShutdown: true };
}
