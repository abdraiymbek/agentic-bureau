/**
 * The decision guard: one pure predicate that says whether a decision may be recorded now, and
 * if not, why, in words the bar can show. Buttons and the ⌘↵ shortcut both go through it.
 */
import type { LayerKind } from '../lib/layers';
import type { ReviewStatus } from './CadReview';
import type { Phase, ProposalDetail } from './model';

export type DecisionOp = 'approve' | 'reject' | 'request_changes';

/** What was on screen (committed to the page) and since when. */
export interface ShownProposal {
  proposalId: string;
  fingerprint: string;
  at: number;
}

export type LoadState = 'loading' | 'ready' | 'refreshing' | 'error' | 'refresh_failed';

export interface DecisionContext {
  op: DecisionOp;
  via: 'keyboard' | 'pointer';
  readOnly: boolean;
  busy: boolean;
  shown: ShownProposal | null;
  /** The proposal the decision would be recorded on, as last read from the core. */
  loaded: { proposalId: string; fingerprint: string; phase: Phase } | null;
  load: LoadState;
  /**
   * Why some change has not rendered its content (geometry included); null once all have. It
   * holds back approval only: rejecting or returning what could not be shown stays possible.
   */
  renderProblem: string | null;
  /** It changed after it was first read, and the person has not confirmed re-reading it. */
  unreadChange: boolean;
  rationale: string;
  /** Keyboard only: auto-repeat of a held key. */
  repeat?: boolean;
  /** Keyboard only: an open dialog, sheet, menu or omnibar, by name. */
  layer?: string | null;
  /** Keyboard only: focus is inside the decision view. */
  focusInside?: boolean;
  now?: number;
}

export type Verdict = { ok: true } | { ok: false; reason: string; silent?: boolean };

/** A proposal must have been on screen this long before ⌘↵ can approve it. */
export const KEYBOARD_DWELL_MS = 400;

const no = (reason: string, silent = false): Verdict => ({ ok: false, reason, silent });

export function decisionVerdict(c: DecisionContext): Verdict {
  if (c.readOnly) return no('This project is read-only, so decisions cannot be recorded.');
  if (c.busy) return no('A decision is being recorded.', c.via === 'keyboard');
  if (c.via === 'keyboard') {
    if (c.repeat) return no('Held keys are ignored.', true);
    if (c.op !== 'approve') return no('Only approval has a shortcut.', true);
    if (c.layer) return no(`Close the ${c.layer} first. ⌘↵ acts only in the decision view.`);
    if (!c.focusInside) return no('Move focus into the decision first. ⌘↵ acts only there.');
  }
  if (!c.loaded || c.load === 'loading') return no('The proposal is still loading.');
  if (c.load === 'error') return no('The proposal could not be read.');
  if (c.load === 'refreshing') return no('Checking whether the proposal changed.');
  if (c.load === 'refresh_failed')
    return no('Could not confirm the latest state of this proposal. Read it again first.');
  if (
    !c.shown ||
    c.shown.proposalId !== c.loaded.proposalId ||
    c.shown.fingerprint !== c.loaded.fingerprint
  )
    return no('The screen is still showing an older version of this proposal.');
  if (c.renderProblem && c.op === 'approve') return no(c.renderProblem);
  if (c.unreadChange)
    return no('This proposal changed while it was open. Read it again, then confirm.');

  const phase = c.loaded.phase;
  const open = phase.kind === 'needs_you' || phase.kind === 'base_moved';
  if (c.op === 'approve') {
    if (
      phase.kind === 'base_moved' ||
      (phase.kind === 'waiting_on_agent' && phase.artifactIds.length)
    )
      return no('Approval is blocked: a baseline moved after this was proposed.');
    if (phase.kind === 'waiting_on_agent' && c.via === 'keyboard')
      return no('⌘↵ approves only proposals that need you.');
    if (phase.kind !== 'needs_you' && phase.kind !== 'waiting_on_agent')
      return no('This proposal is no longer open.');
  } else if (c.op === 'reject') {
    if (!open && phase.kind !== 'waiting_on_agent') return no('This proposal is no longer open.');
    if (!c.rationale.trim()) return no('Say why it is rejected. The reason is kept in the record.');
  } else {
    if (phase.kind === 'waiting_on_agent') return no('Changes are already requested.');
    if (!open) return no('This proposal is no longer open.');
    if (!c.rationale.trim()) return no('Say what the agent should change.');
  }
  if (c.via === 'keyboard' && c.now !== undefined && c.now - c.shown.at < KEYBOARD_DWELL_MS)
    return no('Just shown.', true);
  return { ok: true };
}

/**
 * Why the changes cannot be judged yet, or null when every change rendered its content. An
 * archive change shows no content, so it waits for nothing; a mechanical change waits until its
 * proposed geometry is on screen (`geometry`, by revision id, from the geometry review).
 */
export function renderProblem(
  d: ProposalDetail,
  geometry: Record<string, ReviewStatus>,
): string | null {
  for (const c of d.changes) {
    if (c.change.kind === 'archive') continue;
    if (!c.next) return 'A proposed revision is missing from the record.';
    if (c.artifact?.type === 'mechanical') {
      const s = geometry[c.next.id];
      if (!s || s.state === 'loading') return 'The proposed geometry is still loading.';
      if (s.state === 'error') return s.reason;
    }
  }
  return null;
}

const LAYER_NAMES: Record<LayerKind, string> = {
  menu: 'menu',
  prompt: 'unsaved-changes prompt',
  omnibar: 'omnibar',
  settings: 'settings sheet',
  dialog: 'dialog',
  custom: 'open panel',
};

/** The open layer (`lib/layers.ts` `topmostLayer`) in the words the bar uses. */
export function layerName(kind: LayerKind | null): string | null {
  return kind ? LAYER_NAMES[kind] : null;
}
