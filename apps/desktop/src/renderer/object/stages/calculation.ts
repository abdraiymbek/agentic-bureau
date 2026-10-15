/**
 * What the calculation stage says about a recorded calculation: where each input is pinned, and
 * what a re-run actually recorded. Kept apart from the component so it is tested as words.
 */
import type { ArtifactView, CalculationPayload } from '@omenflow/contracts';

type Input = CalculationPayload['inputs'][number];

export interface InputSource {
  /** The words under the source link: where the value is pinned and whether that moved. */
  pin: string;
  moved: boolean;
  available: boolean;
}

/**
 * Where a recorded input value came from, and whether its source has moved since. `seqOf` names
 * a revision of the source by number once its history is read; until then (or when it cannot be
 * read) the pin is described without inventing a number.
 */
export function inputSource(
  input: Input,
  artifacts: ArtifactView[],
  seqOf: (artifactId: string, revisionId: string) => number | 'loading' | null,
): InputSource | null {
  if (!input.sourceRef) return null;
  const { artifactId, revisionId } = input.sourceRef;
  const source = artifacts.find((v) => v.artifact.id === artifactId);
  if (!source)
    return { pin: 'The source is not in the current record.', moved: false, available: false };
  const baseline = source.artifact.selectedRevisionId;
  const baselineName = source.revision ? `r${source.revision.seq}` : 'its baseline';
  if (baseline === revisionId)
    return {
      pin: `Pinned to ${baselineName}, the current baseline`,
      moved: false,
      available: true,
    };
  const seq = seqOf(artifactId, revisionId);
  const pinned =
    typeof seq === 'number'
      ? `Pinned to r${seq}`
      : seq === 'loading'
        ? 'Pinned to another revision'
        : `Pinned to revision ${revisionId.slice(0, 8)}`;
  return {
    pin: baseline
      ? `${pinned}; the baseline is now ${baselineName}`
      : `${pinned}; the source has no approved baseline`,
    moved: true,
    available: true,
  };
}

/** The part of a `calculation.run` result that says what was recorded. */
export interface RerunResult {
  unchanged?: boolean;
  note?: string;
  proposal?: { id: string } | null;
  revision?: { seq?: number } | null;
}

export type RerunOutcome =
  | { kind: 'unchanged'; message: string; proposalId: string | null }
  | { kind: 'proposed'; message: string; proposalId: string }
  | { kind: 'drafted'; message: string };

/**
 * What the person is told after a re-run, from what the core reports. The same formula, inputs and
 * result record nothing new; only a submitted proposal is "waiting for your review".
 */
export function rerunOutcome(r: RerunResult | null | undefined): RerunOutcome {
  const proposalId = r?.proposal?.id ?? null;
  const name = typeof r?.revision?.seq === 'number' ? `r${r.revision.seq}` : 'a new revision';
  if (r?.unchanged) {
    const same =
      r.note ??
      'Formula, inputs and result are the same as the recorded revision. No new revision or proposal was created.';
    return {
      kind: 'unchanged',
      message: proposalId ? `${same} That revision already waits for your review.` : same,
      proposalId,
    };
  }
  if (proposalId)
    return {
      kind: 'proposed',
      message: `Recorded inputs recalculated as ${name}. The new result is waiting for your review.`,
      proposalId,
    };
  return {
    kind: 'drafted',
    message: `Recorded inputs recalculated as ${name}, a draft. It was not submitted for review.`,
  };
}
