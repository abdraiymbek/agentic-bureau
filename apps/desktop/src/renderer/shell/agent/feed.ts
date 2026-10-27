/**
 * Loading what the host knows about agents: installed CLIs (`connection.list`) and the call
 * ledger (`agent.activity` for history, `onAgentCall` for live records).
 */
import type { AdapterStatus, AgentActivity } from '@bureau/contracts';
import { useStore } from '../../store';
import { asCallRecord, CALL_LIMIT } from './activity';
import { useAgentUi } from './agent-store';
import { errorText, isUnserved, quiet } from './quiet';

const HISTORY_PAGE = 200;

let detecting: Promise<void> | null = null;
const activityRequests = new Map<string, Promise<void>>();

/** List agent CLIs again. Concurrent calls share one request; the version probes are not free. */
export function detectAgents(): Promise<void> {
  if (detecting) return detecting;
  const ui = useAgentUi.getState();
  ui.setDetection({ status: 'detecting' });
  detecting = quiet<{ adapters: AdapterStatus[] }>('connection.list', {})
    .then((r) => {
      if (r.ok) {
        useStore.getState().set({ adapters: r.result.adapters });
        useAgentUi.getState().setDetection({ status: 'ready' });
      } else {
        useAgentUi.getState().setDetection({ status: 'failed', error: errorText(r.error) });
      }
    })
    .finally(() => {
      detecting = null;
    });
  return detecting;
}

/** Read the most recent calls, or the page before the oldest loaded one. */
export function loadActivity(projectId: string, older = false): Promise<void> {
  const ui = useAgentUi.getState();
  if (ui.projectId !== projectId) return Promise.resolve();
  const key = `${ui.projectEpoch}:${projectId}:${older ? `older:${ui.activity.historyRevision}` : 'latest'}`;
  const pending = activityRequests.get(key);
  if (pending) return pending;
  const request = readActivity(projectId, ui.projectEpoch, older).finally(() => {
    if (activityRequests.get(key) === request) activityRequests.delete(key);
  });
  activityRequests.set(key, request);
  return request;
}

async function readActivity(
  projectId: string,
  projectEpoch: number,
  older: boolean,
): Promise<void> {
  const ui = useAgentUi.getState();
  const visible = ui.activity.history ?? ui.activity.calls;
  const oldest = visible[0]?.seq;
  const historyRevision = ui.activity.historyRevision;
  if (older && oldest === undefined) return;
  if (older) ui.setActivity({ loadingOlder: true });
  if (!older) ui.setActivity({ status: ui.activity.calls.length ? ui.activity.status : 'loading' });
  const r = await quiet<AgentActivity>(
    'agent.activity',
    older ? { limit: HISTORY_PAGE, beforeSeq: oldest } : { limit: HISTORY_PAGE },
    { projectId },
  );
  const now = useAgentUi.getState();
  if (now.projectId !== projectId || now.projectEpoch !== projectEpoch) return;
  // Returning to the latest window while a page waits cancels that browse,
  // including an error from a request the person no longer needs.
  if (older && now.activity.historyRevision !== historyRevision) return;
  if (older) now.setActivity({ loadingOlder: false });
  if (!r.ok) {
    now.setActivity(
      isUnserved(r.error)
        ? { status: 'unavailable', error: null }
        : { status: 'error', error: errorText(r.error) },
    );
    return;
  }
  const calls = (r.result.calls ?? []).map(asCallRecord).filter((c) => c !== null);
  now.addCalls(calls, older ? 'older' : 'latest');
  const page = calls.length >= HISTORY_PAGE;
  now.setActivity({
    status: 'ready',
    error: null,
    ...(older
      ? { hasMore: page }
      : {
          sessions: r.result.sessions ?? [],
          summarySeq: calls.reduce((max, c) => Math.max(max, c.seq), 0),
          hasMore: page,
          latestHasMore: page || useAgentUi.getState().activity.calls.length >= CALL_LIMIT,
        }),
  });
}

/** Live records for this project. Returns the unsubscribe, or null when the host has no channel. */
export function subscribeCalls(projectId: string): (() => void) | null {
  const subscribe = window.bureau.onAgentCall;
  if (!subscribe) return null;
  return subscribe((value) => {
    const call = asCallRecord(value);
    if (!call || (call.projectId && call.projectId !== projectId)) return;
    const ui = useAgentUi.getState();
    if (ui.projectId !== projectId) return;
    ui.addCalls([call], 'live');
  });
}
