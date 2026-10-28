import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { errMsg } from '../api';
import { useStore } from '../store';
import { Empty, Skeleton } from '../ui/kit';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { ProjectHead } from './flow/chrome';
// Starts watching for a project's first load before any project opens.
import { lensDef, type Lens, type LensDef } from './lenses';

/** One lazy component per lens, so a lens keeps its identity across renders. */
const loaded = new Map<Lens, React.LazyExoticComponent<React.ComponentType>>();
function lensBody(def: LensDef) {
  let body = loaded.get(def.id);
  if (!body) {
    body = React.lazy(def.load);
    loaded.set(def.id, body);
  }
  return body;
}

/** Zoom level 0: the whole project, seen through one lens at a time. */
export function ProjectView({ lens }: { lens: Lens }) {
  const [, setAttempt] = useState(0);
  const [head, setHead] = useState<HTMLElement | null>(null);
  const def = lensDef(lens);
  const Body = def && lensBody(def);
  return (
    <div className={`project lens-${lens}`}>
      <header className="project-head" ref={setHead}>
        <Identity />
      </header>
      {Body ? (
        <ErrorBoundary
          key={lens}
          label={`The ${def.label} lens`}
          onRetry={() => {
            // A lens that failed to load is fetched again rather than replayed.
            loaded.delete(lens);
            setAttempt((n) => n + 1);
          }}
        >
          <Suspense
            fallback={
              <div className="lens-page">
                <Skeleton lines={4} width={420} />
              </div>
            }
          >
            <ProjectHead.Provider value={head}>
              <Body />
            </ProjectHead.Provider>
          </Suspense>
        </ErrorBoundary>
      ) : (
        <div className="lens-page">
          <Empty
            title="This lens is not available"
            body={`No view is registered for “${lens}” in this build.`}
          />
        </div>
      )}
    </div>
  );
}

function Identity() {
  const project = useStore((s) => s.project);
  const readOnly = useStore((s) => s.readOnly);
  const artifacts = useStore((s) => s.artifacts);
  const edges = useStore((s) => s.edges);
  const toast = useStore((s) => s.toast);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project?.intent ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  // Enter saves and removes the field; the blur that follows must not save a second time.
  const saved = useRef(false);
  useEffect(() => {
    if (!editing) setDraft(project?.intent ?? '');
  }, [project?.intent, editing]);
  useEffect(() => {
    if (!editing) return;
    saved.current = false;
    ref.current?.focus();
  }, [editing]);
  // Links between objects that are both in the project: what the flow draws.
  const links = useMemo(() => {
    const known = new Set(artifacts.map((v) => v.artifact.id));
    return edges.filter((e) => known.has(e.upstreamArtifactId) && known.has(e.downstreamArtifactId))
      .length;
  }, [artifacts, edges]);
  const save = async () => {
    if (saved.current) return;
    saved.current = true;
    const next = draft.trim();
    setEditing(false);
    if (!project || next === project.intent) return;
    try {
      // Shown at once; the store puts the old text back if the save fails.
      await useStore.getState().updateIntent(next);
    } catch (e) {
      toast('error', errMsg(e));
    }
  };
  return (
    <div className="identity">
      <h1 className="sr-only">{project?.name}</h1>
      {editing ? (
        <textarea
          ref={ref}
          className="identity-intent editing"
          aria-label="Project intent"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void save();
            }
            if (e.key === 'Escape') {
              e.stopPropagation();
              saved.current = true;
              setDraft(project?.intent ?? '');
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="identity-intent"
          disabled={readOnly}
          onClick={() => setEditing(true)}
          title={readOnly ? undefined : 'Edit the project intent'}
        >
          <span>{project?.intent || 'Add one sentence about what this must become.'}</span>
        </button>
      )}
      {artifacts.length > 0 && (
        <p className="identity-meta">
          {artifacts.length} {artifacts.length === 1 ? 'object' : 'objects'} · {links} recorded{' '}
          {links === 1 ? 'link' : 'links'}
        </p>
      )}
    </div>
  );
}
