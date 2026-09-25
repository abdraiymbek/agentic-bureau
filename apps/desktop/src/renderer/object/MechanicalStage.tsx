import React, { useEffect, useRef, useState } from 'react';
import type { ArtifactView, MechanicalPayload, Revision } from '@omenflow/contracts';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import { Block, Button, Disclosure, Notice, Spinner, decodeBase64 } from '../ui/kit';
import { StlViewport } from './StlViewport';
import {
  displayedMechanicalRevision,
  mechanicalCandidates,
  mechanicalParameterUnit,
} from '../lib/mechanical-revisions';

export function MechanicalStage({
  view,
  onRevisionChange,
}: {
  view: ArtifactView;
  onRevisionChange?: (revision: Revision | null) => void;
}) {
  const projectId = useStore((s) => s.projectId);
  const readOnly = useStore((s) => s.readOnly);
  const { toast, refreshArtifacts, refreshProposals, decide } = useStore.getState();
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [chosen, choose] = useState<string | null>(null);
  const [revLoading, setRevLoading] = useState(true);
  const [revError, setRevError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [mesh, setMesh] = useState<{ revisionId: string; data: ArrayBuffer } | null>(null);
  const [meshError, setMeshError] = useState<string | null>(null);
  const [meshLoading, setMeshLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sourceEdited, setSourceEdited] = useState(false);
  const [paramsEdited, setParamsEdited] = useState(false);
  const editing = sourceEdited || paramsEdited;
  const baselineId = view.artifact.selectedRevisionId;
  const candidates = mechanicalCandidates(revisions, baselineId);
  const rev = displayedMechanicalRevision(revisions, baselineId, chosen);
  useEffect(() => {
    onRevisionChange?.(rev);
  }, [rev, onRevisionChange]);
  const displayedId = useRef<string | undefined>(rev?.id);
  displayedId.current = rev?.id;
  const p = (rev?.payload ?? {}) as MechanicalPayload;
  const isBaseline = !!rev && rev.id === baselineId;
  const isCandidate = !!rev && candidates.some((r) => r.id === rev.id);
  const shown = { ...view, revision: rev };
  const stlFile =
    rev?.files.find((f) => f.path === p.stl?.path) ??
    rev?.files.find((f) => f.path.endsWith('.stl'));
  const meshPath = stlFile?.path;

  useEffect(() => {
    let active = true;
    if (!projectId) return;
    setRevLoading(true);
    setRevError(null);
    void cmd<{ revisions: Revision[] }>(
      'artifact.history',
      { artifactId: view.artifact.id },
      { projectId },
    )
      .then(
        (r) => active && useStore.getState().projectId === projectId && setRevisions(r.revisions),
      )
      .catch((e) => active && setRevError(errMsg(e)))
      .finally(() => active && setRevLoading(false));
    return () => {
      active = false;
    };
  }, [view, projectId, reload]);

  useEffect(() => {
    let active = true;
    setMesh(null);
    setMeshError(null);
    setMeshLoading(false);
    if (!projectId || !rev?.id || !meshPath) return;
    const revisionId = rev.id;
    setMeshLoading(true);
    void cmd<{ contentBase64: string }>(
      'artifact.read_file',
      { artifactId: view.artifact.id, revisionId, path: meshPath },
      { projectId },
    )
      .then((r) => {
        if (!active || useStore.getState().projectId !== projectId) return;
        setMesh({ revisionId, data: decodeBase64(r.contentBase64).buffer as ArrayBuffer });
      })
      .catch((e) => active && setMeshError(errMsg(e)))
      .finally(() => active && setMeshLoading(false));
    return () => {
      active = false;
    };
  }, [rev?.id, meshPath, view.artifact.id, projectId]);

  const refresh = async (revisionId?: string) => {
    if (useStore.getState().projectId !== projectId) return;
    if (revisionId && displayedId.current === rev?.id) choose(revisionId);
    setReload((v) => v + 1);
    await Promise.all([refreshArtifacts(), refreshProposals()]);
  };

  const render = async () => {
    if (!projectId || !rev) return;
    setBusy(true);
    try {
      await cmd('cad.render', { artifactId: view.artifact.id, revisionId: rev.id }, { projectId });
      if (useStore.getState().projectId !== projectId) return;
      choose(null);
      toast('ok', `Render started for revision ${rev.seq}`);
      await refresh();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const validate = async () => {
    if (!projectId || !rev) return;
    try {
      const r = await cmd<{ ok: boolean; errors: string[] }>(
        'cad.validate_source',
        { artifactId: view.artifact.id, revisionId: rev.id },
        { projectId },
      );
      if (useStore.getState().projectId === projectId)
        toast(
          r.ok ? 'ok' : 'error',
          r.ok
            ? `Saved source on revision ${rev.seq} is valid`
            : r.errors.join('; ') || 'Invalid source',
        );
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  const accept = async () => {
    if (!projectId || !rev || rev.reviewState !== 'draft' || isBaseline) return;
    setBusy(true);
    try {
      await cmd(
        'artifact.accept_draft',
        {
          artifactId: view.artifact.id,
          draftRevisionId: rev.id,
          rationale: `Accept displayed revision ${rev.seq}`,
        },
        { projectId },
      );
      await refresh(rev.id);
      if (useStore.getState().projectId === projectId)
        toast('ok', `Revision ${rev.seq} is now the baseline`);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const meshReady = mesh?.revisionId === rev?.id && !!mesh;
  const canAccept =
    isCandidate &&
    rev?.reviewState === 'draft' &&
    !busy &&
    !editing &&
    !revLoading &&
    !revError &&
    meshReady &&
    !meshError;

  return (
    <div className="mech">
      <div className="mech-canvas">
        {meshReady ? (
          <StlViewport key={rev?.id} stlData={mesh!.data} modelUnit={p.modelUnit ?? 'mm'} />
        ) : (
          <div className="mech-empty">
            {meshLoading || revLoading ? <Spinner size={16} /> : null}
            <strong>
              {meshError
                ? 'Geometry could not be loaded'
                : meshLoading || revLoading
                  ? 'Loading this revision’s geometry'
                  : 'No geometry on this revision'}
            </strong>
            <span>
              {meshError ??
                (meshLoading || revLoading
                  ? ''
                  : 'Render the revision to inspect its mesh. Requires OpenSCAD.')}
            </span>
          </div>
        )}
        <div className="mech-revision island">
          <label htmlFor="mech-rev">Revision</label>
          <select
            id="mech-rev"
            value={rev?.id ?? ''}
            disabled={busy || revLoading || editing}
            onChange={(e) => choose(e.target.value)}
          >
            {!rev && <option value="">{revLoading ? 'Loading…' : 'None'}</option>}
            {[...revisions]
              .sort((a, b) => b.seq - a.seq)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  r{r.seq} ·{' '}
                  {r.id === baselineId
                    ? 'Baseline'
                    : candidates.some((c) => c.id === r.id)
                      ? `Candidate (${r.reviewState})`
                      : `History (${r.reviewState})`}
                </option>
              ))}
          </select>
        </div>
      </div>

      <div className="mech-bar">
        <p className="mech-caption">
          {revError ? (
            <>
              Revisions didn’t load: {revError}{' '}
              <button type="button" className="link" onClick={() => setReload((v) => v + 1)}>
                Retry
              </button>
            </>
          ) : editing ? (
            'Save or discard your edits before switching revisions.'
          ) : rev ? (
            <>
              {isBaseline
                ? 'Showing the baseline.'
                : isCandidate
                  ? 'Showing an unapproved candidate — inspect it before accepting.'
                  : 'Showing a historical revision; editing is off.'}{' '}
              <span className="dim">Approval does not establish engineering validity.</span>
            </>
          ) : null}
        </p>
        <fieldset disabled={readOnly} className="bare row">
          {rev?.reviewState === 'proposed' && (
            <Button size="sm" disabled={editing} onClick={() => decide(null)}>
              Review candidate
            </Button>
          )}
          {isCandidate && rev?.reviewState === 'draft' && (
            <Button size="sm" disabled={!canAccept} onClick={() => void accept()}>
              Accept r{rev.seq} as baseline
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            onClick={() => void render()}
            disabled={
              busy || editing || revLoading || !!revError || !rev || (!isBaseline && !isCandidate)
            }
          >
            {busy ? 'Working…' : `Render r${rev?.seq ?? ''}`}
          </Button>
        </fieldset>
      </div>

      {p.manufacturing?.includes('Illustrative') && <Notice tone="warn">{p.manufacturing}</Notice>}

      {rev && (
        <div className="mech-detail">
          <Params
            key={rev.id}
            params={p.params ?? {}}
            manifest={p.paramManifest ?? []}
            artifactId={view.artifact.id}
            revisionId={rev.id}
            projectId={projectId}
            readOnly={readOnly || !isBaseline || sourceEdited}
            onEdit={() => {
              choose(rev.id);
              setParamsEdited(true);
            }}
            onClean={() => setParamsEdited(false)}
            onSaved={refresh}
          />
          <Source
            view={shown}
            projectId={projectId}
            editable={!readOnly && !paramsEdited && (isBaseline || isCandidate)}
            isBaseline={isBaseline}
            onEdit={() => {
              choose(rev.id);
              setSourceEdited(true);
            }}
            onClean={() => setSourceEdited(false)}
            onSaved={refresh}
            onValidate={() => void validate()}
          />
        </div>
      )}
    </div>
  );
}

function Params(props: {
  params: Record<string, unknown>;
  manifest: MechanicalPayload['paramManifest'];
  artifactId: string;
  revisionId: string;
  projectId: string | null;
  readOnly: boolean;
  onEdit: () => void;
  onClean: () => void;
  onSaved: (revisionId?: string) => Promise<void>;
}) {
  const toast = useStore((s) => s.toast);
  const entries = Object.entries(props.params);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  if (!entries.length) return null;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number'
      ? v
      : v && typeof v === 'object' && 'value' in v
        ? (v as { value?: number }).value
        : undefined;
  const dirty = Object.keys(edits).length > 0;
  const commit = async () => {
    if (!props.projectId || props.readOnly) return;
    const params: Record<string, unknown> = { ...props.params };
    for (const [k, v] of Object.entries(edits)) {
      if (!v.trim() || !Number.isFinite(Number(v))) {
        toast('error', `Enter a finite value for ${k}`);
        return;
      }
      const cur = props.params[k];
      params[k] =
        typeof cur === 'object' && cur !== null
          ? { ...(cur as object), value: Number(v) }
          : Number(v);
    }
    setBusy(true);
    try {
      const r = await cmd<{ revision: Revision }>(
        'artifact.apply_edit',
        {
          artifactId: props.artifactId,
          baseRevisionId: props.revisionId,
          payloadPatch: { params },
          rationale: 'Edit baseline parameters',
        },
        { projectId: props.projectId },
      );
      setEdits({});
      props.onClean();
      await props.onSaved(r.revision.id);
      if (useStore.getState().projectId === props.projectId)
        toast('ok', 'Parameters saved — the geometry needs a new render');
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Block
      title="Parameters"
      count={entries.length}
      actions={
        dirty && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setEdits({});
                props.onClean();
              }}
            >
              Discard
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || props.readOnly}
              onClick={() => void commit()}
            >
              {busy ? 'Saving…' : 'Apply parameters'}
            </Button>
          </>
        )
      }
    >
      <div className="params">
        {entries.map(([k, v]) => {
          const n = num(v);
          const unit = mechanicalParameterUnit(k, v, props.manifest);
          return (
            <label key={k} className={`param ${edits[k] !== undefined ? 'edited' : ''}`}>
              <span className="param-name mono">{k}</span>
              {n !== undefined ? (
                <input
                  aria-label={`${k} (${unit})`}
                  className="num"
                  readOnly={props.readOnly}
                  disabled={busy}
                  value={edits[k] ?? String(n)}
                  onChange={(e) => {
                    props.onEdit();
                    setEdits((s) => ({ ...s, [k]: e.target.value }));
                  }}
                />
              ) : (
                <span className="mono param-static">
                  {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                </span>
              )}
              <span className="param-unit">{unit}</span>
            </label>
          );
        })}
      </div>
      <p className="footnote">
        {dirty
          ? 'Applying creates a new baseline revision. Geometry and dependents must be rebuilt.'
          : props.readOnly
            ? 'Parameters are editable on the baseline of a writable project. Ask the agent to revise them otherwise.'
            : 'Edit a value to change the baseline.'}
      </p>
    </Block>
  );
}

function Source(props: {
  view: ArtifactView;
  projectId: string | null;
  editable: boolean;
  isBaseline: boolean;
  onEdit: () => void;
  onClean: () => void;
  onSaved: (revisionId?: string) => Promise<void>;
  onValidate: () => void;
}) {
  const { view, projectId } = props;
  const toast = useStore((s) => s.toast);
  const scad = view.revision?.files.find((f) => f.path.endsWith('.scad'));
  const sourcePath = scad?.path;
  const revisionId = view.revision?.id;
  const [source, setSource] = useState<{
    revisionId: string;
    text: string;
    original: string;
    recordedParams: Record<string, string | number | boolean>;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, retry] = useState(0);
  const requestId = useRef(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    const token = ++requestId.current;
    if (sourceRef.current?.revisionId !== revisionId) {
      setSource(null);
      setDirty(false);
    }
    setError(null);
    setLoading(false);
    if (!sourcePath || !open || !revisionId || !projectId) return;
    if (sourceRef.current?.revisionId === revisionId) return;
    setLoading(true);
    void cmd<{
      revisionId: string;
      source: string;
      recordedParams: Record<string, string | number | boolean>;
    }>('cad.read_source', { artifactId: view.artifact.id, revisionId }, { projectId })
      .then((r) => {
        if (
          requestId.current === token &&
          r.revisionId === revisionId &&
          useStore.getState().projectId === projectId
        )
          setSource({
            revisionId,
            text: r.source,
            original: r.source,
            recordedParams: r.recordedParams,
          });
      })
      .catch((e) => requestId.current === token && setError(errMsg(e)))
      .finally(() => requestId.current === token && setLoading(false));
    return () => {
      requestId.current = token + 1;
    };
  }, [sourcePath, revisionId, open, projectId, view.artifact.id, attempt]);

  const save = async () => {
    if (!source || source.revisionId !== revisionId || !scad || !projectId || !props.editable)
      return;
    setBusy(true);
    setError(null);
    try {
      let saved: string;
      if (props.isBaseline) {
        const r = await cmd<{ revision: Revision }>(
          'artifact.apply_edit',
          {
            artifactId: view.artifact.id,
            baseRevisionId: revisionId,
            fileWrites: [
              { path: scad.path, contentBase64: btoa(unescape(encodeURIComponent(source.text))) },
            ],
            rationale: 'Edit baseline source',
          },
          { projectId },
        );
        saved = r.revision.id;
      } else {
        const r = await cmd<{ revisionId: string }>(
          'cad.write_source',
          {
            artifactId: view.artifact.id,
            expectedRevisionId: revisionId,
            source: source.text,
            params: source.recordedParams,
            rationale: 'Revise displayed candidate source',
          },
          { projectId },
        );
        saved = r.revisionId;
      }
      setDirty(false);
      props.onClean();
      await props.onSaved(saved);
      if (useStore.getState().projectId === projectId)
        toast(
          'ok',
          props.isBaseline
            ? 'Source saved — the geometry needs a new render'
            : 'New candidate rendered — review and verify it before accepting',
        );
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (!scad) return null;
  return (
    <Disclosure
      label="OpenSCAD source"
      meta={<span className="mono">{scad.path}</span>}
      open={open}
      onToggle={() => !busy && setOpen((o) => !o)}
      actions={
        <>
          {dirty && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setSource((s) => (s ? { ...s, text: s.original } : s));
                setDirty(false);
                props.onClean();
              }}
            >
              Discard
            </Button>
          )}
          <Button size="sm" onClick={props.onValidate} disabled={loading || busy || dirty}>
            Validate saved source
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void save()}
            disabled={!dirty || !props.editable || busy || loading}
          >
            {busy ? 'Saving…' : props.isBaseline ? 'Save source' : 'Render new candidate'}
          </Button>
        </>
      }
    >
      {loading && (
        <p className="dim" role="status">
          Loading revision {view.revision?.seq} source…
        </p>
      )}
      {error && (
        <Notice
          tone="warn"
          role="alert"
          action={
            !source && (
              <Button size="sm" onClick={() => retry((a) => a + 1)}>
                Retry
              </Button>
            )
          }
        >
          {error}
        </Notice>
      )}
      <textarea
        aria-label="OpenSCAD source"
        className="code-editor"
        spellCheck={false}
        rows={18}
        readOnly={!props.editable}
        disabled={busy || loading || source?.revisionId !== revisionId}
        value={source?.revisionId === revisionId ? (source?.text ?? '') : ''}
        onChange={(e) => {
          props.onEdit();
          setSource((s) => (s ? { ...s, text: e.target.value } : s));
          setDirty(true);
        }}
      />
      <p className="footnote">
        {!props.editable
          ? 'This revision is read-only.'
          : source && Object.keys(source.recordedParams).length
            ? 'Recorded parameter overrides are preserved when saving this source.'
            : props.isBaseline
              ? 'Saving creates a new baseline revision.'
              : 'Saving renders a new candidate for review.'}
      </p>
    </Disclosure>
  );
}
