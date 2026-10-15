import { useCallback, useEffect, useState } from 'react';
import { errMsg } from '../api';
import type { LoadState } from './guard';
import type { ProposalDetail } from './model';
import { quietCmd } from './io';

/** Last read of each proposal, so a revisit shows it at once while it is read again. */
const CACHE_LIMIT = 30;
const cache = new Map<string, ProposalDetail>();

/** After a decision: the last read no longer describes the proposal. */
export function forgetDetail(projectId: string, id: string) {
  cache.delete(`${projectId}:${id}`);
}

function remember(key: string, d: ProposalDetail) {
  cache.delete(key);
  cache.set(key, d);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

interface Slot {
  key: string | null;
  detail: ProposalDetail | null;
  load: LoadState;
  error: string;
}

/**
 * `proposal.read` for the proposal on screen. It reads again only when `version` changes (a
 * cheap key from list data) or on `reload`, and keeps the previous read on screen meanwhile,
 * so a background refresh never blanks the review or resets what the person was doing.
 */
export function useProposalDetail(projectId: string | null, id: string | null, version: string) {
  const key = projectId && id ? `${projectId}:${id}` : null;
  const [slot, setSlot] = useState<Slot>({ key: null, detail: null, load: 'loading', error: '' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key || !projectId || !id) return;
    let cancelled = false;
    setSlot((s) => {
      const shown = s.key === key ? s.detail : (cache.get(key) ?? null);
      return { key, detail: shown, load: shown ? 'refreshing' : 'loading', error: '' };
    });
    quietCmd<ProposalDetail>('proposal.read', { proposalId: id }, { projectId })
      .then((d) => {
        if (cancelled) return;
        remember(key, d);
        setSlot({ key, detail: d, load: 'ready', error: '' });
      })
      .catch((e) => {
        if (cancelled) return;
        setSlot((s) => {
          const shown = s.key === key ? s.detail : null;
          return { key, detail: shown, load: shown ? 'refresh_failed' : 'error', error: errMsg(e) };
        });
      });
    return () => {
      cancelled = true;
    };
  }, [key, projectId, id, version, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  // Until the effect catches up with a new id, show the cached read (or nothing), never the
  // previous proposal under the new one's name.
  if (!key) return { detail: null, load: 'ready' as LoadState, error: '', reload };
  if (slot.key !== key) {
    const cached = cache.get(key) ?? null;
    return {
      detail: cached,
      load: (cached ? 'refreshing' : 'loading') as LoadState,
      error: '',
      reload,
    };
  }
  return { detail: slot.detail, load: slot.load, error: slot.error, reload };
}
