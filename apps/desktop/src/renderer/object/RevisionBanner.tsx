import React, { useState } from 'react';
import type { ArtifactView } from '@bureau/contracts';
import { cmd, errMsg } from '../api';
import { openProposals, useStore } from '../store';
import { Button, Notice, stateLabel } from '../ui/kit';
import { LATEST_WORK } from '../lib/mechanical-revisions';
import { useObjectRevisions } from './revisions';
import { useOpenEdits } from './useOpenEdits';
import { useNavigate } from './stages/shared';

/**
 * Says what the revision on screen is when it is not the baseline, and offers what a person
 * can do about it: accept a draft as the baseline, open the decision that covers it, or go
 * back to the latest work. The baseline itself needs no banner.
 */
export function RevisionBanner({
  view,
  acceptBlock,
}: {
  view: ArtifactView;
  /** Why this draft cannot be accepted from here, when a stage knows a reason. */
  acceptBlock?: string | null;
}) {
  const revisions = useObjectRevisions(view);
  const readOnly = useStore((s) => s.readOnly);
  const toast = useStore((s) => s.toast);
  const { decide } = useNavigate();
  const revision = view.revision;
  const proposal = useStore((s) => {
    if (!revision) return undefined;
    const open = openProposals(s.proposals).filter((p) =>
      p.changes.some((c) => c.artifactId === view.artifact.id),
    );
    return (
      open.find((p) => p.changes.some((c) => c.newRevisionId === revision.id)) ??
      (revision.reviewState === 'proposed' ? open[0] : undefined)
    );
  });
  const editing = useOpenEdits(view.artifact.id).length > 0;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // While an editor holds its base revision on screen, that editor explains the situation.
  if (!revision || editing || revisions.role === 'baseline' || revisions.role === null) return null;

  const baseline = revisions.revisions?.find((r) => r.id === revisions.baselineId) ?? null;
  const name = `r${revision.seq}`;
  const standing = baseline
    ? `The baseline is r${baseline.seq}.`
    : 'Nothing is approved for this object yet.';

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await cmd('artifact.accept_draft', {
        artifactId: view.artifact.id,
        draftRevisionId: revision.id,
        rationale: `Accept revision ${revision.seq} as the baseline`,
      });
      await revisions.saved(revision.id);
      toast('ok', `Revision ${revision.seq} is now the baseline`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const openDecision = proposal && (
    <Button size="sm" onClick={() => decide(proposal.id)}>
      Open decision
    </Button>
  );

  if (revisions.role === 'history') {
    // An approved revision can sit beside the baseline: the core approved it without moving
    // the pointer. That is not the same thing as a revision the baseline has left behind.
    const beside =
      revision.reviewState === 'approved' && (!baseline || revision.seq > baseline.seq);
    return (
      <Notice
        action={
          <Button size="sm" onClick={() => revisions.choose(LATEST_WORK)}>
            Show latest work
          </Button>
        }
      >
        <strong>
          {beside
            ? `${name} is approved but is not the baseline.`
            : `${name} is history · ${stateLabel(revision.reviewState)}.`}
        </strong>{' '}
        {standing} Nothing here can be edited.
      </Notice>
    );
  }

  if (revision.reviewState === 'proposed')
    return (
      <Notice tone="warn" action={openDecision}>
        <strong>{name} is in review.</strong> {standing} It becomes the baseline only when its
        proposal is approved.
      </Notice>
    );

  const blocked = readOnly ? 'This project is read-only.' : (acceptBlock ?? null);
  return (
    <Notice
      tone="warn"
      action={
        <span className="banner-actions">
          {openDecision}
          <Button
            size="sm"
            variant="primary"
            busy={busy}
            disabled={!!blocked}
            onClick={() => void accept()}
          >
            Accept as baseline
          </Button>
        </span>
      }
    >
      <strong>{name} is a draft.</strong> {standing}{' '}
      {blocked ??
        `Accepting makes ${name} the baseline at once, without a review, and marks what depends on it out of date.`}
      {error && (
        <span className="banner-error" role="alert">
          {' '}
          Not accepted: {error}
        </span>
      )}
    </Notice>
  );
}
