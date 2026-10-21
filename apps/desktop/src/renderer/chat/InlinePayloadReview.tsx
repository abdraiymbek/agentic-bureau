import React from 'react';
import { diffPayload, type DiffEntry } from '../lib/diff';

/** Complex additions/removals carry fields rather than from/to; keep their complete content. */
function ChangedValue({ entry, side }: { entry: DiffEntry; side: 'from' | 'to' }) {
  const fieldsBelongHere =
    (entry.change === 'added' && side === 'to') || (entry.change === 'removed' && side === 'from');
  if (entry.fields && fieldsBelongHere)
    return (
      <dl className="inline-value-list inline-item-fields">
        {entry.fields.map((field, index) => (
          <div key={`${field.label}-${index}`}>
            <dt>{field.label}</dt>
            <dd>{field.value.text}</dd>
          </div>
        ))}
      </dl>
    );
  return <>{entry[side]?.text ?? (side === 'from' ? 'Not previously recorded' : 'Removed')}</>;
}

/** Actual immutable payloads, including a precise fallback for any future diff shape. */
export function InlinePayloadReview({
  before,
  proposed,
  mechanical = false,
}: {
  before: unknown;
  proposed: unknown;
  mechanical?: boolean;
}) {
  const changes = diffPayload(before ?? {}, proposed ?? {});
  const root = (entry: DiffEntry) => entry.path.split('.', 1)[0]!.split('[', 1)[0]!;
  const technical = new Set(['scad', 'stl', 'renderJobId', 'renderIdentity']);
  const provenance = mechanical ? changes.filter((entry) => technical.has(root(entry))) : [];
  const definitions = mechanical ? changes.filter((entry) => root(entry) === 'paramManifest') : [];
  const primary = changes.filter(
    (entry) => !provenance.includes(entry) && !definitions.includes(entry),
  );
  const table = (entries: DiffEntry[]) => (
    <table className="inline-table">
      <caption className="sr-only">Actual before and proposed values</caption>
      <thead>
        <tr>
          <th>Changed quantity or field</th>
          <th>Before</th>
          <th>Proposed</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.path}>
            <th scope="row">{entry.label}</th>
            <td>
              <ChangedValue entry={entry} side="from" />
            </td>
            <td>
              <ChangedValue entry={entry} side="to" />
              {entry.notes.length > 0 && <small>{entry.notes.join(' · ')}</small>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <>
      {!!primary.length && table(primary)}
      {!!definitions.length && (
        <details className="inline-provenance">
          <summary>Parameter definitions changed · {definitions.length}</summary>
          {table(definitions)}
        </details>
      )}
      {!!provenance.length && (
        <details className="inline-provenance">
          <summary>Recorded files & render provenance · {provenance.length} changes</summary>
          {table(provenance)}
        </details>
      )}
      {!changes.length && (
        <p className="inline-caption">
          No payload fields changed. Inspect any recorded file changes below.
        </p>
      )}
      <details className="inline-provenance">
        <summary>Complete recorded payloads · exact before and proposed</summary>
        <div className="inline-source-pair">
          <div>
            <strong>Before</strong>
            <pre aria-label="Exact before payload">
              {JSON.stringify(before, null, 2) ?? 'No recorded payload'}
            </pre>
          </div>
          <div>
            <strong>Proposed</strong>
            <pre aria-label="Exact proposed payload">
              {JSON.stringify(proposed, null, 2) ?? 'No recorded payload'}
            </pre>
          </div>
        </div>
      </details>
    </>
  );
}
