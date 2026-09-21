import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import { StlViewport } from '../components/StlViewport';
import { MarkdownView } from '../components/MarkdownView';
import { RequirementSurface } from './RequirementsView';
import DOMPurify from 'dompurify';
import type {
  ArtifactType,
  SourcePayload,
  AssemblyPayload,
  ComponentPayload,
  SoftwarePayload,
  ConceptPayload,
  ArtifactView,
  CalculationPayload,
  MechanicalPayload,
  Revision,
  TestPayload,
  WiringPayload,
  MaybeQuantity,
  EvidenceKind,
} from '@omenflow/contracts';
import { formatQty, isUnknown } from '@omenflow/contracts';
import {
  ArtifactIcon,
  FormField,
  EmptyState,
  ObjectGroup,
  ObjectRow,
  PageHeader,
  SearchField,
  StatusBadge,
  typeLabels,
} from '../components/ui';
import { InspectButton } from '../components/InspectButton';
import { CaretRight } from '@phosphor-icons/react';
import {
  displayedMechanicalRevision,
  mechanicalCandidates,
  mechanicalParameterUnit,
} from './mechanical-revisions';

const TYPE_ORDER: ArtifactType[] = [
  'mechanical',
  'wiring',
  'software',
  'calculation',
  'test',
  'assembly',
  'architecture',
  'concept',
  'subsystem',
  'requirement',
  'assumption',
  'component',
  'source',
  'note',
];

export function ArtifactsView() {
  const { artifacts, selectedArtifactId, selectArtifact, projectId } = useStore();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<ArtifactType>>(new Set());
  const toggleGroup = (type: ArtifactType) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  const grouped = useMemo(
    () =>
      TYPE_ORDER.map(
        (type) =>
          [
            type,
            artifacts.filter(
              (v) =>
                v.artifact.type === type &&
                v.artifact.title.toLowerCase().includes(query.toLowerCase()),
            ),
          ] as const,
      ).filter(([, views]) => views.length),
    [artifacts, query],
  );
  const selected =
    artifacts.find((v) => v.artifact.id === selectedArtifactId) ?? grouped[0]?.[1][0];
  useEffect(() => {
    if (selected && selected.artifact.id !== selectedArtifactId)
      selectArtifact(selected.artifact.id);
  }, [selected, selectedArtifactId, selectArtifact]);
  return (
    <div className="page">
      <PageHeader title="Design files" count={artifacts.length} compact />
      <div className="object-layout">
        <aside className="object-browser" aria-label="Project objects">
          <SearchField value={query} onChange={setQuery} placeholder="Find a design file" />
          {grouped.map(([type, views]) => {
            const holdsSelection = views.some((v) => v.artifact.id === selected?.artifact.id);
            return (
              <ObjectGroup
                key={type}
                label={typeLabels[type] ?? type}
                count={views.length}
                // A search or the current selection always shows its group.
                collapsed={collapsed.has(type) && !query && !holdsSelection}
                onToggle={() => toggleGroup(type)}
              >
                {views.map((v) => (
                  <ObjectRow
                    key={v.artifact.id}
                    view={v}
                    selected={selected?.artifact.id === v.artifact.id}
                    onClick={() => selectArtifact(v.artifact.id)}
                  />
                ))}
              </ObjectGroup>
            );
          })}
          {!grouped.length && (
            <p className="browser-empty">
              {query ? 'No matching design files.' : 'No engineering objects yet.'}
            </p>
          )}
        </aside>
        <div className="object-detail flush">
          {selected ? (
            <ArtifactDetail key={`${projectId}:${selected.artifact.id}`} view={selected} />
          ) : (
            <EmptyState
              title="A home for every part of the design"
              body="Create models, wiring, calculations, and test procedures with your agent. Their revisions and evidence stay connected here."
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ArtifactDetail({ view }: { view: ArtifactView }) {
  switch (view.artifact.type) {
    case 'requirement':
    case 'assumption':
      return (
        <div className="document-detail">
          <RequirementSurface view={view} />
        </div>
      );
    case 'mechanical':
      return <MechanicalDetail view={view} />;
    case 'wiring':
      return <WiringDetail view={view} />;
    case 'calculation':
      return <CalcDetail view={view} />;
    case 'test':
      return <TestDetail view={view} />;
    case 'source':
      return <SourceDetail view={view} />;
    case 'assembly':
      return <AssemblyDetail view={view} />;
    case 'component':
      return <ComponentDetail view={view} />;
    case 'software':
      return <SoftwareDetail view={view} />;
    case 'concept':
      return <ConceptDetail view={view} />;
    default:
      return <GenericDetail view={view} />;
  }
}

/* ------------------------------------------------------------------ */
/* Mechanical                                                          */
/* ------------------------------------------------------------------ */

function MechanicalDetail({ view }: { view: ArtifactView }) {
  const { toast, refreshArtifacts, refreshProposals, projectId, readOnly, set } = useStore();
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [chosenRevisionId, chooseRevision] = useState<string | null>(null);
  const [revisionLoading, setRevisionLoading] = useState(true);
  const [revisionError, setRevisionError] = useState<string | null>(null);
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
  const rev = displayedMechanicalRevision(revisions, baselineId, chosenRevisionId);
  const displayedId = useRef<string | undefined>(rev?.id);
  displayedId.current = rev?.id;
  const p = (rev?.payload ?? {}) as MechanicalPayload;
  const isBaseline = !!rev && rev.id === baselineId;
  const isCandidate = !!rev && candidates.some((r) => r.id === rev.id);
  const visibleView = { ...view, revision: rev };
  const stlFile =
    rev?.files.find((f) => f.path === p.stl?.path) ??
    rev?.files.find((f) => f.path.endsWith('.stl'));
  const meshPath = stlFile?.path;
  const displayedRevisionId = rev?.id;

  useEffect(() => {
    let active = true;
    if (!projectId) return;
    setRevisionLoading(true);
    setRevisionError(null);
    void cmd<{ revisions: Revision[] }>(
      'artifact.history',
      { artifactId: view.artifact.id },
      { projectId },
    )
      .then((r) => {
        if (active && useStore.getState().projectId === projectId) setRevisions(r.revisions);
      })
      .catch((error) => {
        if (active) setRevisionError(errMsg(error));
      })
      .finally(() => {
        if (active) setRevisionLoading(false);
      });
    return () => {
      active = false;
    };
  }, [view, projectId, reload]);

  useEffect(() => {
    let active = true;
    setMesh(null);
    setMeshError(null);
    setMeshLoading(false);
    if (!projectId || !displayedRevisionId || !meshPath) return;
    const revisionId = displayedRevisionId;
    setMeshLoading(true);
    void cmd<{ contentBase64: string }>(
      'artifact.read_file',
      {
        artifactId: view.artifact.id,
        revisionId,
        path: meshPath,
      },
      { projectId },
    )
      .then((result) => {
        if (!active || useStore.getState().projectId !== projectId) return;
        const bytes = Uint8Array.from(atob(result.contentBase64), (c) => c.charCodeAt(0));
        setMesh({ revisionId, data: bytes.buffer as ArrayBuffer });
      })
      .catch((error) => {
        if (active) setMeshError(errMsg(error));
      })
      .finally(() => {
        if (active) setMeshLoading(false);
      });
    return () => {
      active = false;
    };
  }, [displayedRevisionId, meshPath, view.artifact.id, projectId]);

  const refresh = async (revisionId?: string) => {
    if (useStore.getState().projectId !== projectId) return;
    if (revisionId && displayedId.current === rev?.id) chooseRevision(revisionId);
    setReload((v) => v + 1);
    await Promise.all([refreshArtifacts(), refreshProposals()]);
  };
  const render = async () => {
    if (!projectId || !rev) return;
    setBusy(true);
    try {
      await cmd('cad.render', { artifactId: view.artifact.id, revisionId: rev.id }, { projectId });
      if (useStore.getState().projectId !== projectId) return;
      chooseRevision(null);
      toast('ok', 'Render job started for the displayed revision');
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
        {
          artifactId: view.artifact.id,
          revisionId: rev.id,
        },
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
  const acceptDraft = async () => {
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
        toast('ok', `Revision ${rev.seq} accepted as baseline`);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mechanical-detail">
      <Header
        view={visibleView}
        actions={
          <>
            <button
              className="primary compact"
              onClick={render}
              disabled={
                busy ||
                editing ||
                revisionLoading ||
                !!revisionError ||
                !rev ||
                (!isBaseline && !isCandidate)
              }
            >
              {busy ? 'Working…' : 'Render displayed revision'}
            </button>
            {isCandidate && rev?.reviewState === 'draft' && (
              <button
                className="compact"
                onClick={acceptDraft}
                disabled={
                  busy ||
                  editing ||
                  revisionLoading ||
                  !!revisionError ||
                  meshLoading ||
                  !mesh ||
                  mesh.revisionId !== rev.id ||
                  !!meshError
                }
              >
                Accept displayed draft {rev.seq}
              </button>
            )}
            {rev?.reviewState === 'proposed' && (
              <button
                className="compact"
                disabled={editing}
                onClick={() => set({ nav: 'reviews' })}
              >
                Review candidate
              </button>
            )}
          </>
        }
      />
      <section className="detail-section">
        <FormField label="Displayed revision">
          <select
            aria-label="Displayed mechanical revision"
            value={rev?.id ?? ''}
            disabled={busy || revisionLoading || editing}
            onChange={(event) => chooseRevision(event.target.value)}
          >
            {!rev && (
              <option value="">
                {revisionLoading ? 'Loading revisions…' : 'No revision available'}
              </option>
            )}
            {[...revisions]
              .sort((a, b) => b.seq - a.seq)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id === baselineId
                    ? 'Selected baseline'
                    : candidates.some((candidate) => candidate.id === r.id)
                      ? 'Candidate'
                      : 'History'}{' '}
                  · revision {r.seq} · {r.reviewState}
                </option>
              ))}
          </select>
        </FormField>
        {editing && (
          <p className="table-footnote">Save or discard local edits before switching revisions.</p>
        )}
        {revisionError && (
          <div className="inline-notice warning" role="alert">
            Could not load revisions: {revisionError}{' '}
            <button className="compact" onClick={() => setReload((v) => v + 1)}>
              Retry
            </button>
          </div>
        )}
        {rev && (
          <p className="table-footnote">
            {isBaseline
              ? 'Showing the selected baseline.'
              : isCandidate
                ? 'Showing an unapproved candidate. Inspect this revision before accepting it.'
                : 'Showing a historical revision; editing is disabled.'}{' '}
            Approval does not establish engineering validity.
          </p>
        )}
      </section>
      <div className="canvas-frame">
        {mesh?.revisionId === rev?.id && mesh ? (
          <StlViewport key={rev?.id} stlData={mesh.data} modelUnit={p.modelUnit ?? 'mm'} />
        ) : (
          <EmptyState
            title={
              meshError
                ? 'Geometry could not be loaded'
                : meshLoading || revisionLoading
                  ? 'Loading geometry…'
                  : 'No geometry on this revision'
            }
            body={
              meshError ??
              (meshLoading || revisionLoading
                ? 'Loading the exact displayed revision.'
                : 'Render this revision to inspect its mesh. OpenSCAD is required.')
            }
          />
        )}
      </div>
      {p.manufacturing?.includes('Illustrative') && (
        <div className="inline-notice warning">{p.manufacturing}</div>
      )}
      {rev && (
        <>
          <ParamsTable
            key={rev.id}
            params={p.params ?? {}}
            paramManifest={p.paramManifest ?? []}
            artifactId={view.artifact.id}
            revisionId={rev.id}
            projectId={projectId}
            readOnly={readOnly || !isBaseline || sourceEdited}
            onEdit={() => {
              chooseRevision(rev.id);
              setParamsEdited(true);
            }}
            onClean={() => setParamsEdited(false)}
            onSaved={refresh}
          />
          <ScadEditor
            view={visibleView}
            projectId={projectId}
            editable={!readOnly && !paramsEdited && (isBaseline || isCandidate)}
            isBaseline={isBaseline}
            onEdit={() => {
              chooseRevision(rev.id);
              setSourceEdited(true);
            }}
            onClean={() => setSourceEdited(false)}
            onSaved={refresh}
            onValidate={validate}
          />
        </>
      )}
    </div>
  );
}

function ParamsTable(props: {
  params: Record<string, unknown>;
  paramManifest: MechanicalPayload['paramManifest'];
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
  if (entries.length === 0) return null;
  const numOf = (v: unknown): number | undefined =>
    typeof v === 'number'
      ? v
      : v && typeof v === 'object' && 'value' in v
        ? (v as { value?: number }).value
        : undefined;
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
      const result = await cmd<{ revision: Revision }>(
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
      await props.onSaved(result.revision.id);
      if (useStore.getState().projectId === props.projectId)
        toast('ok', 'Parameters saved; geometry needs a new render');
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const dirty = Object.keys(edits).length > 0;
  return (
    <section className="detail-section">
      <div className="section-heading">
        <h2>
          Parameter overrides<span className="count">{entries.length}</span>
        </h2>
        {dirty && (
          <div className="row">
            <button
              className="ghost compact"
              disabled={busy}
              onClick={() => {
                setEdits({});
                props.onClean();
              }}
            >
              Discard
            </button>
            <button className="primary compact" disabled={busy || props.readOnly} onClick={commit}>
              {busy ? 'Saving…' : 'Apply parameters'}
            </button>
          </div>
        )}
      </div>
      <table className="params-table">
        <tbody>
          {entries.map(([k, v]) => {
            const n = numOf(v);
            const unit = mechanicalParameterUnit(k, v, props.paramManifest);
            return (
              <tr key={k}>
                <td className="dim">{k}</td>
                <td>
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
                    <span className="mono">
                      {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                    </span>
                  )}
                </td>
                <td className="faint">{unit}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {props.readOnly && (
        <p className="table-footnote">
          Recorded parameter overrides are read-only in this view. Ask the agent to revise them, or
          edit the selected baseline in a writable project.
        </p>
      )}
      {dirty && (
        <p className="table-footnote">
          Applying creates a new baseline revision. Geometry and dependent objects must be rebuilt.
        </p>
      )}
    </section>
  );
}

function ScadEditor({
  view,
  projectId,
  editable,
  isBaseline,
  onEdit,
  onClean,
  onSaved,
  onValidate,
}: {
  view: ArtifactView;
  projectId: string | null;
  editable: boolean;
  isBaseline: boolean;
  onEdit: () => void;
  onClean: () => void;
  onSaved: (revisionId?: string) => Promise<void>;
  onValidate: () => void;
}) {
  const toast = useStore((s) => s.toast);
  const scad = view.revision?.files.find((f) => f.path.endsWith('.scad'));
  const sourcePath = scad?.path;
  const revisionId = view.revision?.id;
  const [source, setSource] = useState<{
    revisionId: string;
    text: string;
    originalText: string;
    recordedParams: Record<string, string | number | boolean>;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, retryLoad] = useState(0);
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
    }>(
      'cad.read_source',
      {
        artifactId: view.artifact.id,
        revisionId,
      },
      { projectId },
    )
      .then((result) => {
        if (
          requestId.current === token &&
          result.revisionId === revisionId &&
          useStore.getState().projectId === projectId
        )
          setSource({
            revisionId,
            text: result.source,
            originalText: result.source,
            recordedParams: result.recordedParams,
          });
      })
      .catch((e) => {
        if (requestId.current === token) setError(errMsg(e));
      })
      .finally(() => {
        if (requestId.current === token) setLoading(false);
      });
    return () => {
      requestId.current = token + 1;
    };
  }, [sourcePath, revisionId, open, projectId, view.artifact.id, loadAttempt]);
  const save = async () => {
    if (!source || source.revisionId !== revisionId || !scad || !projectId || !editable) return;
    setBusy(true);
    setError(null);
    try {
      let savedRevisionId: string;
      if (isBaseline) {
        const result = await cmd<{ revision: Revision }>(
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
        savedRevisionId = result.revision.id;
      } else {
        const result = await cmd<{ revisionId: string }>(
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
        savedRevisionId = result.revisionId;
      }
      setDirty(false);
      onClean();
      await onSaved(savedRevisionId);
      if (useStore.getState().projectId === projectId)
        toast(
          'ok',
          isBaseline
            ? 'Source saved; geometry needs a new render'
            : 'New candidate rendered; review and verify it before accepting',
        );
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  if (!scad) return null;
  return (
    <section className="detail-section">
      <div className="section-heading">
        <button
          className="disclosure"
          aria-expanded={open}
          disabled={busy}
          onClick={() => setOpen((o) => !o)}
        >
          <CaretRight size={12} className={`object-group-caret ${open ? 'open' : ''}`} />
          Source<span className="mono faint">{scad.path}</span>
        </button>
        {open && (
          <div className="row">
            {dirty && (
              <button
                className="ghost compact"
                disabled={busy}
                onClick={() => {
                  setSource((s) => (s ? { ...s, text: s.originalText } : s));
                  setDirty(false);
                  onClean();
                }}
              >
                Discard
              </button>
            )}
            <button className="compact" onClick={onValidate} disabled={loading || busy || dirty}>
              Validate saved source
            </button>
            <button
              className="primary compact"
              onClick={save}
              disabled={!dirty || !editable || busy || loading}
            >
              {busy ? 'Saving…' : isBaseline ? 'Save source' : 'Render new candidate'}
            </button>
          </div>
        )}
      </div>
      {open && (
        <>
          {loading && (
            <p className="dim" role="status">
              Loading revision {view.revision?.seq} source…
            </p>
          )}
          {error && (
            <div className="inline-notice warning" role="alert">
              {error}
              {!source && (
                <button className="compact" onClick={() => retryLoad((attempt) => attempt + 1)}>
                  Retry source load
                </button>
              )}
            </div>
          )}
          <textarea
            aria-label="OpenSCAD source"
            className="mono source-editor"
            rows={16}
            readOnly={!editable}
            disabled={busy || loading || source?.revisionId !== revisionId}
            value={source?.revisionId === revisionId ? (source?.text ?? '') : ''}
            onChange={(e) => {
              onEdit();
              setSource((s) => (s ? { ...s, text: e.target.value } : s));
              setDirty(true);
            }}
          />
          {source && Object.keys(source.recordedParams).length > 0 && (
            <p className="table-footnote">
              Recorded parameter overrides are preserved when saving this source.
            </p>
          )}
          {!editable && <p className="table-footnote">This revision is read-only.</p>}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function WiringDetail({ view }: { view: ArtifactView }) {
  const { toast, selectArtifact, artifacts } = useStore();
  const p = (view.revision?.payload ?? {}) as WiringPayload;
  const [findings, setFindings] = useState<
    { severity: string; code: string; message: string }[] | null
  >(null);
  const [coverage, setCoverage] = useState('');
  const [busy, setBusy] = useState(false);
  const [diagram, setDiagram] = useState<{ svg: string } | null>(null);

  const validate = async () => {
    setBusy(true);
    try {
      const r = await cmd<{
        findings: { severity: string; code: string; message: string }[];
        coverage: string;
      }>('wiring.validate', { artifactId: view.artifact.id });
      setFindings(r.findings);
      setCoverage(r.coverage);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const render = async () => {
    try {
      setDiagram(await cmd<{ svg: string }>('wiring.render', { artifactId: view.artifact.id }));
    } catch (e) {
      toast('error', errMsg(e));
    }
  };
  const title = (id: string) =>
    artifacts.find((v) => v.artifact.id === id)?.artifact.title ?? id.slice(0, 8);

  return (
    <div style={{ padding: 24 }}>
      <Header
        view={view}
        actions={
          <>
            <button className="compact" disabled={busy} onClick={validate}>
              {busy ? 'Checking…' : 'Validate wiring'}
            </button>
            <button className="compact" onClick={render}>
              Render diagram
            </button>
          </>
        }
      />
      <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>
        Connections ({p.connections?.length ?? 0})
      </div>
      <div className="data-table-wrap">
        <table className="data-table wiring-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>From</th>
              <th style={{ textAlign: 'left' }}>To</th>
              <th style={{ textAlign: 'left' }}>Signal</th>
              <th style={{ textAlign: 'left' }}>Voltage</th>
              <th style={{ textAlign: 'left' }}>Wire</th>
            </tr>
          </thead>
          <tbody>
            {(p.connections ?? []).map((c, i) => (
              <tr key={i}>
                <td>
                  <button
                    className="table-title-button"
                    onClick={() => selectArtifact(c.from.componentArtifactId)}
                  >
                    {title(c.from.componentArtifactId)}
                  </button>
                  <small className="mono">{c.from.pin}</small>
                </td>
                <td>
                  <button
                    className="table-title-button"
                    onClick={() => selectArtifact(c.to.componentArtifactId)}
                  >
                    {title(c.to.componentArtifactId)}
                  </button>
                  <small className="mono">{c.to.pin}</small>
                </td>
                <td>{c.signalRole}</td>
                <td className="num">{c.voltage ? formatQty(c.voltage) : '—'}</td>
                <td className="dim">
                  {c.wire?.gauge ?? '—'}
                  {c.wire?.currentRating ? ` (${formatQty(c.wire.currentRating)})` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {findings && (
        <div style={{ marginTop: 12 }}>
          {findings.length === 0 && (
            <div className="ok" style={{ fontSize: 12 }}>
              No findings
            </div>
          )}
          {findings.map((f, i) => (
            <div
              key={i}
              className={f.severity === 'error' ? 'err' : f.severity === 'warning' ? 'warn' : 'dim'}
              style={{ fontSize: 12, padding: '10px 0', borderBottom: '1px solid var(--border)' }}
            >
              {f.severity === 'error' ? 'Error' : 'Warning'}:{' '}
              {f.message.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, (id) => {
                const component = artifacts.find((v) => v.artifact.id === id);
                if (component) return component.artifact.title;
                const connection = p.connections.findIndex((c) => c.id === id);
                return connection >= 0 ? `connection ${connection + 1}` : id;
              })}
            </div>
          ))}
        </div>
      )}
      {coverage && (
        <p className="dim" style={{ fontSize: 12, marginTop: 16 }}>
          {coverage}
        </p>
      )}
      {diagram && (
        <div
          style={{
            marginTop: 12,
            border: '1px solid var(--border)',
            borderRadius: 6,
            overflow: 'auto',
          }}
          dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(diagram.svg, { USE_PROFILES: { svg: true } }),
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Calculation                                                          */
/* ------------------------------------------------------------------ */

function CalcDetail({ view }: { view: ArtifactView }) {
  const { refreshArtifacts, refreshProposals, toast, set } = useStore();
  const [running, setRunning] = useState(false);
  const p = (view.revision?.payload ?? {}) as CalculationPayload;
  const [inputs, setInputs] = useState<
    { name: string; quantity: string; source: string; moved: boolean }[]
  >([]);

  useEffect(() => {
    void cmd<{
      inputs: {
        name: string;
        quantity: MaybeQuantity | null;
        sourceRef?: { artifactId: string };
        sourceTitle: string | null;
        sourceMoved: boolean;
      }[];
    }>('calculation.explain_inputs', { artifactId: view.artifact.id })
      .then((r) => {
        setInputs(
          r.inputs.map((i) => ({
            name: i.name,
            quantity:
              i.quantity == null
                ? '—'
                : isUnknown(i.quantity)
                  ? `unknown (${'reason' in i.quantity ? i.quantity.reason : ''})`
                  : formatQty(i.quantity),
            source: i.sourceTitle ?? (i.sourceRef ? i.sourceRef.artifactId.slice(0, 8) : 'literal'),
            moved: i.sourceMoved,
          })),
        );
      })
      .catch(() => setInputs([]));
  }, [view.revision?.id, view.artifact.id]);

  const rerun = async () => {
    setRunning(true);
    try {
      const templates = p.templateId
        ? await cmd<{ templates: { id: string; assumptions?: string[] }[] }>(
            'calculation.templates',
            {},
          )
        : { templates: [] };
      const inheritedAssumptions =
        templates.templates.find((t) => t.id === p.templateId)?.assumptions ?? [];
      await cmd('calculation.run', {
        artifactId: view.artifact.id,
        templateId: p.templateId,
        expression: p.expression,
        inputs: (p.inputs ?? []).map((i) => ({
          name: i.name,
          quantity: i.quantity,
          sourceRef: i.sourceRef,
          literal: i.literal,
        })),
        assumptions: (p.assumptions ?? []).filter((a) => !inheritedAssumptions.includes(a)),
        title: view.artifact.title,
        submitForReview: true,
      });
      await Promise.all([refreshArtifacts(), refreshProposals()]);
      toast('ok', 'Recorded inputs recalculated. New result is ready for review.');
      set({ nav: 'reviews' });
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setRunning(false);
    }
  };

  const result = p.result?.quantity;
  return (
    <div style={{ padding: 24, maxWidth: 700 }}>
      <Header
        view={view}
        actions={
          <button className="primary compact" disabled={running || !view.revision} onClick={rerun}>
            {running ? 'Calculating…' : 'Re-run recorded inputs'}
          </button>
        }
      />
      <div className="inline-notice warning" role="status" style={{ marginBottom: 20 }}>
        Experimental calculation. Referenced sources are labels, not resolved field values. Derived
        units are incomplete. This result is not verified engineering evidence.
      </div>
      {inputs.some((i) => i.moved) && (
        <div className="inline-notice warning" style={{ marginBottom: 20 }}>
          An input source has changed. This result uses the recorded values below. Ask your agent to
          update the input bindings before recalculating for the new design.
        </div>
      )}
      <div className="mono dim" style={{ fontSize: 12, marginBottom: 8 }}>
        {p.templateId ?? 'expression'} — {p.expression ?? ''}
      </div>
      <div className="dim" style={{ fontSize: 12 }}>
        Inputs
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 12 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Name</th>
            <th style={{ textAlign: 'left' }}>Value</th>
            <th style={{ textAlign: 'left' }}>Source</th>
          </tr>
        </thead>
        <tbody>
          {inputs.map((i) => (
            <tr key={i.name}>
              <td style={{ padding: '3px 8px 3px 0' }}>{i.name}</td>
              <td className="num">{i.quantity}</td>
              <td className="dim">
                {i.source}
                {i.moved && <span className="warn"> (moved)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dim" style={{ fontSize: 12 }}>
        Result
      </div>
      <div className="mono num" style={{ fontSize: 20, margin: '4px 0 8px' }}>
        {result == null
          ? '—'
          : isUnknown(result)
            ? `unknown (${'reason' in result ? result.reason : ''})`
            : formatQty(result)}
      </div>
      {(p.assumptions ?? []).length > 0 && (
        <>
          <div className="dim" style={{ fontSize: 12 }}>
            Assumptions
          </div>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
            {p.assumptions!.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </>
      )}
      {(p.limitations ?? []).length > 0 && (
        <>
          <div className="dim" style={{ fontSize: 12 }}>
            Limitations
          </div>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
            {p.limitations!.map((a, i) => (
              <li key={i} className="warn">
                {a}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="faint" style={{ fontSize: 11, marginTop: 8 }}>
        evidence: {p.evidenceKind}
        {p.toolVersion ? ` · tool ${p.toolVersion}` : ''}
        {p.ranAt ? ` · ${p.ranAt.slice(0, 16)}` : ''}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Test                                                                 */
/* ------------------------------------------------------------------ */

function TestDetail({ view }: { view: ArtifactView }) {
  const { refreshArtifacts, toast, readOnly } = useStore();
  const p = (view.revision?.payload ?? {}) as TestPayload;
  const [obs, setObs] = useState('');
  const [result, setResult] = useState<'passed' | 'failed' | 'inconclusive' | 'not_run' | ''>('');
  const [evidence, setEvidence] = useState<EvidenceKind | ''>('');
  const [busy, setBusy] = useState(false);
  const record = async () => {
    if (!result || !evidence || !obs.trim()) return;
    setBusy(true);
    try {
      await cmd('test.record_result', {
        artifactId: view.artifact.id,
        result,
        observation: obs.trim(),
        evidenceKind: evidence,
        conditions: p.conditions,
        attachments: [],
      });
      await refreshArtifacts();
      toast('ok', 'Result recorded');
      setObs('');
      setResult('');
      setEvidence('');
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="document-detail">
      <Header view={view} />
      <h4>Test procedure</h4>
      <div className="assembly-steps">
        {(p.procedure ?? []).map((step) => (
          <section key={step.step}>
            <span className="assembly-number">{step.step}</span>
            <div className="grow">
              <p>{step.instruction}</p>
              {step.expected && <small>Expected: {step.expected}</small>}
            </div>
          </section>
        ))}
      </div>
      {p.conditions && (
        <div className="inline-notice" style={{ marginBlock: 24 }}>
          <strong>Test conditions</strong>
          <p style={{ margin: '6px 0 0' }}>{p.conditions}</p>
        </div>
      )}
      <h4>Record a result</h4>
      <fieldset disabled={readOnly || busy} className="plain-fieldset">
        <div className="field-row">
          <FormField label="Test result">
            <select value={result} onChange={(e) => setResult(e.target.value as typeof result)}>
              <option value="" disabled>
                Select result
              </option>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
              <option value="inconclusive">Inconclusive</option>
              <option value="not_run">Not run</option>
            </select>
          </FormField>
          <FormField label="Evidence kind">
            <select value={evidence} onChange={(e) => setEvidence(e.target.value as EvidenceKind)}>
              <option value="" disabled>
                Select evidence
              </option>
              {['measured', 'simulated', 'calculated', 'sourced', 'assumed'].map((kind) => (
                <option key={kind} value={kind}>
                  {kind[0]!.toUpperCase() + kind.slice(1)}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <FormField
          label="Test observation"
          hint="Describe what happened, including measurements, units, and relevant conditions."
        >
          <textarea
            value={obs}
            onChange={(e) => setObs(e.target.value)}
            rows={3}
            placeholder="Record the evidence behind this result…"
          />
        </FormField>
        <button
          className="primary"
          onClick={() => void record()}
          disabled={!result || !evidence || !obs.trim() || busy}
        >
          {busy ? 'Recording…' : 'Record result'}
        </button>
      </fieldset>
      {(p.results ?? []).length > 0 && (
        <section style={{ marginTop: 28 }}>
          <h4>Recorded results</h4>
          {p.results.map((r) => (
            <div className="recorded-test" key={r.id}>
              <div className="row">
                <StatusBadge state={r.result} />
                <span className="faint">{r.evidenceKind}</span>
              </div>
              <p>{r.observation}</p>
              <small className="faint">
                {new Date(r.recordedAt).toLocaleString()} · {r.recordedBy}
              </small>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Generic                                                              */
/* ------------------------------------------------------------------ */

function GenericDetail({ view }: { view: ArtifactView }) {
  return (
    <div style={{ padding: 24, maxWidth: 760 }}>
      <Header view={view} />
      <MarkdownView view={view} />
    </div>
  );
}

function SourceDetail({ view }: { view: ArtifactView }) {
  const p = (view.revision?.payload ?? {}) as SourcePayload;
  return (
    <div className="document-detail">
      <Header view={view} />
      <dl className="detail-properties">
        <dt>Publisher</dt>
        <dd>{p.publisher ?? 'Unknown'}</dd>
        <dt>Source type</dt>
        <dd>{p.sourceKind ?? 'Unknown'}</dd>
        <dt>Captured</dt>
        <dd>{p.retrievedAt ? new Date(p.retrievedAt).toLocaleString() : 'Unknown'}</dd>
        {p.locator && (
          <>
            <dt>Location</dt>
            <dd>{p.locator}</dd>
          </>
        )}
      </dl>
      {p.url && (
        <button className="source-url" onClick={() => void window.omenflow.openExternal(p.url!)}>
          {p.url}
        </button>
      )}
      <h4>Recorded excerpt</h4>
      {p.excerpt ? (
        <blockquote className="source-excerpt">{p.excerpt}</blockquote>
      ) : (
        <p className="dim">No excerpt was captured for this source.</p>
      )}
    </div>
  );
}
function AssemblyDetail({ view }: { view: ArtifactView }) {
  const p = (view.revision?.payload ?? {}) as AssemblyPayload;
  const { artifacts, selectArtifact } = useStore();
  return (
    <div className="document-detail">
      <Header view={view} />
      <div className="assembly-steps">
        {(p.steps ?? []).map((step) => (
          <section key={step.order}>
            <span className="assembly-number">{step.order}</span>
            <div className="grow">
              <p>{step.instruction}</p>
              {step.tools.length > 0 && <small>Tools: {step.tools.join(', ')}</small>}
              {step.calibration && (
                <div className="inline-notice">Calibration: {step.calibration}</div>
              )}
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {step.componentRefs.map((id) => (
                  <button className="text-link" key={id} onClick={() => selectArtifact(id)}>
                    <ArtifactIcon type="component" size={13} />
                    {artifacts.find((v) => v.artifact.id === id)?.artifact.title ?? id.slice(0, 8)}
                  </button>
                ))}
              </div>
            </div>
          </section>
        ))}
      </div>
      {!p.steps?.length && (
        <EmptyState
          title="Assembly steps are not recorded"
          body="Ask your agent to draft the build sequence, tools, and calibration requirements."
        />
      )}
    </div>
  );
}
function ComponentDetail({ view }: { view: ArtifactView }) {
  const p = (view.revision?.payload ?? {}) as ComponentPayload;
  const { artifacts, selectArtifact } = useStore();
  return (
    <div className="document-detail">
      <Header view={view} />
      <p className="dim">{p.description}</p>
      <dl className="detail-properties">
        <dt>Part number</dt>
        <dd className="mono">{p.partNumber}</dd>
        <dt>Manufacturer</dt>
        <dd>{p.manufacturer ?? p.vendor ?? 'Unknown'}</dd>
        <dt>Selection</dt>
        <dd>
          <StatusBadge state={p.status ?? 'candidate'} />
        </dd>
      </dl>
      <h4>Engineering properties</h4>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Property</th>
              <th>Value</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(p.properties ?? {}).map(([key, value]) => (
              <tr key={key}>
                <td>{key.replaceAll('_', ' ')}</td>
                <td className="numeric">
                  {value.quantity ? formatQty(value.quantity) : 'Unknown'}
                </td>
                <td>
                  {value.sourceId ? (
                    <button
                      className="table-title-button"
                      onClick={() => selectArtifact(value.sourceId!)}
                    >
                      {artifacts.find((v) => v.artifact.id === value.sourceId)?.artifact.title ??
                        'Recorded source'}
                    </button>
                  ) : (
                    'No source recorded'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {p.missingFields?.length > 0 && (
        <div className="inline-notice warning" style={{ marginTop: 20 }}>
          Missing: {p.missingFields.join(', ')}
        </div>
      )}
    </div>
  );
}
function SoftwareDetail({ view }: { view: ArtifactView }) {
  const p = (view.revision?.payload ?? {}) as SoftwarePayload;
  return (
    <div className="document-detail">
      <Header view={view} />
      <dl className="detail-properties">
        <dt>Language</dt>
        <dd>{p.language ?? 'Not specified'}</dd>
        <dt>Entry point</dt>
        <dd className="mono">{p.entryPoint ?? 'Not specified'}</dd>
      </dl>
      <MarkdownView view={view} />
    </div>
  );
}
function ConceptDetail({ view }: { view: ArtifactView }) {
  const p = (view.revision?.payload ?? {}) as ConceptPayload;
  return (
    <div className="document-detail">
      <Header view={view} />
      <MarkdownView view={view} />
      {[
        { title: 'Systems', items: p.systems },
        { title: 'Alternatives', items: p.alternatives },
        { title: 'Uncertainties', items: p.uncertainties },
      ].map(
        (section) =>
          section.items?.length > 0 && (
            <section key={section.title}>
              <h4>{section.title}</h4>
              <ul>
                {section.items.map((item, i) => (
                  <li className="dim" key={i}>
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          ),
      )}
    </div>
  );
}

function Header({ view: v, actions }: { view: ArtifactView; actions?: React.ReactNode }) {
  const readOnly = useStore((s) => s.readOnly);
  return (
    <div className="detail-heading">
      <div className="row">
        <ArtifactIcon type={v.artifact.type} />
        <span className="dim">{typeLabels[v.artifact.type]}</span>
        <span className="grow" />
        <StatusBadge state={v.freshness} />
        <InspectButton />
      </div>
      <h3>{v.artifact.title}</h3>
      <div className="row">
        <StatusBadge state={v.revision?.reviewState ?? 'draft'} />
        <span className="faint">Revision {v.revision?.seq ?? 0}</span>
        {v.draftCount > 0 && (
          <StatusBadge
            state="draft"
            label={`${v.draftCount} draft${v.draftCount > 1 ? 's' : ''}`}
          />
        )}
        {v.pendingProposal && <StatusBadge state="pending" />}
      </div>
      {actions && (
        <fieldset disabled={readOnly} className="plain-fieldset row detail-actions">
          {actions}
        </fieldset>
      )}
    </div>
  );
}
