import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ArtifactView, Revision } from '@omenflow/contracts';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import {
  LATEST_WORK,
  resolveDisplayedRevision,
  revisionRole,
  type RevisionPick,
  type RevisionRole,
} from '../lib/mechanical-revisions';
import { requestLeave } from '../lib/unsaved-edits';

/**
 * One object's revisions as every part of the object level sees them: the loaded history,
 * what the person asked to see, and the revision that is on screen because of it.
 */
export interface ObjectRevisions {
  /** Loaded history; null until the first load returns. */
  revisions: Revision[] | null;
  baselineId: string | null;
  pick: RevisionPick;
  displayed: Revision | null;
  role: RevisionRole | null;
  error: string | null;
  /** Show something else. Asks first when an editor holds unsaved edits. */
  choose: (pick: RevisionPick) => void;
  /** Read the history and the project record again. */
  reload: () => Promise<void>;
  /** A save went through as this revision: follow the record and put it on screen. */
  saved: (revisionId: string) => Promise<void>;
  /** An editor with unsaved edits keeps its base revision on screen until it lets go. */
  hold: (slot: string, revisionId: string | null) => void;
}

const Context = createContext<ObjectRevisions | null>(null);

export const ObjectRevisionsProvider = Context.Provider;

/** Keeps the objects of revisions that did not change, so nothing downstream sees churn. */
function shareRevisions(previous: Revision[] | null, next: Revision[]): Revision[] {
  if (!previous) return next;
  const known = new Map(previous.map((r) => [r.id, r]));
  const shared = next.map((r) => {
    const old = known.get(r.id);
    return old && old.reviewState === r.reviewState ? old : r;
  });
  return shared.length === previous.length && shared.every((r, i) => r === previous[i])
    ? previous
    : shared;
}

/** Loads and resolves the revisions of the object in focus. Used once, by the object view. */
export function useRevisionHistory(view: ArtifactView | undefined, id: string): ObjectRevisions {
  const projectId = useStore((s) => s.projectId);
  const owner = `${projectId}:${id}`;
  const [loaded, setLoaded] = useState<{ owner: string; revisions: Revision[] } | null>(null);
  const [pick, setPick] = useState<RevisionPick>(LATEST_WORK);
  const [holds, setHolds] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const shown = useRef<Revision | null>(null);

  const fetchHistory = useCallback(async (): Promise<Revision[] | null> => {
    const token = ++request.current;
    try {
      const r = await cmd<{ revisions: Revision[] }>(
        'artifact.history',
        { artifactId: id },
        { projectId: projectId ?? undefined },
      );
      // A newer request owns the screen; this one still answers whoever awaited it.
      if (token === request.current) {
        setLoaded((previous) => ({
          owner,
          revisions: shareRevisions(
            previous?.owner === owner ? previous.revisions : null,
            r.revisions,
          ),
        }));
        setError(null);
      }
      return r.revisions;
    } catch (e) {
      if (token === request.current) setError(errMsg(e));
      return null;
    }
  }, [id, projectId, owner]);

  // The store replaces `view` after every project change that could touch this object.
  const exists = !!view;
  useEffect(() => {
    if (exists) void fetchHistory();
  }, [view, exists, fetchHistory]);

  const revisions = loaded?.owner === owner ? loaded.revisions : null;
  const baselineId = view?.artifact.selectedRevisionId ?? null;
  const heldId = Object.values(holds)[0] ?? null;
  const resolved = useMemo(() => {
    if (!revisions) return null;
    const held = heldId ? revisions.find((r) => r.id === heldId) : undefined;
    if (held)
      return { revision: held, role: revisionRole(held, revisions, baselineId), pending: false };
    return resolveDisplayedRevision(revisions, baselineId, pick);
  }, [revisions, baselineId, pick, heldId]);
  // While the history is behind the store, keep what was on screen rather than flash another.
  if (resolved && !resolved.pending) shown.current = resolved.revision;
  const displayed = resolved && !resolved.pending ? resolved.revision : shown.current;
  const role =
    resolved && !resolved.pending
      ? resolved.role
      : displayed && revisions?.some((r) => r.id === displayed.id)
        ? revisionRole(displayed, revisions, baselineId)
        : null;

  const reload = useCallback(async () => {
    const { refreshArtifacts, refreshProposals } = useStore.getState();
    await Promise.all([fetchHistory(), refreshArtifacts(), refreshProposals()]);
  }, [fetchHistory]);

  const saved = useCallback(
    async (revisionId: string) => {
      setPick(LATEST_WORK);
      const { refreshArtifacts, refreshProposals } = useStore.getState();
      const [history] = await Promise.all([fetchHistory(), refreshArtifacts(), refreshProposals()]);
      if (!history?.some((r) => r.id === revisionId)) return;
      const baseline =
        useStore.getState().artifacts.find((v) => v.artifact.id === id)?.artifact
          .selectedRevisionId ?? null;
      // When "latest work" does not land on what was just recorded, show it by name.
      if (resolveDisplayedRevision(history, baseline, LATEST_WORK).revision?.id !== revisionId)
        setPick({ kind: 'revision', id: revisionId });
    },
    [fetchHistory, id],
  );

  const choose = useCallback(
    (next: RevisionPick) => requestLeave(() => setPick(next), 'show another revision'),
    [],
  );
  const hold = useCallback((slot: string, revisionId: string | null) => {
    setHolds((current) => {
      if ((current[slot] ?? null) === revisionId) return current;
      const next = { ...current };
      if (revisionId) next[slot] = revisionId;
      else delete next[slot];
      return next;
    });
  }, []);

  return useMemo(
    () => ({ revisions, baselineId, pick, displayed, role, error, choose, reload, saved, hold }),
    [revisions, baselineId, pick, displayed, role, error, choose, reload, saved, hold],
  );
}

/**
 * The revisions of the object a stage belongs to. A stage rendered on its own (a test, a
 * catalogue specimen) sees only the revision it was given.
 */
export function useObjectRevisions(view: ArtifactView): ObjectRevisions {
  const provided = useContext(Context);
  const standalone = useMemo<ObjectRevisions>(() => {
    const revisions = view.revision ? [view.revision] : [];
    const baselineId = view.artifact.selectedRevisionId;
    const refresh = async () => {
      const { refreshArtifacts, refreshProposals } = useStore.getState();
      await Promise.all([refreshArtifacts(), refreshProposals()]);
    };
    return {
      revisions,
      baselineId,
      pick: LATEST_WORK,
      displayed: view.revision,
      role: view.revision ? revisionRole(view.revision, revisions, baselineId) : null,
      error: null,
      choose: () => {},
      reload: refresh,
      saved: refresh,
      hold: () => {},
    };
  }, [view.revision, view.artifact.selectedRevisionId]);
  return provided ?? standalone;
}
