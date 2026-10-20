import { useEffect, useState } from 'react';
import { cmd, errMsg } from '../../api';
import { ASK_PREFIX } from './rank';
import type { ContentResults } from './content';

type SearchState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; value: ContentResults }
  | { status: 'error'; message: string };

/** Query/project ownership prevents an earlier answer from appearing under a later query. */
export function useContentSearch(projectId: string | null, raw: string) {
  const query = raw.trim();
  const enabled = !!projectId && query.length > 0 && !query.startsWith(ASK_PREFIX);
  const [attempt, setAttempt] = useState(0);
  const [slot, setSlot] = useState<{
    projectId: string;
    query: string;
    state: SearchState;
  } | null>(null);
  useEffect(() => {
    if (!projectId || !enabled) return;
    let active = true;
    const timer = setTimeout(() => {
      setSlot({ projectId, query, state: { status: 'loading' } });
      void cmd<ContentResults>('project.search', { query, limit: 20 }, { projectId }).then(
        (value) => {
          if (active) setSlot({ projectId, query, state: { status: 'ready', value } });
        },
        (error: unknown) => {
          if (active)
            setSlot({ projectId, query, state: { status: 'error', message: errMsg(error) } });
        },
      );
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [projectId, query, enabled, attempt]);
  const state: SearchState = !enabled
    ? { status: 'idle' }
    : slot?.projectId === projectId && slot.query === query
      ? slot.state
      : { status: 'loading' };
  return { state, retry: () => setAttempt((n) => n + 1) };
}
