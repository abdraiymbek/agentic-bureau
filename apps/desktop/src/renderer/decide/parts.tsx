/** Small display pieces shared by the decision level. */
import React, { useState } from 'react';
import { useStore } from '../store';
import { TypeGlyph, shortId } from '../ui/kit';
import { foldUnchanged, type LineOp, type Shown, type WordSeg } from '../lib/diff';

/** An object named by its title, or said plainly to be absent from the project list. */
export function RefTitle({ id }: { id: string }) {
  const view = useStore((s) => s.artifacts.find((a) => a.artifact.id === id));
  if (!view)
    return (
      <span className="review-ref-missing" title={id}>
        object {shortId(id)} (not in the current list)
      </span>
    );
  return (
    <span className="review-ref">
      <TypeGlyph type={view.artifact.type} size={12} />
      {view.artifact.title}
    </span>
  );
}

/** Local date and time, with the recorded timestamp kept on the element. */
export function LocalTime({ iso }: { iso: string }) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return <>{iso}</>;
  return (
    <time dateTime={iso} title={iso}>
      {d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
    </time>
  );
}

export function ShownValue({ value }: { value: Shown }) {
  if (value.ref) return <RefTitle id={value.ref} />;
  if (value.refs)
    return (
      <span className="review-refs">
        {value.refs.map((id) => (
          <RefTitle key={id} id={id} />
        ))}
      </span>
    );
  if (value.time) return <LocalTime iso={value.time} />;
  const cls = value.unknown
    ? 'unknown'
    : value.empty
      ? 'review-empty'
      : value.quantity
        ? 'review-qty'
        : value.long
          ? 'review-long'
          : undefined;
  return <span className={cls}>{value.text}</span>;
}

function Words({ words, fallback }: { words?: WordSeg[]; fallback: string }) {
  if (!words) return <>{fallback || ' '}</>;
  return (
    <>
      {words.map((w, i) =>
        w.changed ? (
          <mark key={i}>{w.text}</mark>
        ) : (
          <React.Fragment key={i}>{w.text}</React.Fragment>
        ),
      )}
    </>
  );
}

/**
 * A line diff. Removed lines carry a minus, added lines a plus, and both say so to assistive
 * technology. Long unchanged runs fold into a control that shows them.
 */
export function LineDiff({
  lines,
  fold = 3,
  prose = false,
}: {
  lines: LineOp[];
  /** Unchanged lines kept around each edit; null shows every line. */
  fold?: number | null;
  /** Prose reads in the interface face; files and source stay monospaced. */
  prose?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const rows = fold === null ? lines : foldUnchanged(lines, fold);
  return (
    <div className={`line-diff ${prose ? 'line-diff-prose' : ''}`}>
      {rows.map((l, i) => {
        if (l.op === 'skip') {
          if (expanded.has(i))
            return (
              <React.Fragment key={i}>
                {l.hidden.map((h, j) => (
                  <div key={`${i}-${j}`} className="ld-line ld-same">
                    <span className="ld-mark" aria-hidden="true" />
                    <span className="ld-text">{h.text || ' '}</span>
                  </div>
                ))}
              </React.Fragment>
            );
          return (
            <button
              key={i}
              type="button"
              className="ld-skip"
              onClick={() => setExpanded((s) => new Set(s).add(i))}
            >
              Show {l.count} unchanged {l.count === 1 ? 'line' : 'lines'}
            </button>
          );
        }
        const kind = l.op === 'same' ? 'same' : l.op === 'added' ? 'added' : 'removed';
        return (
          <div key={i} className={`ld-line ld-${kind}`}>
            <span className="ld-mark" aria-hidden="true">
              {kind === 'added' ? '+' : kind === 'removed' ? '−' : ''}
            </span>
            <span className="ld-text">
              {kind !== 'same' && (
                <span className="sr-only">{kind === 'added' ? 'Added: ' : 'Removed: '}</span>
              )}
              <Words words={l.op === 'same' ? undefined : l.words} fallback={l.text} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
