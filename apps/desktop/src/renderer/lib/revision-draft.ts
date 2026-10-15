/**
 * The edit model every stage shares. What the person is typing (`form`) is held apart from
 * what the record says (`base`), so nothing that arrives from the project — a refresh, an
 * agent drafting the same object, a moved baseline — can overwrite an unsaved edit.
 */

export type FormShape = Record<string, unknown>;

export interface DraftState<F extends FormShape> {
  /** The revision the edits are based on; a save names it as the base. */
  baseRevisionId: string | null;
  /** The form as that revision records it. */
  base: F;
  /** The form as the person left it. */
  form: F;
  /** A different revision arrived underneath unsaved edits and waits for a choice. */
  incoming: { revisionId: string; base: F } | null;
}

/** Structural equality for form values: primitives, arrays and plain objects. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

export function openDraft<F extends FormShape>(revisionId: string | null, base: F): DraftState<F> {
  return { baseRevisionId: revisionId, base, form: base, incoming: null };
}

/** Fields whose value differs from the recorded one, in form order. */
export function dirtyFields<F extends FormShape>(state: DraftState<F>): (keyof F & string)[] {
  const keys = new Set([...Object.keys(state.base), ...Object.keys(state.form)]);
  return [...keys].filter((k) => !sameValue(state.form[k], state.base[k])) as (keyof F & string)[];
}

export function isDirty<F extends FormShape>(state: DraftState<F>): boolean {
  return dirtyFields(state).length > 0;
}

export function editDraft<F extends FormShape>(
  state: DraftState<F>,
  patch: Partial<F>,
): DraftState<F> {
  return { ...state, form: { ...state.form, ...patch } };
}

/**
 * The project says the edit target is now `revisionId`. The same revision again changes
 * nothing, however many times it is delivered. A different one replaces a clean form and is
 * parked beside a dirty one until the person chooses.
 */
export function receiveRevision<F extends FormShape>(
  state: DraftState<F>,
  revisionId: string | null,
  base: F,
): DraftState<F> {
  if (revisionId === state.baseRevisionId)
    return state.incoming ? { ...state, incoming: null } : state;
  if (!isDirty(state)) return openDraft(revisionId, base);
  if (revisionId === null || state.incoming?.revisionId === revisionId) return state;
  return { ...state, incoming: { revisionId, base } };
}

/**
 * The recorded form of the *same* revision became available or more complete (its source
 * finished loading, say). Edits stay; only what they are compared against moves.
 */
export function reloadBase<F extends FormShape>(state: DraftState<F>, base: F): DraftState<F> {
  if (sameValue(state.base, base)) return state;
  return isDirty(state)
    ? { ...state, base }
    : { ...openDraft(state.baseRevisionId, base), incoming: state.incoming };
}

/** Drop the edits. With a revision waiting underneath, that revision becomes the form. */
export function discardDraft<F extends FormShape>(state: DraftState<F>): DraftState<F> {
  return state.incoming
    ? openDraft(state.incoming.revisionId, state.incoming.base)
    : openDraft(state.baseRevisionId, state.base);
}

/**
 * Keep the edits and move them onto the waiting revision: edited fields keep the person's
 * values, every other field takes the newer recorded value.
 */
export function keepEdits<F extends FormShape>(state: DraftState<F>): DraftState<F> {
  if (!state.incoming) return state;
  const mine = Object.fromEntries(dirtyFields(state).map((k) => [k, state.form[k]])) as Partial<F>;
  return {
    baseRevisionId: state.incoming.revisionId,
    base: state.incoming.base,
    form: { ...state.incoming.base, ...mine },
    incoming: null,
  };
}

/** The save went through as `revisionId` with exactly this form. */
export function commitDraft<F extends FormShape>(revisionId: string, saved: F): DraftState<F> {
  return openDraft(revisionId, saved);
}

export interface UnderneathChange {
  field: string;
  /** What the edits were based on. */
  was: unknown;
  /** What the waiting revision records. */
  now: unknown;
  /** The person's value, when they edited this field too. */
  mine?: unknown;
  /** Both sides changed this field to different values: keeping the edits overrides `now`. */
  contested: boolean;
}

/** What changed underneath the edits, field by field. Empty when nothing is waiting. */
export function underneathChanges<F extends FormShape>(state: DraftState<F>): UnderneathChange[] {
  const { incoming } = state;
  if (!incoming) return [];
  const edited = new Set<string>(dirtyFields(state));
  const keys = new Set([...Object.keys(state.base), ...Object.keys(incoming.base)]);
  return [...keys]
    .filter((k) => !sameValue(state.base[k], incoming.base[k]))
    .map((k) => {
      const mine = edited.has(k);
      return {
        field: k,
        was: state.base[k],
        now: incoming.base[k],
        ...(mine ? { mine: state.form[k] } : {}),
        contested: mine && !sameValue(state.form[k], incoming.base[k]),
      };
    });
}

export type LockReason =
  'read-only-project' | 'nothing-recorded' | 'draft' | 'in-review' | 'history' | 'not-newest';

export interface Editability {
  canEdit: boolean;
  reason: LockReason | null;
}

/**
 * Edits are offered only on the revision the core will accept as a base (`anchorId`): the
 * baseline for a direct edit, the newest active revision for a CAD candidate.
 */
export function editability(input: {
  readOnly: boolean;
  displayed: { id: string; reviewState: string } | null;
  anchorId: string | null;
  anchor: 'baseline' | 'newest';
}): Editability {
  const { readOnly, displayed, anchorId, anchor } = input;
  if (readOnly) return { canEdit: false, reason: 'read-only-project' };
  if (!displayed) return { canEdit: false, reason: 'nothing-recorded' };
  if (displayed.id === anchorId) return { canEdit: true, reason: null };
  if (anchor === 'newest') return { canEdit: false, reason: 'not-newest' };
  if (displayed.reviewState === 'draft') return { canEdit: false, reason: 'draft' };
  if (displayed.reviewState === 'proposed') return { canEdit: false, reason: 'in-review' };
  return { canEdit: false, reason: 'history' };
}

const LOCK_COPY: Record<LockReason, string> = {
  'read-only-project': 'This project is read-only, so nothing here can be changed.',
  'nothing-recorded': 'Nothing is recorded yet, so there is nothing to edit.',
  draft:
    'This is a draft. Accept it as the baseline to edit it here, or ask the agent to revise it.',
  'in-review': 'This revision is in review. Decide the proposal before editing.',
  history: 'This is a historical revision. Show the baseline to edit.',
  'not-newest': 'A newer revision exists. Show the newest revision to change the part.',
};

export function lockReasonText(reason: LockReason): string {
  return LOCK_COPY[reason];
}
