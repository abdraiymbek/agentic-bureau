import React, { useEffect, useState } from 'react';
import type { FileRef, Job, MechanicalPayload } from '@omenflow/contracts';
import { cmd, errMsg } from '../../api';
import { useStore } from '../../store';
import { Button, Checkbox, Notice, Spinner } from '../../ui/kit';
import { ErrorBoundary } from '../../ui/ErrorBoundary';
import { newestActiveRevision } from '../../lib/mechanical-revisions';
import {
  jobErrorText,
  jobIsActive,
  jobLogExcerpt,
  jobRevisionId,
  jobSeconds,
  meshProvenance,
  renderJobsFor,
  renderPermission,
  type RenderOutcome,
} from '../../lib/render-jobs';
import { RevisionBanner } from '../RevisionBanner';
import { useObjectRevisions } from '../revisions';
import { useOpenEdits } from '../useOpenEdits';
import type { StageProps } from '../stages/shared';
import { StlViewport } from '../viewport/StlViewport';
import { Params } from './Params';
import { Source } from './Source';
import { useCadSources, useRevisionMesh } from './useCad';

const stlOf = (files: FileRef[], recorded?: string) =>
  files.find((f) => f.path === recorded) ??
  files.find((f) => f.path.toLowerCase().endsWith('.stl'));

const PROVENANCE_NOTE = {
  illustrative: 'Illustrative mesh',
  unlinked: 'Mesh not tied to this source',
} as const;

/** The current time while something is running, so elapsed seconds keep counting. */
function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

export function MechanicalStage({ view }: StageProps) {
  const projectId = useStore((s) => s.projectId);
  const readOnly = useStore((s) => s.readOnly);
  const jobs = useStore((s) => s.jobs);
  const revisions = useObjectRevisions(view);
  const artifactId = view.artifact.id;
  const rev = view.revision;
  const p = (rev?.payload ?? {}) as Partial<MechanicalPayload>;
  const history = revisions.revisions ?? [];
  const baseline = history.find((r) => r.id === revisions.baselineId) ?? null;
  const newest = newestActiveRevision(history);
  const openEdits = useOpenEdits(artifactId);
  const editing = openEdits.length > 0;

  const mesh = useRevisionMesh(rev, rev ? stlOf(rev.files, p.stl?.path) : undefined);
  const baselineStl =
    baseline && baseline.id !== rev?.id
      ? stlOf(baseline.files, (baseline.payload as Partial<MechanicalPayload>).stl?.path)
      : undefined;
  const [comparing, setComparing] = useState(false);
  const compare = useRevisionMesh(
    comparing && baselineStl ? baseline : null,
    comparing ? baselineStl : undefined,
  );

  // The displayed source, plus the newest one when an edit may have to move onto it.
  const sources = useCadSources(artifactId, [rev, editing ? newest : null]);
  const [outcomes, setOutcomes] = useState<Record<string, RenderOutcome>>({});
  const outcome = rev ? outcomes[rev.id] : undefined;
  const report = (o: RenderOutcome) => setOutcomes((all) => ({ ...all, [o.revisionId]: o }));

  const partJobs = renderJobsFor(jobs, artifactId);
  const active = partJobs.find(jobIsActive);
  const lastJob = partJobs[0];
  const stopped =
    lastJob && ['failed', 'cancelled', 'interrupted'].includes(lastJob.status) ? lastJob : null;
  // A failed write is already reported by its own outcome below; its job would say it twice.
  const reported =
    !!stopped && !!outcome && !outcome.rendered && jobRevisionId(stopped) === rev?.parentId;
  const shownJob = active ?? (reported ? null : stopped);
  const [requesting, setRequesting] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const permission = renderPermission({
    readOnly,
    displayed: rev,
    revisions: history,
    activeJob: !!active || requesting,
    editing,
  });

  const render = async () => {
    if (!projectId || !rev) return;
    setRequesting(true);
    setRenderError(null);
    try {
      await cmd('cad.render', { artifactId, revisionId: rev.id }, { projectId });
      await useStore.getState().refreshJobs();
    } catch (e) {
      setRenderError(errMsg(e));
    } finally {
      setRequesting(false);
    }
  };

  const provenance = rev ? meshProvenance(p, rev.files) : 'none';
  const acceptBlock = editing
    ? 'Save or discard your edits first.'
    : provenance === 'none'
      ? 'This draft has no geometry: its render failed or has not run. Render it before accepting.'
      : mesh.status !== 'ready'
        ? 'The geometry has to be on screen before this draft can be accepted.'
        : null;

  return (
    <div className="mech">
      <div className="mech-canvas">
        <ErrorBoundary label="The 3D viewport">
          <StlViewport
            mesh={mesh.status === 'ready' ? mesh.value : null}
            compareMesh={compare.status === 'ready' ? compare.value : null}
            modelUnit={p.modelUnit ?? 'mm'}
            label={rev ? `Shown r${rev.seq}` : undefined}
            compareLabel={baseline ? `Baseline r${baseline.seq}` : undefined}
            notice={
              provenance === 'illustrative' || provenance === 'unlinked'
                ? PROVENANCE_NOTE[provenance]
                : null
            }
          />
        </ErrorBoundary>
        {mesh.status !== 'ready' && (
          <div className="mech-empty" role={mesh.status === 'failed' ? 'alert' : 'status'}>
            {mesh.status === 'loading' && <Spinner size={16} />}
            <strong>
              {mesh.status === 'failed'
                ? 'Geometry could not be loaded'
                : mesh.status === 'loading'
                  ? `Loading the geometry of r${rev?.seq ?? ''}`
                  : 'No geometry on this revision'}
            </strong>
            {mesh.status === 'failed' ? (
              <>
                <span>{mesh.error}</span>
                <Button size="sm" onClick={mesh.retry}>
                  Try again
                </Button>
              </>
            ) : (
              mesh.status === 'none' && (
                <span>
                  {outcome && !outcome.rendered
                    ? 'OpenSCAD did not produce a mesh for it. The errors are below.'
                    : 'Nothing was rendered for it. Rendering needs OpenSCAD on this machine.'}
                </span>
              )
            )}
          </div>
        )}
      </div>

      <RevisionBanner view={view} acceptBlock={acceptBlock} />

      <div className="mech-bar">
        <p className="mech-caption">
          {rev ? `Showing r${rev.seq}. ` : ''}
          <span className="dim">Approval does not establish engineering validity.</span>
        </p>
        <div className="mech-actions">
          {baselineStl && baseline && (
            <Checkbox
              checked={comparing}
              onChange={setComparing}
              label={`Compare with baseline r${baseline.seq}`}
            />
          )}
          <Button
            size="sm"
            busy={requesting}
            disabled={!permission.allowed}
            onClick={() => void render()}
          >
            Render r{rev?.seq ?? ''}
          </Button>
        </div>
      </div>
      {!permission.allowed && permission.reason && permission.block !== 'render-running' && (
        <p className="footnote mech-note">{permission.reason}</p>
      )}
      {comparing && compare.status === 'failed' && (
        <Notice tone="err" role="alert">
          The baseline geometry could not be loaded: {compare.error}
        </Notice>
      )}
      {renderError && (
        <Notice tone="err" role="alert">
          The render was not started: {renderError}
        </Notice>
      )}
      {shownJob && (
        <RenderJob
          key={shownJob.id}
          job={shownJob}
          seq={history.find((r) => r.id === jobRevisionId(shownJob))?.seq}
        />
      )}
      {outcome && <Outcome outcome={outcome} seq={rev?.seq} />}
      {provenance === 'illustrative' && <Notice tone="warn">{p.manufacturing}</Notice>}
      {provenance === 'unlinked' && (
        <Notice tone="warn">
          This mesh is not the recorded render of this revision’s source and parameters. It was
          attached separately or carried over from an earlier revision, so it says nothing about
          what the source below produces. Render the revision to see that.
        </Notice>
      )}

      {rev && (
        <div className="mech-detail">
          <Params
            view={view}
            sources={sources}
            onOutcome={report}
            blocked={openEdits.includes('source') ? 'Save or discard the source edit first.' : null}
          />
          <Source
            view={view}
            sources={sources}
            onOutcome={report}
            blocked={
              openEdits.includes('params') ? 'Save or discard the parameter edit first.' : null
            }
          />
        </div>
      )}
    </div>
  );
}

const JOB_WORD: Record<string, string> = {
  queued: 'Queued',
  running: 'Rendering',
  failed: 'Render failed',
  cancelled: 'Render cancelled',
  interrupted: 'Render interrupted',
};

/** One background render as the core reports it: state, elapsed time, errors, and a way out. */
function RenderJob({ job, seq }: { job: Job; seq?: number }) {
  const projectId = useStore((s) => s.projectId);
  const going = jobIsActive(job);
  const now = useClock(going);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const jobId = job.id;

  // Job events may not reach this window for every transition; ask while it is going.
  useEffect(() => {
    if (!going || !projectId) return;
    const timer = window.setInterval(() => {
      void cmd<{ job: Job }>('job.read', { jobId }, { projectId })
        .then((r) => {
          if (r.job.status !== job.status) void useStore.getState().refreshJobs();
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [going, projectId, jobId, job.status]);

  if (dismissed) return null;
  const seconds = jobSeconds(job, now);
  const failure = jobErrorText(job);
  const log = job.status === 'failed' ? jobLogExcerpt(job.log) : [];
  const cancel = async () => {
    if (!projectId) return;
    setCancelling(true);
    setError(null);
    try {
      await cmd('job.cancel', { jobId }, { projectId });
      await useStore.getState().refreshJobs();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setCancelling(false);
    }
  };
  return (
    <Notice
      tone={going ? 'signal' : job.status === 'failed' ? 'err' : 'neutral'}
      role={going ? 'status' : 'alert'}
      action={
        going ? (
          <Button size="sm" busy={cancelling} onClick={() => void cancel()}>
            Cancel render
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
            Dismiss
          </Button>
        )
      }
    >
      <div className="render-job">
        <p>
          {going && <Spinner size={11} />}
          <strong>{JOB_WORD[job.status] ?? job.status}</strong>
          <span className="dim">
            {seq !== undefined ? ` · started from r${seq}` : ''}
            {seconds !== null ? ` · ${seconds} s` : ''} · {job.tool}
          </span>
        </p>
        {!going && failure && <p>{failure}</p>}
        {!going && !failure && job.status !== 'failed' && (
          <p className="dim">No revision was recorded by this render.</p>
        )}
        {log.length > 0 && <pre className="render-log">{log.join('\n')}</pre>}
        {going && error && <p className="tone-warn-text">Not cancelled: {error}</p>}
      </div>
    </Notice>
  );
}

/** What a candidate write actually produced. A failed render is never reported as rendered. */
function Outcome({ outcome, seq }: { outcome: RenderOutcome; seq?: number }) {
  const name = seq !== undefined ? `r${seq}` : 'This revision';
  return (
    <Notice tone={outcome.rendered ? 'ok' : 'err'} role={outcome.rendered ? 'status' : 'alert'}>
      <div className="render-job">
        <p>
          <strong>
            {outcome.rendered
              ? `${name} was rendered by OpenSCAD.`
              : `OpenSCAD could not render ${name}.`}
          </strong>{' '}
          {outcome.rendered
            ? 'It is a draft candidate: inspect and verify it before accepting.'
            : 'It was recorded as a draft without geometry. Fix the source and render again.'}
        </p>
        {outcome.errors.length > 0 && <pre className="render-log">{outcome.errors.join('\n')}</pre>}
        {outcome.warnings.length > 0 && (
          <>
            <p className="dim">Engine warnings</p>
            <pre className="render-log">{outcome.warnings.join('\n')}</pre>
          </>
        )}
        {outcome.notes.map((note) => (
          <p key={note} className="tone-warn-text">
            {note}
          </p>
        ))}
      </div>
    </Notice>
  );
}
