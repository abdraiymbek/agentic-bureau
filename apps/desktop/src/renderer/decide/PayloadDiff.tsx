import React from 'react';
import type { DiffEntry, Shown } from '../lib/diff';
import { LineDiff, ShownValue } from './parts';

const CHANGE_WORD: Record<DiffEntry['change'], string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  moved: 'Moved',
};

function Was({ value }: { value?: Shown }) {
  if (!value) return <span className="diff-from review-empty">Not set</span>;
  return (
    <del className="diff-from">
      <span className="sr-only">was </span>
      <ShownValue value={value} />
    </del>
  );
}

function Now({ value }: { value?: Shown }) {
  if (!value) return <span className="diff-to review-empty">Removed</span>;
  return (
    <ins className="diff-to">
      <span className="sr-only">now </span>
      <ShownValue value={value} />
    </ins>
  );
}

function Notes({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return <span className="diff-notes">{notes.join(' · ')}</span>;
}

/** Old → new on one row while both are short. */
function ValueRow({ e }: { e: DiffEntry }) {
  return (
    <div className="diff-row" role="listitem">
      <span className="diff-field">{e.label}</span>
      <Was value={e.from} />
      <span className="diff-arrow" aria-hidden="true">
        →
      </span>
      <Now value={e.to} />
      <Notes notes={e.notes} />
    </div>
  );
}

/** Long text gets the full width: a line diff, or the whole text when it appeared or went. */
function TextRow({ e }: { e: DiffEntry }) {
  return (
    <div className="diff-row stacked" role="listitem">
      <div className="diff-head">
        <span className="diff-field">{e.label}</span>
        <span className={`diff-change change-${e.change}`}>{CHANGE_WORD[e.change]}</span>
      </div>
      {e.lines ? (
        <LineDiff lines={e.lines} fold={e.lines.length > 40 ? 3 : null} prose />
      ) : (
        <div className="diff-blocks">
          {e.from && (
            <div className="diff-block">
              <span className="diff-block-label">Was</span>
              <del className="diff-from">
                <ShownValue value={e.from} />
              </del>
            </div>
          )}
          {e.to && (
            <div className="diff-block">
              <span className="diff-block-label">Now</span>
              <ins className="diff-to">
                <ShownValue value={e.to} />
              </ins>
            </div>
          )}
        </div>
      )}
      <Notes notes={e.notes} />
    </div>
  );
}

/** A whole list item that was added, removed or moved. */
function ItemRow({ e }: { e: DiffEntry }) {
  const value = e.to ?? e.from;
  return (
    <div className={`diff-row stacked diff-item item-${e.change}`} role="listitem">
      <div className="diff-head">
        <span className="diff-field">{e.label}</span>
        <span className={`diff-change change-${e.change}`}>{CHANGE_WORD[e.change]}</span>
      </div>
      {e.fields ? (
        <dl className="diff-fields">
          {e.fields.map((f, i) => (
            <React.Fragment key={i}>
              <dt>{f.label}</dt>
              <dd>
                <ShownValue value={f.value} />
              </dd>
            </React.Fragment>
          ))}
        </dl>
      ) : value ? (
        <div className="diff-item-value">
          <ShownValue value={value} />
        </div>
      ) : null}
      <Notes notes={e.notes} />
    </div>
  );
}

/** Field-level differences; quantities change atomically — 0.3 kg → 0.5 kg. */
export function PayloadDiff({ entries, empty }: { entries: DiffEntry[]; empty?: string }) {
  if (!entries.length) return <p className="review-muted">{empty ?? 'No field changes.'}</p>;
  return (
    <div className="diff" role="list" aria-label="Changes">
      {entries.map((e) =>
        e.kind === 'item' ? (
          <ItemRow key={`${e.path}:${e.change}`} e={e} />
        ) : e.kind === 'text' || e.from?.long || e.to?.long ? (
          <TextRow key={`${e.path}:${e.change}`} e={e} />
        ) : (
          <ValueRow key={`${e.path}:${e.change}`} e={e} />
        ),
      )}
    </div>
  );
}
