import { useMemo } from 'react';
import { useStore } from '../../store';
import { sessionCounts } from './activity';
import { useAgentUi } from './agent-store';
import { latestCounts, sessionStatus } from './session-view';
import { offersStarters, starterPrompts } from './starters';

/**
 * What the rail has to show: the session's counts, starter prompts while a fresh session waits
 * for its first instruction, and whether there is nothing at all because the host keeps no
 * activity record.
 */
export function useRailContent() {
  const session = useStore((s) => s.session);
  const project = useStore((s) => s.project);
  const artifacts = useStore((s) => s.artifacts);
  const proposals = useStore((s) => s.proposals);
  const activity = useAgentUi((s) => s.activity);
  const typed = useAgentUi((s) => s.typed);
  const waiting = useAgentUi((s) => s.pending.length);
  const dismissed = useAgentUi((s) => s.startersDismissed);
  const counts = session
    ? latestCounts(
        session,
        sessionCounts(session.id, activity.calls, activity.sessions, activity.summarySeq),
      )
    : null;
  const all = useMemo(
    () => starterPrompts(project, artifacts, proposals),
    [project, artifacts, proposals],
  );
  const offer = offersStarters({
    sessionId: session?.id ?? null,
    live: !!session && sessionStatus(session).live,
    hasInput: typed,
    waiting,
    calls: counts?.calls ?? 0,
    dismissed,
  });
  const starters = offer ? all : [];
  return {
    session,
    activity,
    counts,
    starters,
    idle: activity.status === 'unavailable' && !activity.calls.length && !starters.length,
  };
}
