/**
 * The reviewer's work, kept outside React so it survives background refreshes, the decision
 * view unmounting (a trip to an object and back), and proposals switching underneath: rationale
 * drafts, accepted scopes, scroll position, open sections, the version that was read, the queue
 * position, and decisions not yet handed back to the agent. In memory only, per project.
 */
import { fingerprint, whatChanged, type ProposalDetail, type QueueFilter } from './model';
import type { RecordedDecision } from './handoff';

export interface ReviewNotes {
  rationale: string;
  /** artifactId → evidence hash whose declared scope the person accepts with approval. */
  scopes: Record<string, string>;
  scrollTop: number;
  /** Expanded sections by key. */
  open: Record<string, boolean>;
  /** The version the person read first (or last confirmed). */
  read: { fingerprint: string; detail: ProposalDetail } | null;
}

interface ProjectReview {
  filter: QueueFilter;
  selected: string | null;
  notes: Map<string, ReviewNotes>;
  handoff: RecordedDecision[];
}

/** Notes kept per project; the least recently touched proposal's notes go first. */
const NOTES_LIMIT = 40;
const projects = new Map<string, ProjectReview>();

const empty = (): ReviewNotes => ({
  rationale: '',
  scopes: {},
  scrollTop: 0,
  open: {},
  read: null,
});

export function projectReview(projectId: string): ProjectReview {
  let p = projects.get(projectId);
  if (!p) {
    p = { filter: 'open', selected: null, notes: new Map(), handoff: [] };
    projects.set(projectId, p);
  }
  return p;
}

export function notesFor(projectId: string, proposalId: string): ReviewNotes {
  return projectReview(projectId).notes.get(proposalId) ?? empty();
}

export function updateNotes(
  projectId: string,
  proposalId: string,
  patch: Partial<ReviewNotes>,
): ReviewNotes {
  const { notes } = projectReview(projectId);
  const next = { ...(notes.get(proposalId) ?? empty()), ...patch };
  notes.delete(proposalId);
  notes.set(proposalId, next);
  while (notes.size > NOTES_LIMIT) notes.delete(notes.keys().next().value!);
  return next;
}

/** After a decision is recorded: the draft became the record. */
export function forgetNotes(projectId: string, proposalId: string) {
  projectReview(projectId).notes.delete(proposalId);
}

/**
 * Compare what the core returns now with what the person read. The first fresh read is
 * remembered as read (`fresh`: just returned by the core, not a cached copy); a later, different
 * version lists what changed until it is confirmed.
 */
export function readCheck(projectId: string, detail: ProposalDetail, fresh: boolean): string[] {
  const fp = fingerprint(detail);
  const { read } = notesFor(projectId, detail.proposal.id);
  if (!read) {
    if (fresh) updateNotes(projectId, detail.proposal.id, { read: { fingerprint: fp, detail } });
    return [];
  }
  if (read.fingerprint === fp) return [];
  const changes = whatChanged(read.detail, detail);
  return changes.length ? changes : ['Its recorded content changed.'];
}

export function confirmRead(projectId: string, detail: ProposalDetail) {
  updateNotes(projectId, detail.proposal.id, {
    read: { fingerprint: fingerprint(detail), detail },
  });
}

export function setQueue(
  projectId: string,
  patch: Partial<Pick<ProjectReview, 'filter' | 'selected'>>,
) {
  Object.assign(projectReview(projectId), patch);
}

export function recordDecision(projectId: string, decision: RecordedDecision) {
  projectReview(projectId).handoff.push(decision);
}

export function clearHandoff(projectId: string) {
  projectReview(projectId).handoff = [];
}
