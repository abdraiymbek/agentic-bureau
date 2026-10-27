/** Proposal shapes as `proposal.list` / `proposal.read` return them, for the decision tests. */
import type { Artifact, Revision } from '@bureau/contracts';
import type {
  ChangeDetail,
  ProposalDetail,
  ReviewProposal,
} from '../../apps/desktop/src/renderer/decide/model';

export const ids = {
  p1: '11111111-1111-4111-8111-111111111111',
  p2: '22222222-2222-4222-8222-222222222222',
  p3: '33333333-3333-4333-8333-333333333333',
  req: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  r1: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  r2: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  r3: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
  dep: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

export function proposal(over: Partial<ReviewProposal> = {}): ReviewProposal {
  return {
    id: ids.p1,
    changes: [
      {
        artifactId: ids.req,
        baseRevisionId: ids.r1,
        newRevisionId: ids.r2,
        kind: 'baseline_update',
      },
    ],
    reason: 'Increase payload capacity to 500 g',
    impact: { affectedArtifactIds: [ids.dep], summary: '1 downstream artifact(s) may be affected' },
    state: 'pending',
    createdBy: 'agent',
    createdBySession: null,
    createdAt: '2026-10-13T10:00:00.000Z',
    resolvedAt: null,
    resolutionRationale: null,
    ...over,
  };
}

export function artifact(selectedRevisionId: string | null = ids.r1): Artifact {
  return {
    id: ids.req,
    type: 'requirement',
    title: 'Payload capacity',
    subsystem: null,
    selectedRevisionId,
    archived: false,
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

export function revision(id: string, seq: number, payload: unknown): Revision {
  return {
    id,
    artifactId: ids.req,
    parentId: null,
    seq,
    origin: 'agent',
    originDetail: null,
    createdAt: '2026-10-13T09:00:00.000Z',
    payload,
    contentHash: String(seq).repeat(64),
    files: [],
    inputs: [],
    rationale: '',
    reviewState: seq === 1 ? 'approved' : 'proposed',
  };
}

/**
 * A bill-of-materials edit as `bom_propose_edit` records it: the lines ride on an unchanged copy
 * (r2) of the component's baseline (r1), and the core still lists the baseline's dependents.
 */
export function carrierDetail(copy: Partial<Revision> = {}): ProposalDetail {
  const base = { ...revision(ids.r1, 1, { partNumber: 'M-1' }), artifactId: ids.req };
  const next: Revision = {
    ...base,
    id: ids.r2,
    seq: 2,
    parentId: ids.r1,
    reviewState: 'proposed',
    ...copy,
  };
  const change = {
    artifactId: ids.req,
    baseRevisionId: ids.r1,
    newRevisionId: ids.r2,
    kind: 'bom_edit' as const,
    bomLines: [
      {
        componentArtifactId: ids.req,
        componentRevisionId: ids.r1,
        quantity: 4,
        subsystem: null,
        location: null,
        offerId: null,
        notes: null,
      },
    ],
  };
  return {
    proposal: proposal({ changes: [change], reason: 'Four motors' }),
    changes: [
      {
        change,
        artifact: { ...artifact(), type: 'component', title: 'Motor' },
        base,
        next,
      },
    ],
  };
}

export function detail(
  over: { proposal?: Partial<ReviewProposal>; change?: Partial<ChangeDetail> } = {},
): ProposalDetail {
  const p = proposal(over.proposal);
  return {
    proposal: p,
    changes: [
      {
        change: p.changes[0]!,
        artifact: artifact(),
        base: revision(ids.r1, 1, {
          statement: 'Carry the payload',
          target: { value: 0.3, unit: 'kg' },
        }),
        next: revision(ids.r2, 2, {
          statement: 'Carry the payload',
          target: { value: 0.5, unit: 'kg' },
        }),
        ...over.change,
      },
    ],
  };
}
