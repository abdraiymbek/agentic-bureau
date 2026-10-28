import React, { useEffect, useMemo, useState } from 'react';
import type { Revision } from '@bureau/contracts';
import { errMsg } from '../api';
import { Disclosure, Spinner } from '../ui/kit';
import { diffFiles, diffLines, formatBytes, textContent, type FileChange } from '../lib/diff';
import { readRevisionFile } from './io';
import { LineDiff } from './parts';

type Read =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; size: number; text: string | null };

/** Meshes are large and binary; they are read only when asked for. */
const READ_ON_DEMAND = /\.(stl|3mf|step|stp|obj)$/i;

function useFile(
  projectId: string | null,
  rev: Revision | null,
  path: string | undefined,
  enabled: boolean,
): Read | null {
  const [read, setRead] = useState<Read | null>(null);
  // Keyed by the immutable revision, so a refreshed copy of the same revision reads nothing again.
  const id = rev?.id;
  const artifactId = rev?.artifactId;
  useEffect(() => {
    if (!id || !artifactId || !path || !enabled) return;
    let cancelled = false;
    setRead({ state: 'loading' });
    readRevisionFile(projectId, { id, artifactId }, path)
      .then(
        (bytes) =>
          !cancelled && setRead({ state: 'ready', size: bytes.length, text: textContent(bytes) }),
      )
      .catch((e) => !cancelled && setRead({ state: 'error', message: errMsg(e) }));
    return () => {
      cancelled = true;
    };
  }, [projectId, id, artifactId, path, enabled]);
  return rev && path ? read : null;
}

const WORD: Record<FileChange['change'], string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  renamed: 'Renamed',
};

function Size({ read }: { read: Read | null }) {
  if (!read) return null;
  if (read.state === 'loading') return <Spinner size={10} />;
  if (read.state === 'error') return <span className="unknown">size unknown</span>;
  return <span className="review-qty">{formatBytes(read.size)}</span>;
}

function FileRow({
  projectId,
  change,
  base,
  next,
  open,
  onToggle,
}: {
  projectId: string | null;
  change: FileChange;
  base: Revision | null;
  next: Revision;
  open: boolean;
  onToggle: () => void;
}) {
  const auto = !READ_ON_DEMAND.test(change.path);
  const from = useFile(projectId, base, change.from?.path, auto || open);
  const to = useFile(projectId, next, change.to?.path, auto || open);
  const lines = useMemo(
    () =>
      from?.state === 'ready' && to?.state === 'ready' && from.text !== null && to.text !== null
        ? diffLines(from.text, to.text)
        : null,
    [from, to],
  );
  const failed = [from, to].find(
    (r): r is { state: 'error'; message: string } => r?.state === 'error',
  );
  const binary = [from, to].some((r) => r?.state === 'ready' && r.text === null);
  const whole = to?.state === 'ready' ? to : from?.state === 'ready' ? from : null;
  return (
    <li className="review-file">
      <Disclosure
        label={change.path}
        open={open}
        onToggle={onToggle}
        meta={
          <span className="review-file-meta">
            <span
              className={`diff-change change-${change.change === 'renamed' ? 'moved' : change.change}`}
            >
              {WORD[change.change]}
            </span>
            {change.previousPath && <span className="mono">from {change.previousPath}</span>}
            <span>{(change.to ?? change.from)?.role}</span>
            {change.from && change.to ? (
              <>
                <Size read={from} /> → <Size read={to} />
              </>
            ) : (
              <Size read={to ?? from} />
            )}
          </span>
        }
      >
        {failed ? (
          <p className="unknown">Could not read the file: {failed.message}</p>
        ) : binary ? (
          <p className="review-muted">Binary file. Its contents are not compared here.</p>
        ) : change.change === 'changed' && lines ? (
          <LineDiff lines={lines} />
        ) : change.change === 'changed' && from?.state === 'ready' && to?.state === 'ready' ? (
          <p className="review-muted">The two versions are too different to align line by line.</p>
        ) : whole && whole.text !== null && change.change !== 'renamed' ? (
          <pre className="code-block review-file-text">{whole.text}</pre>
        ) : change.change === 'renamed' ? (
          <p className="review-muted">Same bytes under a new path.</p>
        ) : (
          <p className="review-muted" role="status">
            Reading the file…
          </p>
        )}
      </Disclosure>
    </li>
  );
}

/** Files of the proposed revision against its base: added, removed, changed, renamed. */
export function FileChanges({
  projectId,
  base,
  next,
  skip,
  open,
  onToggle,
}: {
  projectId: string | null;
  base: Revision | null;
  next: Revision;
  /** Files another section already shows (the mechanical review shows mesh and source). */
  skip?: (path: string) => boolean;
  open: Record<string, boolean>;
  onToggle: (key: string) => void;
}) {
  const { changes, unchanged } = useMemo(
    () => diffFiles(base?.files ?? [], next.files ?? []),
    [base, next],
  );
  const shown = changes.filter((c) => !skip?.(c.path));
  if (!shown.length) return null;
  return (
    <section className="change-files">
      <h4>
        Files
        <span className="dim">
          {' '}
          · {shown.length} {shown.length === 1 ? 'change' : 'changes'}
          {unchanged ? `, ${unchanged} unchanged` : ''}
        </span>
      </h4>
      <ul>
        {shown.map((c) => (
          <FileRow
            key={c.path}
            projectId={projectId}
            change={c}
            base={base}
            next={next}
            open={!!open[`file:${c.path}`]}
            onToggle={() => onToggle(`file:${c.path}`)}
          />
        ))}
      </ul>
    </section>
  );
}
