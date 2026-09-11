import React, { useEffect, useState } from 'react';
import { cmd } from '../api';
import { useStore } from '../store';

/** Engineering summary: intent, baseline, open decisions, stale, next actions. */
export function OverviewView() {
  const { project, artifacts, proposals, stale, suggestions, selectArtifact, navigate, projectId } = useStore();
  const [summary, setSummary] = useState<{
    counts: Record<string, number>;
    requirements: { id: string; title: string; target: string | null; freshness: string }[];
    assumptions: { id: string; title: string; statement: string }[];
    staleArtifacts: { artifactId: string; title: string; reason: string }[];
    recentDecisions: { action: string; rationale: string; ts: string }[];
  } | null>(null);

  useEffect(() => {
    if (!projectId) return;
    void cmd<typeof summary>('project.summary', { budget: 20000 }).then(setSummary).catch(() => setSummary(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, artifacts.length, proposals.length]);

  const pending = proposals.filter((p) => p.state === 'pending');
  const staleIds = Object.keys(stale).filter((k) => stale[k]!.length > 0);
  const isEmpty = artifacts.length === 0;

  return (
    <div style={{ padding: 16, overflowY: 'auto', height: '100%', maxWidth: 860 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>{project?.name ?? 'Project'}</h2>
      <p className="dim" style={{ marginTop: 0 }}>{project?.intent || 'No intent recorded.'}</p>

      {isEmpty && (
        <EmptyBlock
          title="Describe your project in the terminal"
          body="Start an agent session below and describe what you're building. The agent will create requirements, assumptions, and first artifacts through STARK's tools."
        />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Section title="Requirements">
          {summary?.requirements.length ? (
            summary.requirements.map((r) => (
              <Row
                key={r.id}
                left={r.title}
                right={r.target ?? ''}
                badge={r.freshness !== 'current' ? r.freshness : undefined}
                onClick={() => { selectArtifact(r.id); navigate('requirements'); }}
              />
            ))
          ) : (
            <div className="faint">None yet</div>
          )}
        </Section>

        <Section title="Open assumptions">
          {summary?.assumptions.length ? (
            summary.assumptions.map((a) => <Row key={a.id} left={a.title} onClick={() => selectArtifact(a.id)} />)
          ) : (
            <div className="faint">None recorded</div>
          )}
        </Section>

        <Section title={`Pending reviews (${pending.length})`}>
          {pending.length ? (
            pending.map((p) => (
              <Row key={p.id} left={p.reason} right={`${p.changes.length} change${p.changes.length > 1 ? 's' : ''}`} onClick={() => navigate('reviews')} />
            ))
          ) : (
            <div className="faint">Nothing waiting for review</div>
          )}
        </Section>

        <Section title={`Stale artifacts (${staleIds.length})`}>
          {staleIds.length ? (
            staleIds.map((id) => (
              <Row key={id} left={titleOf(id)} right="stale" onClick={() => selectArtifact(id)} />
            ))
          ) : (
            <div className="faint">All current</div>
          )}
        </Section>
      </div>

      {suggestions.length > 0 && (
        <Section title="Suggested next actions">
          {suggestions.map((s, i) => (
            <div key={i} style={{ padding: '4px 0' }}>
              <div>{s.title}</div>
              {s.detail && <div className="faint" style={{ fontSize: 12 }}>{s.detail}</div>}
            </div>
          ))}
        </Section>
      )}

      <Section title="Recent changes">
        {(summary?.recentDecisions ?? []).slice(0, 8).map((d, i) => (
          <div key={i} style={{ padding: '3px 0', fontSize: 12 }}>
            <span className="dim">{d.ts.slice(0, 16).replace('T', ' ')}</span> — {d.action} — {d.rationale}
          </div>
        ))}
      </Section>
    </div>
  );

  function titleOf(id: string): string {
    return artifacts.find((v) => v.artifact.id === id)?.artifact.title ?? id.slice(0, 8);
  }
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-main)', border: '1px solid var(--border)', borderRadius: 6, padding: 12, marginTop: 12 }}>
      <div className="dim" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{props.title}</div>
      {props.children}
    </div>
  );
}
function Row(props: { left: string; right?: string; badge?: string; onClick?: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={props.onClick}
      onKeyDown={(e) => e.key === 'Enter' && props.onClick?.()}
      style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', cursor: 'pointer', fontSize: 13 }}
    >
      <span>{props.left}</span>
      <span className="dim">
        {props.right} {props.badge && <span className="pill stale" style={{ marginLeft: 6 }}>{props.badge}</span>}
      </span>
    </div>
  );
}
export function EmptyBlock(props: { title: string; body: string }) {
  return (
    <div style={{ border: '1px dashed var(--border-strong)', borderRadius: 6, padding: 20, margin: '12px 0' }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{props.title}</div>
      <div className="dim" style={{ fontSize: 13 }}>{props.body}</div>
    </div>
  );
}
