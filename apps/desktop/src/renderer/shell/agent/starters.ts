/**
 * Starter prompts for a live session, built from the record: the project intent and what waits
 * on the agent. They are typed into the terminal for the person to edit and send; never sent.
 */
import type { ArtifactView, Project, Proposal } from '@bureau/contracts';

export interface Starter {
  id: string;
  label: string;
  text: string;
}

const LISTED = 8;

/**
 * Starters are offered only while a live session waits for its first instruction: nothing typed
 * or pasted into it (the launcher brief, an ask), nothing waiting to be typed, no tool call yet,
 * and not dismissed for this session.
 */
export function offersStarters(s: {
  sessionId: string | null;
  live: boolean;
  hasInput: boolean;
  waiting: number;
  calls: number;
  dismissed: string | null;
}): boolean {
  return (
    !!s.sessionId &&
    s.live &&
    !s.hasInput &&
    s.waiting === 0 &&
    s.calls === 0 &&
    s.dismissed !== s.sessionId
  );
}

function reference(v: ArtifactView): string {
  return `${v.artifact.title} (${v.artifact.type}, artifact ${v.artifact.id})`;
}

function listOf(views: ArtifactView[]): string {
  const shown = views.slice(0, LISTED).map(reference).join('; ');
  const rest = views.length - LISTED;
  return rest > 0 ? `${shown}; and ${rest} more marked on the flow map` : shown;
}

export function starterPrompts(
  project: Pick<Project, 'intent'> | null,
  artifacts: ArtifactView[],
  proposals: Proposal[],
): Starter[] {
  const live = artifacts.filter((v) => !v.artifact.archived);
  const starters: Starter[] = [];
  if (!live.length) {
    const intent = project?.intent?.trim();
    starters.push({
      id: 'first-requirements',
      label: 'Draft the first requirements',
      text: intent
        ? `Call project_summary, then draft the first requirements for this intent, each with a measurable target and acceptance criteria, and record the assumptions you make as assumptions. Intent: ${intent}`
        : 'Ask me what this project must do, then draft requirements with measurable targets and acceptance criteria.',
    });
    return starters;
  }
  const returned = proposals.filter((p) => p.state === 'changes_requested');
  for (const p of returned.slice(0, 2))
    starters.push({
      id: `changes:${p.id}`,
      label: `Address requested changes: ${p.reason}`,
      text: `I requested changes on proposal ${p.id} ("${p.reason}"). Read it with proposal_read, including my rationale, then submit a corrected replacement for review.`,
    });
  const stale = live.filter((v) => v.freshness === 'stale');
  if (stale.length)
    starters.push({
      id: 'stale',
      label: `Bring ${stale.length} out-of-date ${stale.length === 1 ? 'object' : 'objects'} up to date`,
      text: `These objects are out of date because an input changed: ${listOf(stale)}. For each one, read which input changed and draft an updated revision. Then call work_status.`,
    });
  const missing = live.filter((v) => v.freshness === 'missing_input');
  if (missing.length)
    starters.push({
      id: 'missing',
      label: `Resolve ${missing.length} missing ${missing.length === 1 ? 'input' : 'inputs'}`,
      text: `These objects are missing an input: ${listOf(missing)}. Find each input that has no approved baseline and draft what it needs, without changing approved baselines.`,
    });
  return starters.slice(0, 3);
}
