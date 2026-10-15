import React, { useState } from 'react';
import { useStore } from '../store';
import { Button, Notice, Skeleton } from '../ui/kit';
import { RECORD, failureSentence, loadFailure } from './load-copy';

/** Shown while a code-split view arrives. */
export function StageFallback() {
  return (
    <div className="frame-stage-wait">
      <Skeleton lines={3} width={360} />
    </div>
  );
}

/**
 * The stage between opening a project and its record arriving. The name and intent are
 * already known from opening it; the record is drawn as a placeholder, never as an empty
 * project. If the record cannot be read, the stage says so and offers to try again.
 */
export function ProjectLoading() {
  const project = useStore((s) => s.project);
  const load = useStore((s) => s.load);
  const retryLoad = useStore((s) => s.retryLoad);
  const [retrying, setRetrying] = useState(false);
  const failure = loadFailure(load, RECORD);
  return (
    <div className="project" aria-busy={!failure}>
      <header className="project-head">
        <div className="identity">
          <h1>{project?.name}</h1>
          {project?.intent && <p className="identity-intent">{project.intent}</p>}
        </div>
      </header>
      <div className="frame-record">
        {failure ? (
          <Notice
            tone="err"
            role="alert"
            action={
              <Button
                size="sm"
                busy={retrying}
                onClick={() => {
                  setRetrying(true);
                  void retryLoad().finally(() => setRetrying(false));
                }}
              >
                Try again
              </Button>
            }
          >
            <strong>{failureSentence(failure)}</strong> {failure.message} Nothing in the project was
            changed.
          </Notice>
        ) : (
          <>
            <Skeleton lines={1} width={180} />
            <Skeleton lines={4} width="min(560px, 100%)" />
          </>
        )}
      </div>
    </div>
  );
}
