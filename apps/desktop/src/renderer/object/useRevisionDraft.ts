import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArtifactView, Revision } from '@bureau/contracts';
import { CommandError, errMsg } from '../api';
import { useStore } from '../store';
import { newestActiveRevision } from '../lib/mechanical-revisions';
import {
  commitDraft,
  dirtyFields,
  discardDraft,
  editDraft,
  editability,
  keepEdits,
  lockReasonText,
  openDraft,
  receiveRevision,
  reloadBase,
  underneathChanges,
  type DraftState,
  type FormShape,
  type UnderneathChange,
} from '../lib/revision-draft';
import { unsavedEdits } from '../lib/unsaved-edits';
import { useObjectRevisions } from './revisions';

export interface RevisionDraft<F extends FormShape> {
  form: F;
  edit: (patch: Partial<F>) => void;
  dirty: boolean;
  dirtyFields: (keyof F & string)[];
  /** The field differs from what the base revision records. */
  changed: (field: keyof F & string) => boolean;
  busy: boolean;
  /** Why the last save did not go through. Cleared by the next edit. */
  error: string | null;
  canEdit: boolean;
  /** Why editing is off, in words; null while it is on. */
  lock: string | null;
  /** The revision the edits are based on. */
  base: Revision | null;
  /** Saves and resolves to the new revision id, or null when nothing was recorded. */
  save: () => Promise<string | null>;
  discard: () => void;
  /** A different revision arrived underneath unsaved edits: what changed, and the way out. */
  incoming: {
    revision: Revision | null;
    changes: UnderneathChange[];
    /** The whole form on each side, for showing a changed value in its context. */
    was: F;
    now: F;
  } | null;
  keepEdits: () => void;
  /** These edits were left unsaved earlier and have been brought back. */
  restored: boolean;
}

interface Options<F extends FormShape> {
  /** The object with the revision on screen. */
  view: ArtifactView;
  /** Names what is being edited in prompts: "requirement". */
  label: string;
  /** Tells apart two editors on one object. */
  slot?: string;
  /** Which revision the core accepts as a base: the baseline, or the newest active one. */
  anchor?: 'baseline' | 'newest';
  /**
   * The form as a revision records it. Null means that is not known yet (its file is still
   * loading); the editor then waits instead of comparing against a guess.
   */
  toForm: (revision: Revision | null) => F | null;
  /** What an editor shows before its revision's content is known. */
  empty?: F;
  /** The first thing wrong with the form, or null. Checked before every save. */
  check?: (form: F) => string | null;
  /** Records the form on top of `base` and returns the new revision's id. */
  save: (form: F, base: Revision, edited: (keyof F & string)[]) => Promise<string | null>;
  /** Changes when the recorded form of the same revision becomes known (a file finished loading). */
  baseVersion?: unknown;
}

/**
 * Form state for one editor, held apart from incoming data. A background refresh, an agent
 * drafting the same object or a moved baseline never resets what the person is typing: a
 * changed base is set beside the edits until they choose.
 */
export function useRevisionDraft<F extends FormShape>(options: Options<F>): RevisionDraft<F> {
  const { view, label, slot = 'stage', anchor = 'baseline' } = options;
  const revisions = useObjectRevisions(view);
  const readOnly = useStore((s) => s.readOnly);
  const projectId = useStore((s) => s.projectId);
  const key = `${projectId}:${view.artifact.id}:${slot}`;
  const latest = useRef(options);
  latest.current = options;

  const [parked] = useState(() => {
    const entry = unsavedEdits.peek(key);
    return entry && !entry.mounted ? (entry.snapshot as DraftState<F>) : null;
  });
  const [state, setState] = useState<DraftState<F>>(
    () =>
      parked ??
      openDraft(
        view.revision?.id ?? null,
        options.toForm(view.revision) ?? options.empty ?? ({} as F),
      ),
  );
  const [restored, setRestored] = useState(!!parked);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const edited = dirtyFields(state);
  const dirty = edited.length > 0;
  const history = revisions.revisions ?? [];
  const anchorRevision =
    anchor === 'baseline'
      ? (history.find((r) => r.id === revisions.baselineId) ?? null)
      : newestActiveRevision(history);
  // A clean form follows what is on screen. A dirty one watches the revision its save must
  // be based on, so a moved base is noticed before the save rather than refused after it.
  const target = dirty ? anchorRevision : view.revision;
  const targetId = target?.id ?? null;
  const waiting = dirty && !target;

  useEffect(() => {
    if (waiting) return;
    setState((s) => {
      const form = latest.current.toForm(target);
      if (form === null) return s;
      const next = receiveRevision(s, targetId, form);
      return next === s && s.baseRevisionId === targetId ? reloadBase(s, form) : next;
    });
    // The target's content is immutable; only its identity and the base version matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, waiting, options.baseVersion]);

  const { hold } = revisions;
  const heldId = dirty ? state.baseRevisionId : null;
  useEffect(() => {
    hold(slot, heldId);
    return () => hold(slot, null);
  }, [hold, slot, heldId]);

  const registered = useRef(false);
  useEffect(() => {
    if (dirty) {
      unsavedEdits.put({ key, label, mounted: true, snapshot: state });
      registered.current = true;
    } else {
      registered.current = false;
      unsavedEdits.drop(key);
    }
  }, [dirty, state, key, label]);
  useEffect(() => () => unsavedEdits.park(key), [key]);
  useEffect(
    () =>
      unsavedEdits.subscribe(() => {
        // Someone answered "discard" to a leave request: the edits are gone from the record.
        if (!registered.current || unsavedEdits.peek(key)) return;
        registered.current = false;
        setState(discardDraft);
        setRestored(false);
        setError(null);
      }),
    [key],
  );

  const permission = editability({
    readOnly,
    displayed: view.revision,
    anchorId: anchorRevision?.id ?? null,
    anchor,
  });
  const canEdit = !readOnly && (permission.canEdit || dirty);
  const base = history.find((r) => r.id === state.baseRevisionId) ?? view.revision;

  const edit = useCallback((patch: Partial<F>) => {
    setState((s) => editDraft(s, patch));
    setError(null);
  }, []);

  const discard = useCallback(() => {
    setState(discardDraft);
    setRestored(false);
    setError(null);
  }, []);

  const keep = useCallback(() => {
    setState(keepEdits);
    setError(null);
  }, []);

  const save = async (): Promise<string | null> => {
    if (busy || !dirty || state.incoming || !base) return null;
    const problem = latest.current.check?.(state.form) ?? null;
    if (problem) {
      setError(problem);
      return null;
    }
    const form = state.form;
    setBusy(true);
    setError(null);
    try {
      const revisionId = await latest.current.save(form, base, edited);
      if (!revisionId) return null;
      setState(commitDraft(revisionId, form));
      setRestored(false);
      await revisions.saved(revisionId);
      return revisionId;
    } catch (e) {
      if (e instanceof CommandError && e.code === 'REVISION_CONFLICT') {
        // Bring the record up to date; the moved base then shows beside the kept edits.
        await revisions.reload().catch(() => {});
        setError(
          `Not saved, and your edits are kept. The record changed underneath this edit (${e.message}).`,
        );
      } else {
        setError(errMsg(e));
      }
      return null;
    } finally {
      setBusy(false);
    }
  };

  return {
    form: state.form,
    edit,
    dirty,
    dirtyFields: edited,
    changed: (field) => edited.includes(field),
    busy,
    error,
    canEdit,
    lock: canEdit || !permission.reason ? null : lockReasonText(permission.reason),
    base,
    save,
    discard,
    incoming: state.incoming
      ? {
          revision: history.find((r) => r.id === state.incoming!.revisionId) ?? null,
          changes: underneathChanges(state),
          was: state.base,
          now: state.incoming.base,
        }
      : null,
    keepEdits: keep,
    restored: restored && dirty,
  };
}
