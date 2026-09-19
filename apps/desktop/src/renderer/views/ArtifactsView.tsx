import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import { StlViewport } from '../components/StlViewport';
import { MarkdownView } from '../components/MarkdownView';
import type {
  ArtifactType,
  ArtifactView,
  CalculationPayload,
  MechanicalPayload,
  Revision,
  TestPayload,
  WiringPayload,
  MaybeQuantity,
} from '@omenflow/contracts';
import { formatQty, isUnknown } from '@omenflow/contracts';
import { EmptyBlock } from './OverviewView';

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
  const grouped = useMemo(() => {
    const m = new Map<ArtifactType, ArtifactView[]>();
    for (const v of artifacts) {
      const l = m.get(v.artifact.type) ?? [];
      l.push(v);
      m.set(v.artifact.type, l);
    }
    return TYPE_ORDER.filter((t) => m.has(t)).map((t) => [t, m.get(t)!] as const);
  }, [artifacts]);
  const selected = artifacts.find((v) => v.artifact.id === selectedArtifactId);

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div
        style={{
          width: 260,
          borderRight: '1px solid var(--border)',
          overflowY: 'auto',
          padding: 8,
        }}
      >
        {grouped.length === 0 && (
          <div className="faint" style={{ padding: 8, fontSize: 12 }}>
            No artifacts yet.
          </div>
        )}
        {grouped.map(([type, views]) => (
          <div key={type} style={{ marginBottom: 8 }}>
            <div
              className="faint"
              style={{
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                padding: '2px 8px',
              }}
            >
              {type} ({views.length})
            </div>
            {views.map((v) => (
              <div
                key={v.artifact.id}
                role="button"
                tabIndex={0}
                onClick={() => selectArtifact(v.artifact.id)}
                onKeyDown={(e) => e.key === 'Enter' && selectArtifact(v.artifact.id)}
                style={{
                  padding: '4px 8px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  background:
                    selectedArtifactId === v.artifact.id ? 'var(--bg-raised)' : 'transparent',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: 13,
                }}
              >
                <span
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {v.artifact.title}
                </span>
                {v.freshness !== 'current' && (
                  <span
                    className={`pill ${v.freshness === 'stale' ? 'stale' : 'missing'}`}
                    style={{ height: 16, fontSize: 10 }}
                  >
                    {v.freshness}
                  </span>
                )}
                {v.draftCount > 0 && (
                  <span className="pill" style={{ height: 16, fontSize: 10 }}>
                    draft
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {selected ? (
          <ArtifactDetail view={selected} />
        ) : (
          <EmptyBlock title="Artifacts" body="Select an artifact on the left." />
        )}
      </div>
    </div>
  );
}

function ArtifactDetail({ view }: { view: ArtifactView }) {
  switch (view.artifact.type) {
    case 'mechanical':
      return <MechanicalDetail view={view} />;
    case 'wiring':
      return <WiringDetail view={view} />;
    case 'calculation':
      return <CalcDetail view={view} />;
    case 'test':
      return <TestDetail view={view} />;
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
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 16, gap: 12 }}>
      <Header
        view={view}
        actions={
          <>
            <button style={{ height: 26, fontSize: 12 }} onClick={validate}>
              Validate source
            </button>
            <button
              className="primary"
              style={{ height: 26, fontSize: 12 }}
              onClick={render}
              disabled={busy}
            >
              Render STL
            </button>
            {draft && (
              <button style={{ height: 26, fontSize: 12 }} onClick={acceptDraft}>
                Accept draft rev {draft.seq}
              </button>
            )}
          </>
        }
      />
      <div
        style={{
          flex: 1,
          minHeight: 260,
          border: '1px solid var(--border)',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        {stl ? (
          <StlViewport stlData={stl} compareData={compareStl} modelUnit={p.modelUnit ?? 'mm'} />
        ) : (
          <div className="faint" style={{ padding: 24 }}>
            No STL on the selected revision — render to produce geometry.
          </div>
        )}
      </div>
      {p.bounds && (
        <div className="mono dim" style={{ fontSize: 12 }}>
          Bounds: {p.bounds.min.map((n) => n.toFixed(1)).join(', ')} →{' '}
          {p.bounds.max.map((n) => n.toFixed(1)).join(', ')} {p.modelUnit}
        </div>
      )}
      <ParamsTable
        params={p.params ?? {}}
        modelUnit={p.modelUnit ?? 'mm'}
        artifactId={view.artifact.id}
        revisionId={rev?.id}
      />
      <ScadEditor view={view} />
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
  return (
    <div>
      <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>
        Parameters
      </div>
      <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
        <tbody>
          {entries.map(([k, v]) => {
            const n = numOf(v);
            return (
              <tr key={k}>
                <td className="dim" style={{ padding: '3px 8px 3px 0' }}>
                  {k}
                </td>
                <td>
                  {n !== undefined ? (
                    <input
                      className="num"
                      style={{ width: 90, height: 24, fontSize: 12 }}
                      defaultValue={n}
                      onChange={(e) => setEdits((s) => ({ ...s, [k]: e.target.value }))}
                    />
                  ) : (
                    <span className="mono" style={{ fontSize: 12 }}>
                      {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                    </span>
                  )}
                </td>
                <td className="faint" style={{ padding: '3px 0 3px 6px' }}>
                  {unitOf(v)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {Object.values(edits).some((v) => v !== '') && (
        <button
          className="primary"
          style={{ height: 26, fontSize: 12, marginTop: 6 }}
          onClick={commit}
        >
          Apply
        </button>
      )}
    </div>
  );
}

function ScadEditor({ view }: { view: ArtifactView }) {
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
    <div>
      <button style={{ height: 24, fontSize: 12 }} onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide' : 'Show'} source ({scad.path})
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <textarea
            className="mono"
            rows={14}
            style={{ width: '100%', fontSize: 12 }}
            value={src ?? ''}
            onChange={(e) => {
              setSrc(e.target.value);
              dirty.current = true;
            }}
          />
          <button
            className="primary"
            style={{ height: 26, fontSize: 12 }}
            onClick={save}
            disabled={!dirty.current}
          >
            Save source
          </button>
        </div>
      )}
    </div>
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
  const [diagram, setDiagram] = useState<{ svg: string } | null>(null);

  const validate = async () => {
    try {
      const r = await cmd<{
        findings: { severity: string; code: string; message: string }[];
        coverage: string;
      }>('wiring.validate', { artifactId: view.artifact.id });
      setFindings(r.findings);
      toast('ok', r.coverage);
    } catch (e) {
      toast('error', errMsg(e));
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
    <div style={{ padding: 16 }}>
      <Header
        view={view}
        actions={
          <>
            <button style={{ height: 26, fontSize: 12 }} onClick={validate}>
              Validate
            </button>
            <button style={{ height: 26, fontSize: 12 }} onClick={render}>
              Render diagram
            </button>
          </>
        }
      />
      <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>
        Connections ({p.connections?.length ?? 0})
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
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
              <td
                className="mono"
                style={{ padding: '3px 8px 3px 0', cursor: 'pointer' }}
                onClick={() => selectArtifact(c.from.componentArtifactId)}
              >
                {title(c.from.componentArtifactId)}.{c.from.pin}
              </td>
              <td
                className="mono"
                style={{ padding: '3px 8px 3px 0', cursor: 'pointer' }}
                onClick={() => selectArtifact(c.to.componentArtifactId)}
              >
                {title(c.to.componentArtifactId)}.{c.to.pin}
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
              style={{ fontSize: 12, padding: '2px 0' }}
            >
              [{f.severity}] {f.message}
            </div>
          ))}
        </div>
      )}
      {diagram && (
        <div
          style={{
            marginTop: 12,
            border: '1px solid var(--border)',
            borderRadius: 6,
            overflow: 'auto',
          }}
          dangerouslySetInnerHTML={{ __html: diagram.svg }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Calculation                                                          */
/* ------------------------------------------------------------------ */

function CalcDetail({ view }: { view: ArtifactView }) {
  const { refreshArtifacts, toast } = useStore();
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
    try {
      await cmd('calculation.run', {
        templateId: p.templateId,
        inputs: (p.inputs ?? []).map((i) => ({
          name: i.name,
          quantity: i.quantity,
          sourceRef: i.sourceRef,
        })),
        assumptions: p.assumptions ?? [],
        title: view.artifact.title,
        submitForReview: false,
      });
      await refreshArtifacts();
      toast('ok', 'Recalculated');
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  const result = p.result?.quantity;
  return (
    <div style={{ padding: 16, maxWidth: 700 }}>
      <Header
        view={view}
        actions={
          <button className="primary" style={{ height: 26, fontSize: 12 }} onClick={rerun}>
            Re-run
          </button>
        }
      />
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
  const { refreshArtifacts, toast } = useStore();
  const p = (view.revision?.payload ?? {}) as TestPayload;
  const [obs, setObs] = useState('');
  const [result, setResult] = useState<'passed' | 'failed' | 'inconclusive' | 'not_run'>('passed');
  const record = async () => {
    try {
      await cmd('test.record_result', {
        artifactId: view.artifact.id,
        result,
        observation: obs,
        evidenceKind: 'measured',
        attachments: [],
      });
      await refreshArtifacts();
      toast('ok', 'Result recorded');
      setObs('');
    } catch (e) {
      toast('error', errMsg(e));
    }
  };
  return (
    <div style={{ padding: 16, maxWidth: 700 }}>
      <Header view={view} />
      <div className="dim" style={{ fontSize: 12 }}>
        Procedure
      </div>
      <ol style={{ margin: '4px 0 12px', paddingLeft: 18, fontSize: 13 }}>
        {(p.procedure ?? []).map((s) => (
          <li key={s.step}>
            {s.instruction}
            {s.expected ? <span className="dim"> — expected: {s.expected}</span> : null}
          </li>
        ))}
      </ol>
      {p.conditions && (
        <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>
          Conditions: {p.conditions}
        </div>
      )}
      <div className="dim" style={{ fontSize: 12 }}>
        Record result
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        <select
          value={result}
          onChange={(e) => setResult(e.target.value as never)}
          style={{ height: 30 }}
        >
          <option value="passed">passed</option>
          <option value="failed">failed</option>
          <option value="inconclusive">inconclusive</option>
          <option value="not_run">not_run</option>
        </select>
        <input
          placeholder="Observation"
          value={obs}
          onChange={(e) => setObs(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="primary" style={{ height: 30 }} onClick={record}>
          Record
        </button>
      </div>
      {(p.results ?? []).length > 0 && (
        <>
          <div className="dim" style={{ fontSize: 12, marginTop: 12 }}>
            Results
          </div>
          {p.results!.map((r) => (
            <div key={r.id} style={{ fontSize: 12, padding: '3px 0' }}>
              <span
                className={r.result === 'passed' ? 'ok' : r.result === 'failed' ? 'err' : 'dim'}
              >
                {r.result}
              </span>{' '}
              — {r.observation}{' '}
              <span className="faint">
                {r.recordedAt.slice(0, 16).replace('T', ' ')} · {r.recordedBy} · {r.evidenceKind}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Generic                                                              */
/* ------------------------------------------------------------------ */

function GenericDetail({ view }: { view: ArtifactView }) {
  return (
    <div style={{ padding: 16, maxWidth: 760 }}>
      <Header view={view} />
      <MarkdownView view={view} />
    </div>
  );
}

function Header(props: { view: ArtifactView; actions?: React.ReactNode }) {
  const v = props.view;
  return (
    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>{v.artifact.title}</h3>
        <span
          className={`pill ${v.freshness === 'stale' ? 'stale' : v.freshness === 'missing_input' ? 'missing' : 'current'}`}
        >
          {v.freshness}
        </span>
        {v.revision && (
          <span className="faint" style={{ fontSize: 12 }}>
            rev {v.revision.seq} · {v.revision.reviewState}
          </span>
        )}
        {v.draftCount > 0 && <span className="pill stale">draft</span>}
        {v.pendingProposal && <span className="pill stale">in review</span>}
      </div>
      <div className="row">{props.actions}</div>
    </div>
  );
}
