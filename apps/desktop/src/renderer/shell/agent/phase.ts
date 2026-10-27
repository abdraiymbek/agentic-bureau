/**
 * Which state the agent surface is in. Each state is explicit, so detection is never reported as
 * "not found", and a failed start is shown even when an earlier transcript is on screen.
 */
import type { AdapterStatus, SessionInfo } from '@bureau/contracts';
import type { Detection, StartState } from './agent-store';

export type Phase =
  | { kind: 'read-only' }
  | { kind: 'detecting' }
  | { kind: 'detect-failed'; error: string }
  | { kind: 'none-found'; adapters: AdapterStatus[] }
  /** Several CLIs are installed and none is chosen, or the chosen one is missing. */
  | { kind: 'choose'; options: AdapterStatus[]; missing: AdapterStatus | null }
  | { kind: 'ready'; adapter: AdapterStatus }
  | { kind: 'starting'; adapterId: string }
  | { kind: 'start-failed'; adapterId: string; error: string }
  | { kind: 'live' }
  /** A conversation response runs in this project; one agent works at a time. */
  | { kind: 'conversation-running' }
  | { kind: 'ended' };

export interface PhaseInput {
  readOnly: boolean;
  session: Pick<SessionInfo, 'state' | 'adapterId'> | null;
  adapters: AdapterStatus[];
  detection: Detection;
  start: StartState;
  agentId: string | null;
  /** A turn in this project's conversation pane is running. */
  conversationRunning?: boolean;
}

export function surfacePhase(input: PhaseInput): Phase {
  const { session, start } = input;
  const running = session?.state === 'running' || session?.state === 'starting';
  if (running) return { kind: 'live' };
  if (input.conversationRunning) return { kind: 'conversation-running' };
  if (start.status === 'starting') return { kind: 'starting', adapterId: start.adapterId };
  if (start.status === 'failed')
    return { kind: 'start-failed', adapterId: start.adapterId, error: start.error };
  if (session) return { kind: 'ended' };
  if (input.readOnly) return { kind: 'read-only' };
  if (!input.adapters.length) {
    return input.detection.status === 'failed'
      ? { kind: 'detect-failed', error: input.detection.error }
      : { kind: 'detecting' };
  }
  const available = input.adapters.filter((a) => a.available);
  if (!available.length) {
    // Listed adapters from a previous detection stay on screen while a new one runs.
    return input.detection.status === 'detecting'
      ? { kind: 'detecting' }
      : { kind: 'none-found', adapters: input.adapters };
  }
  const chosen = input.agentId
    ? input.adapters.find((a) => a.adapterId === input.agentId)
    : undefined;
  if (chosen?.available) return { kind: 'ready', adapter: chosen };
  if (!chosen && available.length === 1) return { kind: 'ready', adapter: available[0]! };
  return { kind: 'choose', options: available, missing: chosen ?? null };
}

/** The adapter a surface may start on its own: only an unambiguous, available choice. */
export function autostartAdapter(phase: Phase): string | null {
  return phase.kind === 'ready' ? phase.adapter.adapterId : null;
}
