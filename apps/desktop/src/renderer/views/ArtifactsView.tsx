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
  const { artifacts, selectedArtifactId, selectArtifact } = useStore();
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
            <ArtifactDetail key={selected.artifact.id} view={selected} />
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

/** Loads drafts for an artifact (agent proposals live there until accepted). */
function useDrafts(artifactId: string | undefined) {
  const [drafts, setDrafts] = useState<Revision[]>([]);
  useEffect(() => {
    if (!artifactId) return;
    void cmd<{ drafts: Revision[] }>('artifact.read', { artifactId })
      .then((r) => setDrafts(r.drafts))
      .catch(() => setDrafts([]));
  }, [artifactId]);
  return drafts;
}

/* ------------------------------------------------------------------ */
/* Mechanical                                                          */
/* ------------------------------------------------------------------ */

function MechanicalDetail({ view }: { view: ArtifactView }) {
  const { toast, refreshArtifacts } = useStore();
  const drafts = useDrafts(view.artifact.id);
  const [stl, setStl] = useState<ArrayBuffer | null>(null);
  const [compareStl, setCompareStl] = useState<ArrayBuffer | null>(null);
  const [busy, setBusy] = useState(false);
  const rev = view.revision;
  const p = (rev?.payload ?? {}) as MechanicalPayload;
  const draft = drafts[0] ?? null;

  const loadFile = async (path: string, revisionId?: string): Promise<ArrayBuffer> => {
    const r = await cmd<{ contentBase64: string }>('artifact.read_file', {
      artifactId: view.artifact.id,
      path,
      revisionId,
    });
    const bytes = Uint8Array.from(atob(r.contentBase64), (c) => c.charCodeAt(0));
    return bytes.buffer as ArrayBuffer;
  };
  useEffect(() => {
    setStl(null);
    setCompareStl(null);
    const stlFile = rev?.files.find((f) => f.path.endsWith('.stl'));
    if (stlFile)
      void loadFile(stlFile.path)
        .then(setStl)
        .catch(() => {});
    const draftStl = draft?.files.find((f) => f.path.endsWith('.stl'));
    if (draftStl && draft)
      void loadFile(draftStl.path, draft.id)
        .then(setCompareStl)
        .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev?.id, draft?.id]);

  const render = async () => {
    setBusy(true);
    try {
      await cmd('cad.render', { artifactId: view.artifact.id });
      toast('ok', 'Render job started');
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
      void refreshArtifacts();
    }
  };
  const validate = async () => {
    try {
      const r = await cmd<{ ok: boolean; errors: string[] }>('cad.validate_source', {
        artifactId: view.artifact.id,
      });
      toast(r.ok ? 'ok' : 'error', r.ok ? 'Source valid' : r.errors.join('; ') || 'Invalid');
    } catch (e) {
      toast('error', errMsg(e));
    }
  };
  const acceptDraft = async () => {
    if (!draft) return;
    try {
      await cmd('artifact.accept_draft', {
        artifactId: view.artifact.id,
        draftRevisionId: draft.id,
        rationale: 'accept render',
      });
      await refreshArtifacts();
      toast('ok', 'Draft accepted as baseline');
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  return (
    <div className="mechanical-detail">
      <Header
        view={view}
        actions={
          <>
            <button className="primary compact" onClick={render} disabled={busy}>
              {busy ? 'Starting render…' : 'Render STL'}
            </button>
            {draft && (
              <button className="compact" onClick={acceptDraft}>
                Accept draft revision {draft.seq}
              </button>
            )}
          </>
        }
      />
      <div className="canvas-frame">
        {stl ? (
          <StlViewport stlData={stl} compareData={compareStl} modelUnit={p.modelUnit ?? 'mm'} />
        ) : (
          <EmptyState
            title="No geometry on this revision"
            body="Render the model from its source to inspect it in 3D. Rendering needs OpenSCAD on this machine."
            action={
              <button className="primary" onClick={render} disabled={busy}>
                Render STL
              </button>
            }
          />
        )}
      </div>
      {p.manufacturing?.includes('Illustrative') && (
        <div className="inline-notice warning">{p.manufacturing}</div>
      )}
      <ParamsTable
        params={p.params ?? {}}
        modelUnit={p.modelUnit ?? 'mm'}
        artifactId={view.artifact.id}
        revisionId={rev?.id}
      />
      <ScadEditor view={view} onValidate={validate} />
    </div>
  );
}

function ParamsTable(props: {
  params: Record<string, unknown>;
  modelUnit: string;
  artifactId: string;
  revisionId?: string;
}) {
  const { refreshArtifacts, toast } = useStore();
  const entries = Object.entries(props.params);
  const [edits, setEdits] = useState<Record<string, string>>({});
  if (entries.length === 0) return null;
  const numOf = (v: unknown): number | undefined => {
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object' && 'value' in v) return (v as { value?: number }).value;
    return undefined;
  };
  const unitOf = (v: unknown): string => {
    if (v && typeof v === 'object' && 'unit' in v) return String((v as { unit?: string }).unit);
    return props.modelUnit;
  };
  const commit = async () => {
    const params: Record<string, unknown> = { ...props.params };
    for (const [k, v] of Object.entries(edits)) {
      if (v === '' || Number.isNaN(Number(v))) continue;
      const cur = props.params[k];
      params[k] =
        typeof cur === 'object' && cur !== null
          ? { ...(cur as object), value: Number(v) }
          : Number(v);
    }
    try {
      await cmd('artifact.apply_edit', {
        artifactId: props.artifactId,
        baseRevisionId: props.revisionId,
        payloadPatch: { params },
        rationale: 'edit param',
      });
      setEdits({});
      await refreshArtifacts();
      toast('ok', 'Parameters updated — dependents marked stale');
    } catch (e) {
      toast('error', errMsg(e));
    }
  };
  const dirty = Object.values(edits).some((v) => v !== '');
  return (
    <section className="detail-section">
      <div className="section-heading">
        <h2>
          Parameters<span className="count">{entries.length}</span>
        </h2>
        {dirty && (
          <div className="row">
            <button className="ghost compact" onClick={() => setEdits({})}>
              Discard
            </button>
            <button className="primary compact" onClick={commit}>
              Apply parameters
            </button>
          </div>
        )}
      </div>
      <table className="params-table">
        <tbody>
          {entries.map(([k, v]) => {
            const n = numOf(v);
            return (
              <tr key={k}>
                <td className="dim">{k}</td>
                <td>
                  {n !== undefined ? (
                    <input
                      aria-label={`${k} (${unitOf(v)})`}
                      className="num"
                      value={edits[k] ?? String(n)}
                      onChange={(e) => setEdits((s) => ({ ...s, [k]: e.target.value }))}
                    />
                  ) : (
                    <span className="mono">
                      {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                    </span>
                  )}
                </td>
                <td className="faint">{unitOf(v)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {dirty && (
        <p className="table-footnote">
          Applying creates a new revision and marks dependent objects out of date until they are
          re-run.
        </p>
      )}
    </section>
  );
}

function ScadEditor({ view, onValidate }: { view: ArtifactView; onValidate: () => void }) {
  const { refreshArtifacts, toast } = useStore();
  const scad = view.revision?.files.find((f) => f.path.endsWith('.scad'));
  const [src, setSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const dirty = useRef(false);

  useEffect(() => {
    if (!scad || !open) return;
    void cmd<{ contentBase64: string }>('artifact.read_file', {
      artifactId: view.artifact.id,
      path: scad.path,
    }).then((r) => setSrc(decodeURIComponent(escape(atob(r.contentBase64)))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scad?.path, view.revision?.id, open]);

  const save = async () => {
    if (src == null || !scad || !view.revision) return;
    try {
      await cmd('artifact.apply_edit', {
        artifactId: view.artifact.id,
        baseRevisionId: view.revision.id,
        fileWrites: [{ path: scad.path, contentBase64: btoa(unescape(encodeURIComponent(src))) }],
        rationale: 'edit source',
      });
      dirty.current = false;
      await refreshArtifacts();
      toast('ok', 'Source saved — geometry stale until rendered');
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  if (!scad) return null;
  return (
    <section className="detail-section">
      <div className="section-heading">
        <button className="disclosure" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <CaretRight size={12} className={`object-group-caret ${open ? 'open' : ''}`} />
          Source
          <span className="mono faint">{scad.path}</span>
        </button>
        {open && (
          <div className="row">
            <button className="compact" onClick={onValidate}>
              Validate source
            </button>
            <button className="primary compact" onClick={save} disabled={!dirty.current}>
              Save source
            </button>
          </div>
        )}
      </div>
      {open && (
        <textarea
          aria-label="OpenSCAD source"
          className="mono source-editor"
          rows={16}
          value={src ?? ''}
          onChange={(e) => {
            setSrc(e.target.value);
            dirty.current = true;
          }}
        />
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
