import { useEffect, useRef, useState } from 'react';
import type { FileRef, Revision } from '@omenflow/contracts';
import { cmd, errMsg } from '../../api';
import { useStore } from '../../store';
import type { ParsedMesh } from '../../lib/stl-parse';
import { meshByKey } from '../viewport/mesh-client';

export type Loaded<T> =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'failed'; error: string; retry: () => void };

/**
 * The mesh a revision records. Revisions carrying the same STL share work in flight and
 * reuse a parsed result while it remains within the mesh cache's memory budget.
 */
export function useRevisionMesh(revision: Revision | null, file: FileRef | undefined) {
  const projectId = useStore((s) => s.projectId);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; result: Loaded<ParsedMesh> } | null>(null);
  const artifactId = revision?.artifactId;
  const revisionId = revision?.id;
  const path = file?.path;
  // Content decides identity; without a recorded hash the revision and path stand in.
  const key = revisionId && path ? `${projectId}:${file?.sha256 ?? `${revisionId}:${path}`}` : null;
  useEffect(() => {
    if (!key || !projectId || !artifactId || !revisionId || !path) return;
    let active = true;
    const retry = () => setAttempt((n) => n + 1);
    meshByKey(key, () =>
      cmd<{ contentBase64: string }>(
        'artifact.read_file',
        { artifactId, revisionId, path },
        { projectId },
      ).then((r) => ({ base64: r.contentBase64 })),
    ).then(
      (value) => active && setState({ key, result: { status: 'ready', value } }),
      (e) => active && setState({ key, result: { status: 'failed', error: errMsg(e), retry } }),
    );
    return () => {
      active = false;
    };
  }, [key, projectId, artifactId, revisionId, path, attempt]);
  if (!key) return { status: 'none' } satisfies Loaded<ParsedMesh>;
  return state?.key === key ? state.result : ({ status: 'loading' } satisfies Loaded<ParsedMesh>);
}

export interface CadSource {
  revisionId: string;
  path: string;
  text: string;
  /** Parameter values this revision records over the source defaults, as plain scalars. */
  recordedParams: Record<string, number | string | boolean>;
}

function scalars(params: unknown): CadSource['recordedParams'] {
  if (!params || typeof params !== 'object') return {};
  return Object.fromEntries(
    Object.entries(params as Record<string, unknown>).filter(([, v]) =>
      ['number', 'string', 'boolean'].includes(typeof v),
    ),
  ) as CadSource['recordedParams'];
}

/**
 * The OpenSCAD source of each revision asked for, read once per revision. A revision's source
 * never changes, so nothing here is refetched when the project refreshes.
 */
export function useCadSources(
  artifactId: string,
  revisions: (Revision | null)[],
): Record<string, Loaded<CadSource>> {
  const projectId = useStore((s) => s.projectId);
  const [sources, setSources] = useState<Record<string, Loaded<CadSource>>>({});
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const started = useRef(new Set<string>());
  const wanted = revisions
    .filter(
      (r): r is Revision => !!r && r.files.some((f) => f.path.toLowerCase().endsWith('.scad')),
    )
    .map((r) => `${r.id}:${attempts[r.id] ?? 0}`)
    .join(' ');
  useEffect(() => {
    if (!projectId || !wanted) return;
    for (const request of wanted.split(' ')) {
      if (started.current.has(request)) continue;
      started.current.add(request);
      const revisionId = request.slice(0, request.lastIndexOf(':'));
      const store = (result: Loaded<CadSource>) =>
        setSources((current) => ({ ...current, [revisionId]: result }));
      store({ status: 'loading' });
      cmd<{ source: string; sourcePath: string; recordedParams: unknown }>(
        'cad.read_source',
        { artifactId, revisionId },
        { projectId },
      ).then(
        (r) =>
          store({
            status: 'ready',
            value: {
              revisionId,
              path: r.sourcePath,
              text: r.source,
              recordedParams: scalars(r.recordedParams),
            },
          }),
        (e) =>
          store({
            status: 'failed',
            error: errMsg(e),
            retry: () => setAttempts((a) => ({ ...a, [revisionId]: (a[revisionId] ?? 0) + 1 })),
          }),
      );
    }
  }, [artifactId, projectId, wanted]);
  return sources;
}
