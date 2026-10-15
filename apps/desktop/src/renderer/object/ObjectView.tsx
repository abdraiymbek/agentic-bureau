import React, { useMemo } from 'react';
import { useStore } from '../store';
import { lineageOf } from '../lib/graph';
import { Button, Empty, Skeleton } from '../ui/kit';
import { ObjectRevisionsProvider, useRevisionHistory } from './revisions';
import { LinkList, ObjectRail, Record, RevisionRail } from './rails';
import { StageHeader, StaleNotice } from './StageHeader';
import { ObjectStage } from './stages';

/**
 * Zoom level 1: one object in focus. Its inputs sit on the left, its consequences on
 * the right; moving through the project means moving along those links. One revision is on
 * screen at a time, and the header, both rails and the stage all describe that revision.
 */
export function ObjectView({ id }: { id: string }) {
  const view = useStore((s) => s.artifacts.find((v) => v.artifact.id === id));
  const loaded = useStore((s) => s.artifacts.length > 0);
  const edges = useStore((s) => s.edges);
  const zoomOut = useStore((s) => s.zoomOut);
  const projectId = useStore((s) => s.projectId);
  const revisions = useRevisionHistory(view, id);
  const shown = useMemo(
    () => (view ? { ...view, revision: revisions.displayed } : undefined),
    [view, revisions.displayed],
  );
  const lineage = useMemo(() => lineageOf(id, edges, shown), [id, edges, shown]);

  if (!view || !shown)
    return loaded ? (
      <div className="focus-missing">
        <Empty
          title="This object isn’t in the current record"
          body="It may have been archived or belong to another project."
          action={<Button onClick={zoomOut}>Back to the flow</Button>}
        />
      </div>
    ) : (
      <div className="focus-missing">
        <p className="lens-muted" role="status">
          Loading the record…
        </p>
      </div>
    );

  return (
    <ObjectRevisionsProvider value={revisions}>
      <div className="object-view">
        <ObjectRail side="inputs" label="Inputs and record">
          <LinkList
            title="Depends on"
            links={lineage.upstream}
            side="up"
            empty="No recorded inputs."
          />
          <Record view={shown} />
        </ObjectRail>
        <main className="focus-stage" aria-label={view.artifact.title}>
          <div className="focus-scroll">
            <StageHeader view={shown} />
            <StaleNotice view={shown} />
            {!revisions.revisions ? (
              revisions.error ? (
                <Empty
                  title="Revisions didn’t load"
                  body={revisions.error}
                  action={<Button onClick={() => void revisions.reload()}>Try again</Button>}
                />
              ) : (
                <Skeleton lines={4} />
              )
            ) : !shown.revision ? (
              <Empty
                title="Nothing is recorded for this object"
                body="Ask the agent to create a draft. It will appear here as soon as it is recorded."
              />
            ) : (
              <ObjectStage key={`${projectId}:${id}`} view={shown} />
            )}
          </div>
        </main>
        <ObjectRail side="consequences" label="Consequences and history">
          <LinkList
            title="Affects"
            links={lineage.downstream}
            side="down"
            empty="Nothing depends on this yet."
          />
          {lineage.related.length > 0 && (
            <LinkList title="Related" links={lineage.related} side="down" empty="" />
          )}
          <RevisionRail view={shown} />
        </ObjectRail>
      </div>
    </ObjectRevisionsProvider>
  );
}
