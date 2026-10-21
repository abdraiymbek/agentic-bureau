import React, { lazy, Suspense, useContext, useEffect, useState } from 'react';
import { ArrowRight, SlidersHorizontal, ShieldCheck } from '@phosphor-icons/react';

import type {
  ArtifactView,
  ChatCard,
  ChatInput,
  ChatPart,
  MechanicalPayload,
  Revision,
} from '@omenflow/contracts';
import { Button, Checkbox, ConfirmButton, Notice, Spinner, State, TypeGlyph } from '../ui/kit';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import { useChat } from './chat-store';
import { useCadSources } from '../object/mechanical/useCad';
import {
  parameterForm,
  parameterOverrides,
  parameterRows,
  parameterText,
  type ParameterRow,
} from '../lib/scad-params';
import { flatten } from '../lib/diff';
import { InlinePayloadReview } from './InlinePayloadReview';
import type { ProposalDetail } from '../decide/model';
import { detailPhase, phaseLabel, approvalEffects } from '../decide/model';
import { Prose } from '../object/stages/shared';
import { InlineFileReview } from './InlineFileReview';
import { quantityProblem, type QuantityFields } from './quantity-input';
import { InlineVerification } from './InlineVerification';
import { CompactContext } from './compact';

const InlineMesh = lazy(() => import('./InlineMesh'));
const ChartCard = lazy(() => import('./InlineChart'));
function openCard(project: string, part: ChatPart) {
  void useChat
    .getState()
    .open(project, part)
    .catch((e) => useStore.getState().toast('error', errMsg(e)));
}
export function InputAttachment({ input }: { input: ChatInput }) {
  return (
    <details className="inline-attachment">
      <summary>
        <SlidersHorizontal size={14} />
        {input.title}{' '}
        <span>
          {input.fields.length} exact values ·{' '}
          {input.intent === 'render' ? 'render request' : 'evaluation request'}
        </span>
      </summary>
      <dl className="inline-value-list">
        {input.fields.map((f) => (
          <div key={f.name}>
            <dt>{f.name}</dt>
            <dd>
              {f.unknown ? `Unknown — ${f.reason}` : `${f.text} ${f.unit || '(unit unspecified)'}`}
            </dd>
          </div>
        ))}
      </dl>
      {input.revisionId && <p className="mono">Revision {input.revisionId}</p>}
      <p>These values travel with your message. Only Send starts the agent.</p>
    </details>
  );
}
export function InlineCards({
  cards,
  projectId,
  conversationId,
}: {
  cards: ChatCard[];
  projectId: string;
  conversationId: string;
}) {
  return (
    <div className="inline-cards">
      {cards.map((part) => (
        <ErrorBoundary key={part.id} label="This inline card" resetKey={part.id}>
          <div className="inline-owned-card">
            {part.origin === 'user' && (
              <p className="inline-owned-label">Opened by you · conversation context</p>
            )}
            <InlineCard part={part} projectId={projectId} conversationId={conversationId} />
          </div>
        </ErrorBoundary>
      ))}
    </div>
  );
}
function InlineCard({
  part,
  projectId,
  conversationId,
}: {
  part: ChatCard;
  projectId: string;
  conversationId: string;
}) {
  switch (part.kind) {
    case 'artifact':
      return (
        <ArtifactCard
          projectId={projectId}
          artifactId={part.artifactId}
          revisionId={part.revisionId}
          storageKey={`${projectId}/${conversationId}/${part.id}`}
        />
      );
    case 'review':
      return <ReviewCard projectId={projectId} proposalId={part.proposalId} />;
    case 'chart':
      return (
        <Suspense
          fallback={
            <div className="inline-loading">
              <Spinner /> Loading chart…
            </div>
          }
        >
          <ChartCard part={part} />
        </Suspense>
      );
    case 'form':
      return (
        <QuantityCard
          part={part}
          projectId={projectId}
          storageKey={`${projectId}/${conversationId}/${part.id}`}
        />
      );
    case 'choices':
      return (
        <section className="inline-card">
          <header className="inline-card-head">
            <span className="inline-card-icon">
              <ArrowRight size={18} />
            </span>
            <div>
              <span className="chat-eyebrow">Choose a direction</span>
              <h2>{part.title}</h2>
            </div>
          </header>
          <div className="inline-choices">
            {part.options.map((o) => (
              <Button
                key={o.label}
                onClick={() => {
                  useChat.getState().offer(projectId, o.prompt);
                  window.dispatchEvent(new Event('omenflow:focus-composer'));
                }}
              >
                {o.label}
                <ArrowRight size={14} />
              </Button>
            ))}
          </div>
          <p className="inline-caption">Choosing prepares a message. Send when you are ready.</p>
        </section>
      );
    default:
      return (
        <Notice tone="warn">
          This card type is not supported by this version. Its original response remains in the
          conversation record.
        </Notice>
      );
  }
}
function ArtifactCard({
  projectId,
  artifactId,
  revisionId,
  storageKey,
  onShown,
}: {
  projectId: string;
  artifactId: string;
  revisionId?: string;
  storageKey: string;
  onShown?: (ready: boolean) => void;
}) {
  const [view, setView] = useState<ArtifactView | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const listed = useStore((s) =>
    s.projectId === projectId
      ? s.artifacts.find((item) => item.artifact.id === artifactId)
      : undefined,
  );
  const baselineVersion = useStore((s) => (s.projectId === projectId ? s.baselineVersion : 0));
  const evidenceVersion = useStore((s) =>
    s.projectId === projectId ? (s.evidenceVersions[artifactId] ?? 0) : 0,
  );
  useEffect(() => {
    let alive = true;
    void cmd<{ view: ArtifactView; revision: Revision | null }>(
      'artifact.read',
      { artifactId, revisionId, detail: 'full' },
      { projectId },
    ).then(
      (v) => {
        if (alive) {
          if (revisionId && v.revision?.id !== revisionId)
            setError('The requested revision could not be read.');
          else {
            setView({ ...v.view, revision: v.revision });
            setError('');
          }
        }
      },
      (e) => alive && setError(errMsg(e)),
    );
    return () => {
      alive = false;
    };
  }, [projectId, artifactId, revisionId, attempt, listed, baselineVersion, evidenceVersion]);
  if (error && !view)
    return (
      <Notice tone="err" role="alert">
        {error}
        <Button size="sm" onClick={() => setAttempt(attempt + 1)}>
          Read again
        </Button>
      </Notice>
    );
  if (!view)
    return (
      <div className="inline-card inline-loading">
        <Spinner /> Reading recorded object…
      </div>
    );
  const revision = view.revision;
  return (
    <section className="inline-card inline-artifact">
      {error && (
        <Notice tone="err" role="alert">
          Current revision state could not be refreshed: {error}
          <Button size="sm" onClick={() => setAttempt(attempt + 1)}>
            Read again
          </Button>
        </Notice>
      )}
      <header className="inline-card-head">
        <span className="inline-card-icon">
          <TypeGlyph type={view.artifact.type} size={19} />
        </span>
        <div>
          <span className="chat-eyebrow">
            {view.artifact.type === 'mechanical' ? 'Part workspace' : 'Recorded object'}
          </span>
          <h2>{view.artifact.title}</h2>
        </div>
        <State state={revision?.reviewState ?? 'draft'} />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => useStore.getState().focus(view.artifact.id)}
        >
          Open object
        </Button>
      </header>
      {revision ? (
        view.artifact.type === 'mechanical' ? (
          <MechanicalCard
            view={view}
            revision={revision}
            projectId={projectId}
            storageKey={storageKey}
            onShown={onShown}
          />
        ) : (
          <RecordBody
            revision={revision}
            view={view}
            projectId={projectId}
            storageKey={storageKey}
          />
        )
      ) : (
        <p className="inline-caption">No revision is recorded.</p>
      )}
      <details className="inline-provenance">
        <summary>Revision & provenance</summary>
        <dl className="inline-value-list">
          <div>
            <dt>Revision</dt>
            <dd className="mono">{revision?.id ?? 'None'}</dd>
          </div>
          <div>
            <dt>Freshness</dt>
            <dd>{view.freshness ?? 'Not recorded'}</dd>
          </div>
          <div>
            <dt>Authored by</dt>
            <dd>{revision?.origin ?? 'Not recorded'}</dd>
          </div>
        </dl>
        <p>{revision?.rationale || 'No revision rationale recorded.'}</p>
        <p>Human approval records a baseline; it does not establish verification.</p>
      </details>
    </section>
  );
}
function RecordBody({
  revision,
  view,
  projectId,
  storageKey,
}: {
  revision: Revision;
  view: ArtifactView;
  projectId: string;
  storageKey: string;
}) {
  const p = revision.payload as Record<string, unknown>;
  const quantityKey = ['target', 'value'].find((k) => p[k] && typeof p[k] === 'object');
  const q = quantityKey
    ? (p[quantityKey] as { value?: number; unit?: string; unknown?: boolean; reason?: string })
    : null;
  return (
    <div className="inline-record-body">
      {typeof p.markdown === 'string' ? (
        <Prose markdown={p.markdown} />
      ) : typeof p.statement === 'string' ? (
        <p>{p.statement}</p>
      ) : null}
      {q && quantityKey && (
        <QuantityEditor
          title={view.artifact.title}
          fields={[
            {
              name: quantityKey,
              label: quantityKey === 'target' ? 'Target' : 'Value',
              unit: q.unit || '',
              value: q.unknown ? null : (q.value ?? null),
              reason: q.reason || 'No measured value recorded',
            },
          ]}
          projectId={projectId}
          storageKey={storageKey}
          reference={{ artifactId: view.artifact.id, revisionId: revision.id }}
        />
      )}
      <dl className="inline-value-list">
        {flatten(p)
          .filter((f) => !['Markdown', 'Statement', 'Target', 'Value'].includes(f.label))
          .map((f, i) => (
            <div key={`${f.label}-${i}`}>
              <dt>{f.label}</dt>
              <dd className={f.value.unknown ? 'tone-warn-text' : ''}>{f.value.text}</dd>
            </div>
          ))}
      </dl>
      {revision.files.length > 0 && (
        <p className="inline-caption">
          {revision.files.length} recorded files · open provenance for identity
        </p>
      )}
    </div>
  );
}
function MechanicalCard({
  view,
  revision,
  projectId,
  storageKey,
  onShown,
}: {
  view: ArtifactView;
  revision: Revision;
  projectId: string;
  storageKey: string;
  onShown?: (ready: boolean) => void;
}) {
  const sources = useCadSources(view.artifact.id, [revision]);
  const source = sources[revision.id];
  const payload = revision.payload as MechanicalPayload;
  const rows = parameterRows(
    source?.status === 'ready' ? source.value.text : null,
    payload.params || {},
    payload.paramManifest || [],
  );
  const hasSource = revision.files.some((f) => f.path.endsWith('.scad'));
  // A small window renders 3D only when asked; a review still needs the mesh shown to approve.
  const compact = useContext(CompactContext);
  const [show3d, setShow3d] = useState(!compact);
  return (
    <>
      {show3d ? (
        <Suspense
          fallback={
            <div className="inline-loading">
              <Spinner /> Loading 3D…
            </div>
          }
        >
          <InlineMesh revision={revision} onShown={onShown} />
        </Suspense>
      ) : (
        <div className="inline-mesh-deferred">
          <span className="inline-caption">The 3D view waits until you show it here.</span>
          <Button size="sm" onClick={() => setShow3d(true)}>
            Show 3D
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => useStore.getState().go({ level: 'agent' })}
          >
            Open on the Agent tab
          </Button>
        </div>
      )}
      {source?.status === 'ready' || !hasSource ? (
        <ParameterEditor
          key={revision.id}
          rows={rows}
          view={view}
          revision={revision}
          projectId={projectId}
          storageKey={storageKey}
        />
      ) : source?.status === 'failed' ? (
        <Notice tone="err">
          Could not read source: {source.error}
          <Button size="sm" onClick={source.retry}>
            Try again
          </Button>
        </Notice>
      ) : (
        <div className="inline-loading">
          <Spinner /> Reading dimensions…
        </div>
      )}
    </>
  );
}
function readSaved<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(`omen.inline.v1/${key}`) || 'null') as T) || fallback;
  } catch {
    return fallback;
  }
}
function useSaved<T>(key: string, initial: T): [T, (next: T) => void] {
  const [value, set] = useState(() => readSaved(key, initial));
  return [
    value,
    (next) => {
      set(next);
      try {
        localStorage.setItem(`omen.inline.v1/${key}`, JSON.stringify(next));
      } catch {
        useStore.getState().toast('error', 'This card draft could not be saved on this device.');
      }
    },
  ];
}
export function parameterInput(
  rows: ParameterRow[],
  form: Record<string, string>,
  view: ArtifactView,
  revision: Revision,
): ChatInput {
  return {
    artifactId: view.artifact.id,
    revisionId: revision.id,
    title: view.artifact.title,
    intent: 'render',
    fields: rows
      .filter(
        (r) =>
          r.editable &&
          (!rows.some(
            (x) =>
              x.editable && (form[x.name] ?? parameterText(x.value)) !== parameterText(x.value),
          ) ||
            (form[r.name] ?? parameterText(r.value)) !== parameterText(r.value)),
      )
      .map((r) => ({
        name: r.name,
        text: form[r.name] ?? parameterText(r.value),
        unit: r.unit,
        unknown: false,
      })),
  };
}
function ParameterEditor({
  rows,
  view,
  revision,
  projectId,
  storageKey,
}: {
  rows: ParameterRow[];
  view: ArtifactView;
  revision: Revision;
  projectId: string;
  storageKey: string;
}) {
  const [form, setForm] = useSaved(`${storageKey}/${revision.id}`, parameterForm(rows));
  const [error, setError] = useState('');
  const readOnly = useStore((s) => s.readOnly);
  const newest = useStore((s) => s.artifacts.find((a) => a.artifact.id === view.artifact.id)?.head);
  const stale = newest && newest.id !== revision.id;
  const validation = parameterOverrides(rows, form);
  const editable = rows.filter((r) => r.editable);
  const primary = editable.filter((row) => !row.name.startsWith('$')).slice(0, 3);
  const additional = rows.filter((row) => !primary.includes(row));
  const prepare = () => {
    if (!validation.ok) {
      setError(validation.message);
      return;
    }
    const input = parameterInput(rows, form, view, revision);
    useChat
      .getState()
      .prepare(
        projectId,
        `Update ${view.artifact.title} with these dimensions, render the candidate, run the recorded checks, and bring the result back here for my review.`,
        input,
      );
    setError('');
  };
  const fields = (visible: ParameterRow[]) => (
    <fieldset className="inline-fields" disabled={readOnly}>
      {visible.map((r) => (
        <label className="inline-field" key={r.name}>
          <span title={r.description}>{r.name.replaceAll('_', ' ')}</span>
          <span className="inline-field-input">
            <input
              aria-label={`${r.name}${r.unit ? ` (${r.unit})` : ''}`}
              value={form[r.name] ?? parameterText(r.value)}
              onChange={(e) => {
                setForm({ ...form, [r.name]: e.target.value });
                setError('');
              }}
              disabled={!r.editable}
              inputMode={r.declared?.kind === 'number' ? 'decimal' : undefined}
            />
            <span>
              {r.unit ||
                (r.declared?.kind === 'number' ? 'unit unspecified' : r.declared?.kind || '')}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
  return (
    <div className="inline-editor">
      <div className="inline-section-head">
        <strong>Dimensions & parameters</strong>
        <span>Source values · units preserved</span>
      </div>
      {!editable.length && (
        <p className="inline-caption">
          No editable source parameters are recorded. Ask the agent to add dimensions.
        </p>
      )}
      {fields(primary)}
      {additional.length > 0 && (
        <details className="inline-parameter-more">
          <summary>More parameters · {additional.length}</summary>
          {fields(additional)}
        </details>
      )}
      {!validation.ok && (
        <p className="inline-error" role="alert">
          {validation.message}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {stale && (
        <Notice tone="warn">
          A newer revision exists. These values remain attached to this revision.{' '}
          <Button
            size="sm"
            onClick={() =>
              openCard(projectId, {
                kind: 'artifact',
                artifactId: view.artifact.id,
                revisionId: newest.id,
              })
            }
          >
            Open newer revision
          </Button>
        </Notice>
      )}
      <div className="inline-card-actions">
        <Button
          icon={<ArrowRight size={14} />}
          onClick={prepare}
          disabled={!validation.ok || !editable.length || readOnly || !!stale}
        >
          Prepare agent request
        </Button>
      </div>
      <p className="inline-caption">
        Prepare adds exact values to your composer. Send starts the agent to render and check a
        candidate. Approval is a separate human decision.
      </p>
    </div>
  );
}
function QuantityCard({
  part,
  projectId,
  storageKey,
}: {
  part: Extract<ChatPart, { kind: 'form' }>;
  projectId: string;
  storageKey: string;
}) {
  return (
    <section className="inline-card">
      <header className="inline-card-head">
        <span className="inline-card-icon">
          <SlidersHorizontal size={18} />
        </span>
        <div>
          <span className="chat-eyebrow">Agent requested input · unverified</span>
          <h2>{part.title}</h2>
        </div>
      </header>
      <QuantityEditor
        fields={part.fields}
        title={part.title}
        projectId={projectId}
        storageKey={storageKey}
      />
    </section>
  );
}
function QuantityEditor({
  fields,
  title,
  projectId,
  storageKey,
  reference,
}: {
  fields: QuantityFields;
  title: string;
  projectId: string;
  storageKey: string;
  reference?: { artifactId: string; revisionId: string };
}) {
  const [form, setForm] = useSaved(
    storageKey,
    fields.map((f) => ({
      name: f.name,
      text: f.value === null ? '' : String(f.value),
      unit: f.unit,
      unknown: f.value === null,
      reason: f.reason || '',
    })),
  );
  const [error, setError] = useState('');
  const readOnly = useStore((s) => s.readOnly);
  const prepare = () => {
    const problem = quantityProblem(fields, form);
    if (problem) {
      setError(problem);
      return;
    }
    useChat
      .getState()
      .prepare(
        projectId,
        `Evaluate ${title} using these exact constraints. Keep unknowns explicit, run the applicable checks, and show the recorded result here.`,
        { ...reference, title, intent: 'evaluate', fields: form },
      );
    setError('');
  };
  return (
    <div className="inline-editor">
      <fieldset className="inline-quantities" disabled={readOnly}>
        {form.map((f, i) => (
          <div className="inline-quantity" key={f.name}>
            <label className="inline-field">
              <span>{fields[i]?.label || f.name}</span>
              <span className="inline-field-input">
                <input
                  aria-label={`${fields[i]?.label || f.name} value`}
                  inputMode="decimal"
                  value={f.text}
                  disabled={f.unknown}
                  onChange={(e) =>
                    setForm(form.map((x, n) => (n === i ? { ...x, text: e.target.value } : x)))
                  }
                />
                <input
                  className="inline-unit"
                  aria-label={`${fields[i]?.label || f.name} unit`}
                  value={f.unit}
                  disabled={f.unknown}
                  onChange={(e) =>
                    setForm(form.map((x, n) => (n === i ? { ...x, unit: e.target.value } : x)))
                  }
                  maxLength={32}
                  placeholder="unspecified"
                />
              </span>
            </label>
            <Checkbox
              label="Unknown"
              checked={f.unknown}
              onChange={(unknown) =>
                setForm(
                  form.map((x, n) =>
                    n === i ? { ...x, unknown, ...(unknown ? { unit: fields[i]!.unit } : {}) } : x,
                  ),
                )
              }
            />
            {f.unknown && (
              <label className="inline-reason">
                Why is it unknown?
                <input
                  value={f.reason}
                  maxLength={500}
                  onChange={(e) =>
                    setForm(form.map((x, n) => (n === i ? { ...x, reason: e.target.value } : x)))
                  }
                />
              </label>
            )}
          </div>
        ))}
      </fieldset>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="inline-card-actions">
        <Button onClick={prepare} disabled={readOnly} icon={<ArrowRight size={14} />}>
          Prepare evaluation
        </Button>
        <span>Review the attachment, then Send.</span>
      </div>
      <p className="inline-caption">
        Values and units travel exactly as entered. For a different compatible unit, enter the
        corresponding value. An unspecified unit stays unspecified until you supply one.
      </p>
    </div>
  );
}
function ReviewCard({ projectId, proposalId }: { projectId: string; proposalId: string }) {
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rationale, setRationale] = useState('');
  const [read, setRead] = useState(false);
  const [geometry, setGeometry] = useState<Record<string, boolean>>({});
  const [filesReady, setFilesReady] = useState<Record<string, boolean>>({});
  const [scopes, setScopes] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  const readOnly = useStore((s) => s.readOnly);
  useEffect(() => {
    let alive = true;
    void cmd<ProposalDetail>('proposal.read', { proposalId }, { projectId }).then(
      (d) => {
        if (alive) {
          setDetail(d);
          setError('');
        }
      },
      (e) => alive && setError(errMsg(e)),
    );
    return () => {
      alive = false;
    };
  }, [projectId, proposalId, attempt]);
  if (!detail)
    return (
      <section className="inline-card">
        <p className="inline-loading">
          {error || (
            <>
              <Spinner /> Reading proposal…
            </>
          )}
        </p>
        {error && <Button onClick={() => setAttempt(attempt + 1)}>Try again</Button>}
      </section>
    );
  const phase = detailPhase(detail);
  const pending =
    phase.kind === 'needs_you' || phase.kind === 'base_moved' || phase.kind === 'waiting_on_agent';
  const geometryReady = detail.changes.every(
    (c) =>
      c.change.kind === 'archive' ||
      c.artifact?.type !== 'mechanical' ||
      !c.next?.files.some((f) => f.path.endsWith('.stl')) ||
      geometry[c.next.id],
  );
  const sourcesReady = detail.changes.every(
    (c) => c.change.kind === 'archive' || (!!c.next && filesReady[c.change.artifactId]),
  );
  const decide = async (op: 'approve' | 'request_changes') => {
    if (
      busy ||
      !pending ||
      readOnly ||
      (op === 'approve' &&
        (!read || !geometryReady || !sourcesReady || phase.kind === 'base_moved')) ||
      (op === 'request_changes' && !rationale.trim())
    )
      return;
    setBusy(true);
    setError('');
    try {
      const latest = await cmd<ProposalDetail>('proposal.read', { proposalId }, { projectId });
      if (JSON.stringify(latest) !== JSON.stringify(detail)) {
        setDetail(latest);
        setRead(false);
        throw new Error(
          'This proposal changed. Read the updated card and confirm before deciding.',
        );
      }
      await cmd(
        `proposal.${op}`,
        {
          proposalId,
          rationale: rationale.trim(),
          ...(op === 'approve'
            ? {
                verificationEvidence: Object.fromEntries(
                  detail.changes
                    .filter(
                      (c) =>
                        c.verification?.evidenceHash &&
                        scopes[c.change.artifactId] === c.verification.evidenceHash,
                    )
                    .map((c) => [c.change.artifactId, c.verification!.evidenceHash!]),
                ),
              }
            : {}),
        },
        { projectId },
      );
      const store = useStore.getState();
      if (store.projectId === projectId)
        await Promise.all([store.refreshArtifacts(), store.refreshProposals()]);
      setDetail(await cmd<ProposalDetail>('proposal.read', { proposalId }, { projectId }));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="inline-card inline-review">
      <header className="inline-card-head">
        <span className="inline-card-icon">
          <ShieldCheck size={19} />
        </span>
        <div>
          <span className="chat-eyebrow">Human review</span>
          <h2>
            {detail.changes.length === 1 && detail.changes[0]?.artifact
              ? `Review ${detail.changes[0].artifact.title}`
              : `Review ${detail.changes.length} changes`}
          </h2>
        </div>
        <State state={detail.proposal.state} label={phaseLabel(phase)} />
        <Button size="sm" variant="ghost" onClick={() => useStore.getState().decide(proposalId)}>
          Open in Decisions
        </Button>
      </header>
      {detail.proposal.reason && (
        <details className="inline-provenance">
          <summary>Why this change was proposed</summary>
          <Prose markdown={detail.proposal.reason} />
        </details>
      )}
      <details className="inline-provenance">
        <summary>What this decision changes</summary>
        <ul>
          {approvalEffects(
            detail,
            (id) =>
              useStore.getState().artifacts.find((v) => v.artifact.id === id)?.artifact.title || id,
            scopes,
          ).map((effect) => (
            <li key={effect}>{effect}</li>
          ))}
        </ul>
      </details>
      {detail.changes.map((c) => (
        <div className="inline-review-change" key={c.change.artifactId}>
          <h3>{c.artifact?.title || c.change.artifactId}</h3>
          <div className="inline-review-identity">
            r{c.base?.seq ?? '—'} <ArrowRight size={12} /> r{c.next?.seq ?? '—'}{' '}
            <span>
              {c.verification
                ? `Checks: ${c.verification.status}`
                : 'No engine verification recorded'}
            </span>
          </div>
          <InlineVerification
            verification={c.verification}
            accepted={
              !!c.verification?.evidenceHash &&
              scopes[c.change.artifactId] === c.verification.evidenceHash
            }
            disabled={!pending || busy || readOnly}
            showAcceptance={pending}
            onAccept={(checked) =>
              setScopes((s) => ({
                ...s,
                [c.change.artifactId]: checked ? c.verification!.evidenceHash! : '',
              }))
            }
          />
          <InlinePayloadReview
            before={c.base?.payload}
            proposed={c.next?.payload}
            mechanical={c.artifact?.type === 'mechanical'}
          />
          {c.next && c.artifact?.type === 'mechanical' && (
            <details className="inline-provenance">
              <summary>Inspect proposed geometry</summary>
              <Suspense fallback={<Spinner />}>
                <InlineMesh
                  revision={c.next}
                  onShown={(ready) =>
                    setGeometry((g) =>
                      g[c.next!.id] === ready ? g : { ...g, [c.next!.id]: ready },
                    )
                  }
                />
              </Suspense>
            </details>
          )}
          <InlineFileReview
            projectId={projectId}
            base={c.base}
            next={c.next}
            meshPath={
              c.artifact?.type === 'mechanical'
                ? (
                    c.next?.files.find(
                      (f) =>
                        f.path === (c.next?.payload as MechanicalPayload | undefined)?.stl?.path,
                    ) ?? c.next?.files.find((f) => f.path.endsWith('.stl'))
                  )?.path
                : undefined
            }
            onReady={(ready) =>
              setFilesReady((f) =>
                f[c.change.artifactId] === ready ? f : { ...f, [c.change.artifactId]: ready },
              )
            }
          />
          <details className="inline-provenance">
            <summary>Revision rationale & authorship</summary>
            <p>{c.next?.rationale || 'No revision rationale recorded.'}</p>
            <p>
              Authored by: {c.next?.origin || 'Not recorded'}. Approval does not establish that the
              design is verified.
            </p>
          </details>
        </div>
      ))}
      {pending && (
        <div className="inline-editor">
          {phase.kind === 'base_moved' && (
            <Notice tone="warn">
              The baseline moved. Ask the agent to refresh this proposal before approving.
            </Notice>
          )}
          <Checkbox
            label="I reviewed these exact changes and their evidence"
            checked={read}
            onChange={setRead}
          />
          <label className="inline-reason">
            Review note
            <textarea
              value={rationale}
              maxLength={4000}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Optional for approval; required when requesting changes"
            />
          </label>
          {!geometryReady && (
            <p className="inline-caption">Open and inspect each proposed mesh before approval.</p>
          )}
          <div className="inline-card-actions">
            <ConfirmButton
              label="Approve baseline"
              confirmLabel="Confirm approval"
              tone="neutral"
              busy={busy}
              disabled={
                !read || !geometryReady || !sourcesReady || phase.kind === 'base_moved' || readOnly
              }
              onConfirm={() => void decide('approve')}
            />
            <Button
              size="sm"
              disabled={busy || !rationale.trim() || readOnly}
              onClick={() => void decide('request_changes')}
            >
              Request changes
            </Button>
          </div>
        </div>
      )}
      {error && (
        <Notice tone="err" role="alert">
          {error}
        </Notice>
      )}
    </section>
  );
}
