/**
 * The listed items of a CAD check, each with its recorded state and where it came from: listed
 * by the agent or a person, or a feature of a linked requirement. The items are the request as
 * it was listed, not the request itself, and a requirement no geometry check shows says so.
 * Requirements linked or changed after the check are named, without changing the recorded
 * status. Read-only; everything shown comes from the evidence and the verification read.
 */
import React from 'react';
import type {
  CadSpecItemResult,
  CadSpecReadiness,
  CadSpecReport,
  CadSpecRequirement,
} from '@bureau/contracts';
import { Disclosure, Notice, State } from '../ui/kit';
import { stateLabel } from '../ui/vocabulary';

const ORDER: Record<string, number> = { unasserted: 0, failed: 1, not_shown: 2, passed: 3 };
const PRIORITY: Record<string, string> = { must: 'Must', should: 'Should', could: 'Could' };
const REVIEW: Record<CadSpecRequirement['review'], string> = {
  approved: 'approved',
  in_review: 'proposed',
  draft: 'draft',
};

/** Rows in the order a reviewer acts on them: no assertion, failed, not shown, passed. */
export function orderedRows(spec: CadSpecReport): CadSpecItemResult[] {
  return [...spec.items].sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9));
}

/**
 * Where a row came from, in words. A requirement row shown by assertions listed for it, rather
 * than the requirement's own, says who chose them.
 */
export function originOf(row: CadSpecItemResult, spec: CadSpecReport): string {
  const person = spec.listedBy === 'person';
  const listed = person ? 'Listed by a person' : 'Listed by the agent';
  if (row.from === 'listed' && !row.requirementId) return listed;
  const requirement = spec.requirements.find((r) => r.artifactId === row.requirementId);
  if (!requirement) return listed;
  const words = [
    `Requirement “${requirement.title}”`,
    PRIORITY[requirement.priority] ?? requirement.priority,
    // The review state the requirement had when the check read it.
    `${stateLabel(REVIEW[requirement.review] ?? requirement.review, 'review').toLowerCase()} when checked`,
  ];
  if (row.from === 'listed') return `${listed} for ${words.join(' · ')}`;
  if (row.assertedBy === 'listed')
    words.push(person ? 'asserted by a person' : 'asserted by the agent');
  return words.join(' · ');
}

/** The sentence for a requirement the check does not show as it stands now. */
export function sinceText(entry: CadSpecReadiness['linkedSince'][number]): string {
  switch (entry.change) {
    case 'linked_after':
      return `Requirement “${entry.title}” was linked to this part after this check, so the check does not show it.`;
    case 'revised':
      return `Requirement “${entry.title}” changed after this check, so the check does not show it as it stands.`;
    default:
      return `This check does not take requirement “${entry.title}” into account.`;
  }
}

function headline(spec: CadSpecReport): string {
  const { items, passed, unasserted, notShown } = spec.counts;
  return [
    `${passed} of ${items} pass`,
    unasserted ? `${unasserted} without an assertion` : null,
    notShown ? `${notShown} not shown by a check` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function SpecItems({
  spec,
  readiness,
}: {
  spec?: CadSpecReport;
  readiness?: CadSpecReadiness;
}) {
  const since = readiness?.linkedSince ?? [];
  const more = (readiness?.linkedSinceCount ?? since.length) - since.length;
  const conflict = readiness?.conflict;
  if (!spec && !since.length && !conflict) return null;
  const rows = spec ? orderedRows(spec) : [];
  const measured = rows.filter((row) => row.checks.length);
  return (
    <section className="spec-items" aria-label="Listed items">
      {spec && (
        <>
          <div className="spec-items-head">
            <span>Listed items</span>
            <span className="spec-items-count">{headline(spec)}</span>
          </div>
          <ul className="spec-item-list">
            {rows.map((row, index) => (
              <li className="spec-item" key={`${row.requirementId ?? ''}-${row.item}-${index}`}>
                <State state={row.state} dimension="spec" quiet />
                <div className="spec-item-body">
                  <span className="spec-item-text">{row.item}</span>
                  <span className="spec-item-origin">{originOf(row, spec)}</span>
                  {row.state === 'unasserted' && (
                    <span className="spec-item-note">
                      {row.statement
                        ? 'No item that names this requirement asserts a dimension of the part.'
                        : 'Nothing in the check shows this item.'}
                    </span>
                  )}
                  {row.state === 'not_shown' && row.reason && (
                    <span className="spec-item-note">{row.reason}</span>
                  )}
                  {row.state === 'failed' && (
                    <span className="check-detail mono">
                      {row.checks.length
                        ? row.checks.join(' · ')
                        : 'No check line measured this item.'}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {!!spec.replaced?.length && (
            <Notice tone="warn">
              Linked requirements now state committed values differently and replace them:{' '}
              {spec.replaced.join('; ')}. Accepting this scope accepts their values.
              {!!spec.checkChanges?.length &&
                ` The check also changed the scope itself: ${spec.checkChanges.join(', ')}.`}
            </Notice>
          )}
          {!!measured.length && (
            <Disclosure label="What measured each item" meta={`${measured.length} items`}>
              <dl className="spec-item-lines">
                {measured.map((row, index) => (
                  <React.Fragment key={`${row.item}-${index}`}>
                    <dt>{row.item}</dt>
                    <dd className="mono">{row.checks.join(' · ')}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </Disclosure>
          )}
        </>
      )}
      {conflict && (
        <Notice tone="err">
          No check of this part can run: {conflict}. A person must reconcile the requirements.
        </Notice>
      )}
      {since.map((entry) => (
        <Notice tone="warn" key={entry.requirementId}>
          {sinceText(entry)}
        </Notice>
      ))}
      {more > 0 && (
        <Notice tone="warn">
          {more} more {more === 1 ? 'requirement is' : 'requirements are'} not shown by this check
          as {more === 1 ? 'it stands' : 'they stand'}.
        </Notice>
      )}
    </section>
  );
}
