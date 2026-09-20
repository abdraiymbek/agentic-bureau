import React, { useEffect, useState } from 'react';
import {
  ArrowSquareOut,
  ArrowRight,
  GitBranch,
  Link,
  WarningCircle,
  TerminalWindow,
  SlidersHorizontal,
} from '@phosphor-icons/react';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import { ArtifactIcon, EmptyState, StatusBadge, typeLabels } from './ui';
import type { Revision } from '@omenflow/contracts';

export function Inspector() {
  const { selectedArtifactId, artifacts, stale, selectArtifact, navigate, toast, set } = useStore();
  const view = artifacts.find((v) => v.artifact.id === selectedArtifactId);
  const [revision, setRevision] = useState<Revision | null>(null);
  const [neighbors, setNeighbors] = useState<{
    artifacts: { id: string; title: string; type: string }[];
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setRevision(null);
    setNeighbors(null);
    setError('');
    if (selectedArtifactId)
      void Promise.all([
        cmd<{ revision: Revision | null }>('artifact.read', { artifactId: selectedArtifactId }),
        cmd<{ artifacts: { id: string; title: string; type: string }[] }>('graph.neighbors', {
          artifactId: selectedArtifactId,
          depth: 1,
        }),
      ])
        .then(([r, n]) => {
          if (!cancelled) {
            setRevision(r.revision);
            setNeighbors(n);
          }
        })
        .catch((e) => {
          if (!cancelled) setError(errMsg(e));
        });
    return () => {
      cancelled = true;
    };
  }, [selectedArtifactId, artifacts]);
  if (!view)
    return (
      <EmptyState
        title="The detail behind the design"
        body="Select an engineering object to inspect its revision, inputs, sources, and connected work."
        icon={<SlidersHorizontal size={25} />}
      />
    );
  const a = view.artifact;
  const rev = revision ?? view.revision;
  const payload = (rev?.payload ?? {}) as Record<string, unknown>;
  const staleReasons = stale[a.id] ?? [];
  const titleOf = (id: string) =>
    artifacts.find((v) => v.artifact.id === id)?.artifact.title ?? id.slice(0, 8);
  const showObject = (id: string) => {
    selectArtifact(id);
    navigate('artifacts');
  };
  return (
    <div className="inspector">
      <div className="inspector-object">
        <span className="inspector-type">
          <ArtifactIcon type={a.type} size={15} />
          {typeLabels[a.type]}
        </span>
        <h2>{a.title}</h2>
        <span className="mono inspector-id" title={a.id}>
          {a.id.slice(0, 12)}
        </span>
      </div>
      {error && (
        <div className="inline-notice warning" role="alert">
          {error}
        </div>
      )}
      <Section title="Engineering state">
        <Row label="Revision">
          <span className="num">
            {rev ? `r${String(rev.seq).padStart(2, '0')}` : 'No baseline'}
          </span>
        </Row>
        <Row label="Review">
          <StatusBadge state={rev?.reviewState ?? 'draft'} />
        </Row>
        <Row label="Freshness">
          <StatusBadge state={view.freshness} />
        </Row>
        <Row label="Origin">
          <span>{rev?.origin ?? 'Unknown'}</span>
        </Row>
        {typeof payload.evidenceKind === 'string' && (
          <Row label="Evidence">
            <span>{payload.evidenceKind}</span>
          </Row>
        )}
        {view.draftCount > 0 && (
          <Row label="Open drafts">
            <span>{view.draftCount}</span>
          </Row>
        )}
      </Section>
      {staleReasons.length > 0 && (
        <Section title="What changed">
          {staleReasons.map((reason, i) => (
            <div className="inspector-impact" key={i}>
              <div className="row warn">
                <WarningCircle size={15} />
                <strong>
                  {reason.reason === 'missing_input' ? 'Missing input' : 'An input changed'}
                </strong>
              </div>
              <div className="impact-path">
                {reason.path.map((id, n) => (
                  <React.Fragment key={id}>
                    {n > 0 && <ArrowRight size={12} />}
                    <button onClick={() => showObject(id)}>{titleOf(id)}</button>
                  </React.Fragment>
                ))}
              </div>
            </div>
          ))}
        </Section>
      )}
      <Section title="Recorded inputs">
        {rev?.inputs.length ? (
          rev.inputs.map((input, i) => (
            <button className="inspector-link" key={i} onClick={() => showObject(input.artifactId)}>
              <Link size={14} />
              <span>
                {titleOf(input.artifactId)}
                <small>
                  {input.relationship.replaceAll('_', ' ')} · {input.revisionId.slice(0, 8)}
                </small>
              </span>
              <ArrowRight size={12} />
            </button>
          ))
        ) : (
          <p className="inspector-empty">No recorded inputs.</p>
        )}
      </Section>
      {neighbors && neighbors.artifacts.length > 1 && (
        <Section title="Connected objects">
          {neighbors.artifacts
            .filter((n) => n.id !== a.id)
            .map((n) => (
              <button className="inspector-link" key={n.id} onClick={() => showObject(n.id)}>
                <ArtifactIcon type={n.type} size={14} />
                <span>
                  {n.title}
                  <small>{typeLabels[n.type] ?? n.type}</small>
                </span>
                <ArrowRight size={12} />
              </button>
            ))}
          <button className="text-link" onClick={() => navigate('history')}>
            <GitBranch size={13} />
            Explore dependencies
            <ArrowRight size={12} />
          </button>
        </Section>
      )}
      {payload.bounds && typeof payload.bounds === 'object' ? (
        <Section title="Dimensions">
          {(() => {
            const bounds = payload.bounds as { min: number[]; max: number[] };
            return ['X', 'Y', 'Z'].map((axis, i) => (
              <Row key={axis} label={axis}>
                <span className="mono num">
                  {((bounds.max[i] ?? 0) - (bounds.min[i] ?? 0)).toFixed(2)}{' '}
                  {String(payload.modelUnit ?? 'mm')}
                </span>
              </Row>
            ));
          })()}
        </Section>
      ) : null}
      {payload.properties && typeof payload.properties === 'object' ? (
        <Section title="Properties">
          {Object.entries(
            payload.properties as Record<
              string,
              { quantity?: { value?: number; unit?: string; reason?: string } }
            >,
          ).map(([key, value]) => (
            <Row key={key} label={key.replaceAll('_', ' ')}>
              <span className="num">
                {value.quantity?.value !== undefined
                  ? `${value.quantity.value} ${value.quantity.unit ?? ''}`
                  : `Unknown${value.quantity?.reason ? `: ${value.quantity.reason}` : ''}`}
              </span>
            </Row>
          ))}
        </Section>
      ) : null}
      {typeof payload.url === 'string' && (
        <Section title="Source">
          <button
            className="inspector-link"
            onClick={() => void window.omenflow.openExternal(payload.url as string)}
          >
            <ArrowSquareOut size={14} />
            <span className="truncate">{payload.url}</span>
          </button>
        </Section>
      )}
      <div className="inspector-actions">
        <button
          onClick={() => {
            set({ sidecarTab: 'agent' });
            window.dispatchEvent(new CustomEvent('omenflow:focus-terminal'));
          }}
        >
          <TerminalWindow size={14} />
          Open agent
        </button>
        <button
          className="ghost"
          onClick={() =>
            void cmd('artifact.reveal', { artifactId: a.id }).catch((e) =>
              toast('error', errMsg(e)),
            )
          }
        >
          <ArrowSquareOut size={14} />
          Reveal files
        </button>
      </div>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="inspector-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="inspector-property">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}
