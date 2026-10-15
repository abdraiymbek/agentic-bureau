import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { MechanicalPayload, Revision } from '@omenflow/contracts';
import { errMsg } from '../api';
import { Checkbox, Disclosure, Notice, Segmented, Spinner, State, type Tone } from '../ui/kit';
import { StlViewport, type ViewportStatus } from '../object/StlViewport';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { diffLines, diffPayload, textContent } from '../lib/diff';
import type { VerificationReview } from './model';
import { readRevisionFile } from './io';
import { LineDiff } from './parts';
import { PayloadDiff } from './PayloadDiff';
import { ArtifactContent } from './ArtifactContent';

export type ReviewStatus =
  { state: 'loading' } | { state: 'ready' } | { state: 'error'; reason: string };

/**
 * What the decision may rely on about the proposed geometry: ready only once the mesh is on
 * screen (or the revision records none, which the review says), loading while it is read or
 * parsed, and an error when it cannot be read or shown. `shown` is the candidate viewport's own
 * report for the bytes read now; one from earlier bytes does not count.
 */
export function reviewStatus(
  read: { state: 'none' | 'loading' | 'ready' } | { state: 'error'; message: string },
  shown: ViewportStatus | null,
): ReviewStatus {
  if (read.state === 'loading') return { state: 'loading' };
  if (read.state === 'error')
    return { state: 'error', reason: `The proposed geometry could not be read: ${read.message}` };
  if (read.state === 'none') return { state: 'ready' };
  if (!shown || shown.state === 'parsing' || shown.state === 'empty') return { state: 'loading' };
  if (shown.state === 'error')
    return { state: 'error', reason: `The proposed geometry cannot be shown. ${shown.reason}` };
  return { state: 'ready' };
}

type Load<T> =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: T };

function fileOf(rev: Revision | null, ref: { path: string } | undefined, suffix: string) {
  if (!rev) return undefined;
  if (ref && rev.files.some((f) => f.path === ref.path)) return ref.path;
  return rev.files.find((f) => f.path.toLowerCase().endsWith(suffix))?.path;
}

function useBytes<T>(
  projectId: string | null,
  rev: Revision | null,
  path: string | undefined,
  map: (bytes: Uint8Array) => T,
): Load<T> {
  // A file that exists starts as loading, so the first frame never claims there is no mesh.
  const [load, setLoad] = useState<Load<T>>(() =>
    rev && path ? { state: 'loading' } : { state: 'none' },
  );
  const id = rev?.id;
  const artifactId = rev?.artifactId;
  useEffect(() => {
    if (!id || !artifactId || !path) {
      setLoad({ state: 'none' });
      return;
    }
    let cancelled = false;
    setLoad({ state: 'loading' });
    readRevisionFile(projectId, { id, artifactId }, path)
      .then((bytes) => !cancelled && setLoad({ state: 'ready', data: map(bytes) }))
      .catch((e) => !cancelled && setLoad({ state: 'error', message: errMsg(e) }));
    return () => {
      cancelled = true;
    };
  }, [projectId, id, artifactId, path, map]);
  return load;
}

const toBuffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const toText = (bytes: Uint8Array) => textContent(bytes) ?? '';

const frameWords = (frame: string) =>
  frame === 'right-handed-z-up' ? 'right-handed, Z up' : frame.replaceAll('-', ' ');

const STATUS: Record<string, { label: string; tone: Tone; readiness: string }> = {
  passed: {
    label: 'Checks passed',
    tone: 'ok',
    readiness: 'Ready for its declared scope.',
  },
  partial: {
    label: 'Partly checked',
    tone: 'warn',
    readiness: 'Not ready: only generic checks ran, with no declared scope.',
  },
  scope_changed: {
    label: 'Scope changed',
    tone: 'warn',
    readiness:
      'Not ready: the declared scope differs from the one accepted before. Accepting the new scope with your approval makes it count.',
  },
  failed: {
    label: 'Checks failed',
    tone: 'err',
    readiness: 'Not ready: at least one check failed.',
  },
  unverified: {
    label: 'Not verified',
    tone: 'warn',
    readiness: 'Not ready: no committed check matches this exact revision and render.',
  },
};

function explicitScope(expect: unknown): boolean {
  if (!expect || typeof expect !== 'object') return false;
  return Object.entries(expect).some(
    ([k, v]) =>
      !['watertight', 'minRoundness'].includes(k) &&
      v !== undefined &&
      v !== null &&
      (!Array.isArray(v) || v.length > 0),
  );
}

/** Why the declared scope cannot be accepted, mirroring the core's own refusal; null when it can. */
export function scopeRefusal(v: VerificationReview | undefined): string | null {
  const e = v?.evidence;
  if (!v || !e || !v.evidenceHash) return 'There is no committed check to accept.';
  if (v.status === 'unverified')
    return 'The recorded check no longer counts for this revision, so its scope cannot be accepted.';
  if (e.pass !== true) return 'A check failed, and a failed scope cannot be accepted.';
  if (e.integrity?.pass !== true) return 'The mesh integrity check did not pass.';
  if (!explicitScope(e.expect))
    return 'Only generic checks were declared, so there is no specific scope to accept.';
  return null;
}

function Verification({
  verification,
  accepted,
  onAccept,
  canDecide,
  open,
  onToggle,
}: {
  verification: VerificationReview | undefined;
  accepted: boolean;
  onAccept: (accepted: boolean) => void;
  canDecide: boolean;
  open: Record<string, boolean>;
  onToggle: (key: string) => void;
}) {
  if (!verification)
    return (
      <div className="verify">
        <div className="verify-head">
          <span>Verification</span>
          <State state="none" tone="warn" label="No verification recorded" />
        </div>
        <p className="review-muted">
          No verification recorded for this revision. Approving records the geometry as it is; it
          does not verify it.
        </p>
      </div>
    );
  const meta = STATUS[verification.status] ?? {
    label: verification.status.replaceAll('_', ' '),
    tone: 'warn' as Tone,
    readiness: 'Not ready.',
  };
  const e = verification.evidence;
  const refusal = scopeRefusal(verification);
  return (
    <div className="verify">
      <div className="verify-head">
        <span>Verification</span>
        <State state={verification.status} tone={meta.tone} label={meta.label} />
      </div>
      <p className="verify-ready">
        {verification.status === 'unverified' && e
          ? 'Not ready: a check was recorded, but this object or one of its inputs changed since, or the mesh no longer matches the check.'
          : meta.readiness}
      </p>
      {!e ? null : (
        <>
          {e.exploratory && (
            <Notice>This was an exploratory check. It does not bind a scope.</Notice>
          )}
          {!!e.scopeChanges?.length && (
            <Notice tone="warn">
              The declared scope changed: {e.scopeChanges.join(', ')}. Review it below.
            </Notice>
          )}
          <div className="checks" role="list" aria-label="Checks">
            {e.integrity && (
              <div className="verify-row" role="listitem">
                <State
                  state={e.integrity.pass ? 'passed' : 'failed'}
                  label={e.integrity.pass ? 'Pass' : 'Fail'}
                  quiet
                />
                <span className="check-name">Mesh integrity</span>
                <span className="check-detail mono">{e.integrity.detail}</span>
              </div>
            )}
            {(e.checks ?? []).map((c, i) => (
              <div className="verify-row" role="listitem" key={i}>
                <State
                  state={c.pass ? 'passed' : 'failed'}
                  label={c.pass ? 'Pass' : 'Fail'}
                  quiet
                />
                <span className="check-name">{c.name}</span>
                <span className="check-detail mono">{c.detail}</span>
              </div>
            ))}
            {!e.checks?.length && <p className="review-muted">No assertions were declared.</p>}
          </div>
          <p className="footnote">
            Checks establish only the declared scope
            {e.coverage?.requirementAuthority === 'agent_or_user_declared'
              ? ', which the agent or a person declared'
              : ''}
            . The engineering requirements may ask for more.
          </p>
          <Disclosure
            label="Declared scope"
            meta={[e.coverage?.units, e.coverage?.frame && frameWords(e.coverage.frame)]
              .filter(Boolean)
              .join(' · ')}
            open={!!open.scope}
            onToggle={() => onToggle('scope')}
          >
            <pre className="code-block">{JSON.stringify(e.expect ?? {}, null, 2)}</pre>
          </Disclosure>
          {!!e.coverage?.limitations?.length && (
            <Disclosure
              label="Coverage limits"
              open={!!open.limits}
              onToggle={() => onToggle('limits')}
            >
              <ul className="plain-list">
                {e.coverage.limitations.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </Disclosure>
          )}
        </>
      )}
      <Checkbox
        checked={accepted && !refusal}
        disabled={!!refusal || !canDecide}
        onChange={onAccept}
        label="Accept this declared scope with my approval"
        hint={
          refusal ??
          (verification.status === 'scope_changed'
            ? 'Approving with this ticked records the new scope as accepted, so this revision counts as checked for it.'
            : 'Approving with this ticked records the scope as accepted; later checks are compared against it.')
        }
      />
    </div>
  );
}

type Mode = 'candidate' | 'baseline' | 'side' | 'overlay';

/**
 * The bound meshes of the proposed and baseline revisions. Each view keeps its own viewport
 * mounted once shown, so switching views never re-reads the mesh or moves a camera.
 */
function Geometry({
  next,
  base,
  candidate,
  baseline,
  modelUnit,
  onShown,
}: {
  next: Revision;
  base: Revision | null;
  candidate: Load<ArrayBuffer>;
  baseline: Load<ArrayBuffer>;
  modelUnit: string;
  /** What the proposed revision's own viewport shows of these bytes. */
  onShown: (data: ArrayBuffer, status: ViewportStatus) => void;
}) {
  const [mode, setMode] = useState<Mode>('candidate');
  const [mounted, setMounted] = useState<Set<Mode>>(new Set(['candidate']));
  const both = candidate.state === 'ready' && baseline.state === 'ready';
  const choose = (m: Mode) => {
    setMode(m);
    setMounted(
      (s) => new Set([...s, ...(m === 'side' ? (['candidate', 'baseline'] as const) : [m])]),
    );
  };
  const shows = (view: 'candidate' | 'baseline' | 'overlay') =>
    view === 'overlay' ? mode === 'overlay' : mode === view || mode === 'side';
  if (candidate.state === 'loading')
    return (
      <div className="cad-canvas">
        <div className="mech-empty" role="status">
          <Spinner size={16} />
          <strong>Reading the proposed geometry</strong>
        </div>
      </div>
    );
  if (candidate.state === 'error')
    return (
      <div className="cad-canvas">
        <div className="mech-empty" role="alert">
          <strong>The proposed geometry could not be read</strong>
          <span>{candidate.message}</span>
        </div>
      </div>
    );
  if (candidate.state === 'none')
    return (
      <div className="cad-canvas">
        <div className="mech-empty">
          <strong>No rendered geometry on r{next.seq}</strong>
          <span>There is no mesh to inspect. Approval would not establish verification.</span>
        </div>
      </div>
    );
  return (
    <>
      <div className={`cad-canvas mode-${mode}`}>
        {mounted.has('candidate') && (
          <div className={`cad-view ${shows('candidate') ? '' : 'cad-view-hidden'}`}>
            <StlViewport
              stlData={candidate.data}
              modelUnit={modelUnit}
              onStatus={(status) => onShown(candidate.data, status)}
            />
            <span className="cad-tag island">Proposed r{next.seq}</span>
          </div>
        )}
        {both && mounted.has('baseline') && (
          <div className={`cad-view ${shows('baseline') ? '' : 'cad-view-hidden'}`}>
            <StlViewport stlData={baseline.data} modelUnit={modelUnit} />
            <span className="cad-tag island">Baseline r{base?.seq}</span>
          </div>
        )}
        {both && mounted.has('overlay') && (
          <div className={`cad-view ${shows('overlay') ? '' : 'cad-view-hidden'}`}>
            <StlViewport
              stlData={candidate.data}
              compareData={baseline.data}
              modelUnit={modelUnit}
              label={`Proposed r${next.seq}`}
              compareLabel={base ? `Baseline r${base.seq}` : 'Baseline'}
            />
            <span className="cad-tag island">
              Proposed r{next.seq} solid · baseline r{base?.seq} ghost
            </span>
          </div>
        )}
      </div>
      {both ? (
        <div className="cad-modes">
          <Segmented
            label="Geometry view"
            value={mode}
            onChange={choose}
            options={[
              { value: 'candidate', label: `Proposed r${next.seq}` },
              { value: 'baseline', label: `Baseline r${base?.seq}` },
              { value: 'side', label: 'Side by side' },
              { value: 'overlay', label: 'Overlay' },
            ]}
          />
        </div>
      ) : base && baseline.state === 'error' ? (
        <p className="unknown">The baseline mesh could not be read: {baseline.message}</p>
      ) : base && baseline.state === 'none' ? (
        <p className="review-muted">The baseline r{base.seq} has no mesh to compare with.</p>
      ) : null}
    </>
  );
}

function size(b: MechanicalPayload['bounds']) {
  if (!b) return null;
  return [0, 1, 2].map((i) => Number((b.max[i]! - b.min[i]!).toPrecision(6)));
}

function provenance(payload: MechanicalPayload, rev: Revision): string {
  const identity = payload.renderIdentity;
  const stl =
    rev.files.find((f) => f.path === payload.stl?.path) ??
    rev.files.find((f) => f.path.endsWith('.stl'));
  if (!stl) return '';
  const scad =
    rev.files.find((f) => f.path === payload.scad?.path) ??
    rev.files.find((f) => f.path.endsWith('.scad'));
  if (!identity)
    return 'this mesh has no render record, so it was not rendered from this source in this project.';
  if (identity.outputHash !== stl.sha256 || (scad?.sha256 && identity.sourceHash !== scad.sha256))
    return 'this mesh does not match the recorded render of this source.';
  return `rendered by ${identity.engine} ${identity.engineVersion} from this source · ${frameWords(identity.frame)} · ${identity.modelUnit}.`;
}

/** Mechanical change: geometry, verification evidence, parameters, envelope and source. */
export function CadReview({
  projectId,
  base,
  next,
  verification,
  accepted,
  onAcceptScope,
  canDecide,
  open,
  onToggle,
  onStatus,
}: {
  projectId: string | null;
  base: Revision | null;
  next: Revision;
  verification: VerificationReview | undefined;
  accepted: boolean;
  onAcceptScope: (accepted: boolean) => void;
  canDecide: boolean;
  open: Record<string, boolean>;
  onToggle: (key: string) => void;
  onStatus: (status: ReviewStatus) => void;
}) {
  const payload = next.payload as MechanicalPayload;
  const basePayload = (base?.payload ?? null) as MechanicalPayload | null;
  const candidate = useBytes(projectId, next, fileOf(next, payload.stl, '.stl'), toBuffer);
  const baseline = useBytes(projectId, base, fileOf(base, basePayload?.stl, '.stl'), toBuffer);
  const source = useBytes(projectId, next, fileOf(next, payload.scad, '.scad'), toText);
  const baseSource = useBytes(projectId, base, fileOf(base, basePayload?.scad, '.scad'), toText);

  // Approval waits for the mesh to be on screen, not only for its bytes to arrive.
  const [shown, setShown] = useState<{ data: ArrayBuffer; status: ViewportStatus } | null>(null);
  const status = reviewStatus(
    candidate,
    candidate.state === 'ready' && shown?.data === candidate.data ? shown.status : null,
  );
  const report = useRef(onStatus);
  report.current = onStatus;
  const reason = status.state === 'error' ? status.reason : '';
  useEffect(() => {
    report.current(status.state === 'error' ? { state: 'error', reason } : { state: status.state });
  }, [status.state, reason]);

  const params = useMemo(
    () =>
      diffPayload(
        basePayload ? (basePayload.renderIdentity?.params ?? basePayload.params ?? {}) : {},
        payload.renderIdentity?.params ?? payload.params ?? {},
      ),
    [basePayload, payload],
  );
  const fields = useMemo(
    () =>
      basePayload
        ? diffPayload(basePayload, payload, [
            'scad',
            'stl',
            'renderJobId',
            'renderIdentity',
            'params',
            'bounds',
          ])
        : [],
    [basePayload, payload],
  );
  const sourceLines = useMemo(
    () =>
      source.state === 'ready' && baseSource.state === 'ready'
        ? diffLines(baseSource.data, source.data)
        : null,
    [source, baseSource],
  );
  const [was, now] = [size(basePayload?.bounds), size(payload.bounds)];
  const unit = payload.modelUnit ?? 'mm';
  const fmt = (s: number[] | null) => (s ? `${s.join(' × ')} ${unit}` : 'not recorded');
  const sourceChanged =
    base &&
    source.state === 'ready' &&
    baseSource.state === 'ready' &&
    source.data !== baseSource.data;

  return (
    <div className="cad-review">
      <ErrorBoundary label="The geometry view">
        <Geometry
          next={next}
          base={base}
          candidate={candidate}
          baseline={baseline}
          modelUnit={unit}
          onShown={(data, viewport) => setShown({ data, status: viewport })}
        />
      </ErrorBoundary>
      {provenance(payload, next) && (
        <p className="cad-caption">
          Proposed r{next.seq}: {provenance(payload, next)}
        </p>
      )}
      {base && basePayload && provenance(basePayload, base) && (
        <p className="cad-caption">
          Baseline r{base.seq}: {provenance(basePayload, base)}
        </p>
      )}
      {payload.renderIdentity?.sourceOrientationCorrected && (
        <Notice tone="warn">
          The source produced inverted (inside-out) geometry; the display corrects its orientation.
          Check the source before approving.
        </Notice>
      )}

      <Verification
        verification={verification}
        accepted={accepted}
        onAccept={onAcceptScope}
        canDecide={canDecide}
        open={open}
        onToggle={onToggle}
      />

      <section className="review-block">
        <h4>Envelope</h4>
        <p className="review-qty">
          {base && fmt(was) !== fmt(now) ? (
            <>
              <del className="diff-from">{fmt(was)}</del> →{' '}
              <ins className="diff-to">{fmt(now)}</ins>
            </>
          ) : (
            <>
              {fmt(now)}
              {base ? <span className="dim"> · unchanged</span> : null}
            </>
          )}
        </p>
      </section>

      <section className="review-block">
        <h4>Recorded parameters</h4>
        <p className="cad-caption">
          Values passed to OpenSCAD for the render. Edits to the source itself are under Source
          changes.
        </p>
        {base ? (
          <PayloadDiff entries={params} empty="Parameters unchanged." />
        ) : (
          <ArtifactContent
            type="parameters"
            payload={payload.renderIdentity?.params ?? payload.params ?? {}}
          />
        )}
      </section>

      {fields.length > 0 && (
        <section className="review-block">
          <h4>Other recorded fields</h4>
          <PayloadDiff entries={fields} />
        </section>
      )}

      <Disclosure
        label={base ? 'Source changes' : 'Source'}
        meta={
          source.state === 'none'
            ? 'no source file'
            : base
              ? sourceChanged
                ? 'changed'
                : source.state === 'ready' && baseSource.state === 'ready'
                  ? 'unchanged'
                  : undefined
              : undefined
        }
        open={!!open.source}
        onToggle={() => onToggle('source')}
      >
        {source.state === 'loading' || baseSource.state === 'loading' ? (
          <p className="review-muted" role="status">
            Reading the source…
          </p>
        ) : source.state === 'error' ? (
          <p className="unknown">Could not read the source: {source.message}</p>
        ) : source.state !== 'ready' ? (
          <p className="review-muted">This revision has no source file.</p>
        ) : sourceChanged && sourceLines ? (
          <LineDiff lines={sourceLines} />
        ) : (
          <pre className="code-block">{source.data}</pre>
        )}
      </Disclosure>
    </div>
  );
}
