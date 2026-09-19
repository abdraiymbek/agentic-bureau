import React, { useEffect, useState } from 'react';
import { cmd } from '../api';
import { useStore } from '../store';
import type { Revision } from '@omenflow/contracts';

/**
 * Inspector: selected artifact's revision, freshness with explanation path,
 * inputs, sources, and downstream affects.
 */
export function Inspector() {
  const { selectedArtifactId, artifacts, stale, selectArtifact, navigate } = useStore();
  const view = artifacts.find((v) => v.artifact.id === selectedArtifactId);
  const [revision, setRevision] = useState<Revision | null>(null);
  const [neighbors, setNeighbors] = useState<{
    artifacts: { id: string; title: string; type: string }[];
  } | null>(null);

  useEffect(() => {
    if (!selectedArtifactId) {
      setRevision(null);
      setNeighbors(null);
      return;
    }
    void cmd<{ revision: Revision | null }>('artifact.read', {
      artifactId: selectedArtifactId,
    }).then((r) => setRevision(r.revision));
    void cmd<{ artifacts: { id: string; title: string; type: string }[] }>('graph.neighbors', {
      artifactId: selectedArtifactId,
      depth: 1,
    }).then(setNeighbors);
  }, [selectedArtifactId, artifacts]);

  if (!view) {
    return (
      <div style={{ padding: 12, fontSize: 12 }} className="faint">
        <div
          style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}
        >
          Inspector
        </div>
        Select an artifact to inspect its revision, inputs, and impact.
      </div>
    );
  }
  const a = view.artifact;
  const staleReasons = stale[a.id] ?? [];
  const payload = (revision?.payload ?? {}) as Record<string, unknown>;

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: 12,
        fontSize: 12,
        background: 'var(--bg-app)',
        borderLeft: '1px solid var(--border)',
      }}
    >
      <div
        className="dim"
        style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}
      >
        Inspector
      </div>
      <div style={{ fontWeight: 600, fontSize: 14, margin: '6px 0 2px' }}>{a.title}</div>
      <div className="faint mono" style={{ fontSize: 11 }}>
        {a.id.slice(0, 8)}…
      </div>

      <Section title="Revision">
        <Row k="Selected" v={revision ? `#${revision.seq}` : 'none'} />
        <Row k="State" v={revision?.reviewState ?? '—'} />
        <Row
          k="Freshness"
          v={view.freshness}
          cls={view.freshness === 'current' ? 'ok' : view.freshness === 'stale' ? 'warn' : 'err'}
        />
        <Row k="Origin" v={revision?.origin ?? '—'} />
      </Section>

      {staleReasons.length > 0 && (
        <Section title="Why stale">
          {staleReasons.map((s, i) => (
            <div key={i} className="warn" style={{ marginBottom: 4 }}>
              {s.reason === 'missing_input' ? 'Missing input' : 'Input changed'} — path:{' '}
              {s.path.map((id) => titleOf(id)).join(' → ')}
            </div>
          ))}
        </Section>
      )}

      {revision && revision.inputs.length > 0 && (
        <Section title="Inputs">
          {revision.inputs.map((i, n) => (
            <div
              key={n}
              role="button"
              tabIndex={0}
              style={{ cursor: 'pointer', padding: '2px 0' }}
              onClick={() => selectArtifact(i.artifactId)}
              onKeyDown={(e) => e.key === 'Enter' && selectArtifact(i.artifactId)}
            >
              <span className="dim">{i.relationship}</span> {titleOf(i.artifactId)}{' '}
              <span className="faint mono">@{i.revisionId.slice(0, 8)}</span>
            </div>
          ))}
        </Section>
      )}

      {neighbors && neighbors.artifacts.length > 1 && (
        <Section title="Affects / graph neighborhood">
          {neighbors.artifacts
            .filter((x) => x.id !== a.id)
            .map((x) => (
              <div
                key={x.id}
                role="button"
                tabIndex={0}
                style={{ cursor: 'pointer', padding: '2px 0' }}
                onClick={() => selectArtifact(x.id)}
                onKeyDown={(e) => e.key === 'Enter' && selectArtifact(x.id)}
              >
                {x.title} <span className="faint">({x.type})</span>
              </div>
            ))}
          <button
            style={{ marginTop: 6, height: 24, fontSize: 12 }}
            onClick={() => navigate('history')}
          >
            Open impact view
          </button>
        </Section>
      )}

      {typeof payload.bounds === 'object' && payload.bounds && (
        <Section title="Dimensions">
          {(() => {
            const b = payload.bounds as { min: number[]; max: number[] };
            return ['x', 'y', 'z'].map((axis, i) => (
              <Row
                key={axis}
                k={axis.toUpperCase()}
                v={`${(b.max[i]! - b.min[i]!).toFixed(2)} ${(payload.modelUnit as string) ?? 'mm'}`}
                mono
              />
            ));
          })()}
        </Section>
      )}

      {Object.keys(payload).includes('properties') && (
        <Section title="Properties">
          {Object.entries(
            (payload.properties as Record<
              string,
              { quantity?: { value?: number; unit?: string; unknown?: boolean; reason?: string } }
            >) ?? {},
          ).map(([k, v]) => (
            <Row
              key={k}
              k={k}
              v={
                v.quantity && 'value' in v.quantity
                  ? `${v.quantity.value} ${v.quantity.unit}`
                  : v.quantity?.reason
                    ? `unknown (${v.quantity.reason})`
                    : 'unknown'
              }
              mono
            />
          ))}
        </Section>
      )}

      <div className="col" style={{ marginTop: 12 }}>
        <button
          style={{ height: 26, fontSize: 12 }}
          onClick={() => {
            void cmd('ui.suggest_action', {
              title: `Review ${a.title}`,
              detail: `artifact ${a.id}`,
            });
            window.dispatchEvent(new CustomEvent('omenflow:focus-terminal'));
          }}
        >
          Ask agent
        </button>
        <button
          style={{ height: 26, fontSize: 12 }}
          onClick={() => void cmd('artifact.reveal', { artifactId: a.id }).catch(() => {})}
        >
          Reveal file
        </button>
      </div>
    </div>
  );

  function titleOf(id: string): string {
    return artifacts.find((v) => v.artifact.id === id)?.artifact.title ?? id.slice(0, 8);
  }
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div
        className="dim"
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 4,
        }}
      >
        {props.title}
      </div>
      {props.children}
    </div>
  );
}
function Row(props: { k: string; v: string; cls?: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
      <span className="dim">{props.k}</span>
      <span className={`${props.cls ?? ''} ${props.mono ? 'mono num' : ''}`}>{props.v}</span>
    </div>
  );
}
