import React, { useEffect, useState } from 'react';
import type { Revision } from '@bureau/contracts';
import { readRevisionFile } from '../decide/io';
import { textContent } from '../lib/diff';
import { Notice, Spinner } from '../ui/kit';

interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
  binary: boolean;
}
/** Actual recorded sources, including file-only proposals. No source execution or silent cuts. */
export function InlineFileReview({
  projectId,
  base,
  next,
  meshPath,
  onReady,
}: {
  projectId: string;
  base: Revision | null;
  next: Revision | null;
  meshPath?: string;
  onReady: (ready: boolean) => void;
}) {
  const [viewed, setViewed] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<{ identity?: string; files?: FileChange[]; error?: string }>(
    {},
  );
  const before = base?.files ?? [];
  const after = next?.files ?? [];
  const paths = [...new Set([...before, ...after].map((f) => f.path))].filter((path) => {
    if (meshPath && path === meshPath) return false; // Only the exact mesh covered by mechanical geometry review is exempt.
    const a = before.find((f) => f.path === path),
      b = after.find((f) => f.path === path);
    return !a || !b || !a.sha256 || a.sha256 !== b.sha256;
  });
  const identity = `${projectId}/${base?.id}/${next?.id}/${paths.join('|')}`;
  useEffect(() => {
    let alive = true;
    const get = async (revision: Revision | null, path: string) =>
      revision?.files.some((f) => f.path === path)
        ? textContent(await readRevisionFile(projectId, revision, path))
        : null;
    void Promise.all(
      paths.map(async (path) => {
        const [oldText, newText] = await Promise.all([get(base, path), get(next, path)]);
        const binary =
          (!!base?.files.some((f) => f.path === path) && oldText === null) ||
          (!!next?.files.some((f) => f.path === path) && newText === null);
        return { path, before: oldText, after: newText, binary };
      }),
    ).then(
      (files) => alive && setState({ identity, files }),
      (e) => alive && setState({ identity, error: String(e) }),
    );
    return () => {
      alive = false;
    };
    // Immutable revision IDs own these file lists; callback identity does not restart reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);
  useEffect(() => {
    onReady(
      state.identity === identity &&
        !!state.files &&
        !state.files.some((f) => f.binary || !viewed[f.path]),
    );
  }, [state, identity, viewed, onReady]);
  if (!paths.length) return null;
  if (state.identity === identity && state.error)
    return (
      <Notice tone="err">
        The proposed files could not be read: {state.error}. Approval is blocked.
      </Notice>
    );
  if (state.identity !== identity || !state.files)
    return (
      <p className="inline-loading">
        <Spinner /> Reading actual proposed source files…
      </p>
    );
  return (
    <div className="inline-file-review">
      <p className="inline-caption">
        {state.files.length} changed source {state.files.length === 1 ? 'file' : 'files'} · open
        each to inspect before approving
      </p>
      {state.files.map((f) => (
        <details
          key={f.path}
          className="inline-provenance"
          onToggle={(e) => {
            if (e.currentTarget.open) setViewed((v) => ({ ...v, [f.path]: true }));
          }}
        >
          <summary>{f.path} · recorded file change</summary>
          {f.binary ? (
            <Notice tone="warn">
              This binary file cannot be reviewed in chat. Approval is blocked until it can be
              inspected.
            </Notice>
          ) : (
            <div className="inline-source-pair">
              <div>
                <strong>Before</strong>
                <pre>{f.before ?? 'No previous file'}</pre>
              </div>
              <div>
                <strong>Proposed</strong>
                <pre>{f.after ?? 'File removed'}</pre>
              </div>
            </div>
          )}
        </details>
      ))}
    </div>
  );
}
