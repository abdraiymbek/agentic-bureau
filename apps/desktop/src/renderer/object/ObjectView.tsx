import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRight, ArrowSquareOut, At, CaretRight } from '@phosphor-icons/react';
import type { ArtifactView, Revision } from '@omenflow/contracts';
import { cmd, errMsg } from '../api';
import { openProposals, useStore } from '../store';
import { lineageOf, relationshipLabel, type Link } from '../lib/graph';
import {
  Button,
  Empty,
  Facts,
  Notice,
  State,
  TypeGlyph,
  relativeTime,
  shortId,
  typeMeta,
} from '../ui/kit';
import { ObjectStage } from './stages';
import { displayedMechanicalRevision } from '../lib/mechanical-revisions';

/**
 * Zoom level 1: one object in focus. Its inputs sit on the left, its consequences on
 * the right; moving through the project means moving along those links.
 */
export function ObjectView({ id }: { id: string }) {
  const view = useStore((s) => s.artifacts.find((v) => v.artifact.id === id));
  const artifacts = useStore((s) => s.artifacts);
  const edges = useStore((s) => s.edges);
  const zoomOut = useStore((s) => s.zoomOut);
  const projectId = useStore((s) => s.projectId);
  const [loaded, setLoaded] = useState<{ owner: string; revisions: Revision[] } | null>(null);
  const [selected, setSelected] = useState<{ owner: string; id: string } | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const owner = `${projectId}:${id}`;
  const [mechanicalShown, setMechanicalShown] = useState<{
    owner: string;
    revision: Revision | null;
  } | null>(null);
  const onMechanicalRevision = useCallback(
    (revision: Revision | null) => setMechanicalShown({ owner, revision }),
    [owner],
  );
  useEffect(() => {
    if (!view || view.artifact.type === 'mechanical') return;
    let active = true;
    setError('');
    void cmd<{ revisions: Revision[] }>(
      'artifact.history',
      { artifactId: id },
      { projectId: projectId ?? undefined },
    )
      .then((r) => active && setLoaded({ owner, revisions: r.revisions }))
      .catch((e) => active && setError(errMsg(e)));
    return () => {
      active = false;
    };
  }, [view, id, projectId, owner, attempt]);
  const revisions = loaded?.owner === owner ? loaded.revisions : null;
  const shownRevision =
    revisions && view
      ? displayedMechanicalRevision(
          revisions,
          view.artifact.selectedRevisionId,
          selected?.owner === owner ? selected.id : null,
        )
      : (view?.revision ?? null);
  const shown = view
    ? {
        ...view,
        revision:
          view.artifact.type === 'mechanical' && mechanicalShown?.owner === owner
            ? mechanicalShown.revision
            : shownRevision,
      }
    : undefined;
  const lineage = lineageOf(id, edges, shown);

  if (!view)
    return artifacts.length ? (
      <div className="focus-missing">
        <Empty
          title="This object isn’t in the current record"
          body="It may have been archived or belong to another project."
          action={<Button onClick={zoomOut}>Back to the flow</Button>}
        />
      </div>
    ) : (
      <div className="focus-missing">
        <p className="lens-muted" role="status">
          Loading the record…
        </p>
      </div>
    );

  return (
    <div className="focus">
      <aside className="rail rail-up" aria-label="Inputs and record">
        <LinkList
          title="Depends on"
          links={lineage.upstream}
          side="up"
          empty="No recorded inputs."
        />
        <Record view={shown!} />
      </aside>
      <main className="focus-stage" aria-label={view.artifact.title}>
        <div className="focus-scroll">
          <StageHeader view={shown!} />
          <StaleNotice view={view} />
          {view.artifact.type !== 'mechanical' && (
            <div className="stage-toolbar">
              <label className="field-label">
                Revision{' '}
                <select
                  aria-label="Displayed revision"
                  value={selected?.owner === owner ? selected.id : ''}
                  onChange={(e) =>
                    setSelected(e.target.value ? { owner, id: e.target.value } : null)
                  }
                >
                  <option value="">Latest work</option>
                  {[...(revisions ?? [])]
                    .sort((a, b) => b.seq - a.seq)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        r{r.seq} ·{' '}
                        {r.id === view.artifact.selectedRevisionId ? 'Baseline' : r.reviewState}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          )}
          {view.artifact.type === 'mechanical' ? (
            <ObjectStage key={owner} view={view} onRevisionChange={onMechanicalRevision} />
          ) : error ? (
            <Empty
              title="Revisions didn’t load"
              body={error}
              action={<Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}
            />
          ) : !revisions ? (
            <p role="status" className="dim">
              Loading recorded content…
            </p>
          ) : !shownRevision ? (
            <Empty
              title="No active revision"
              body="Ask the agent to create a draft, or choose a recorded revision above."
            />
          ) : (
            <>
              {shownRevision.id !== view.artifact.selectedRevisionId && (
                <Notice>
                  Showing r{shownRevision.seq} · {shownRevision.reviewState}.{' '}
                  {view.artifact.selectedRevisionId
                    ? 'The approved baseline is available in the revision picker.'
                    : 'No approved baseline yet.'}{' '}
                  This content has not become the baseline.
                </Notice>
              )}
              <ObjectStage key={`${owner}:${shownRevision.id}`} view={shown!} />
            </>
          )}
        </div>
      </main>
      <aside className="rail rail-down" aria-label="Consequences and history">
        <LinkList
          title="Affects"
          links={lineage.downstream}
          side="down"
          empty="Nothing depends on this yet."
        />
        {lineage.related.length > 0 && (
          <LinkList title="Related" links={lineage.related} side="down" empty="" />
        )}
        <History view={view} />
      </aside>
    </div>
  );
}

function StageHeader({ view }: { view: ArtifactView }) {
  const askAbout = useStore((s) => s.askAbout);
  const decide = useStore((s) => s.decide);
  const readOnly = useStore((s) => s.readOnly);
  const proposalId =
    useStore((s) =>
      openProposals(s.proposals).find((p) =>
        p.changes.some((c) => c.artifactId === view.artifact.id),
      ),
    )?.id ?? null;
  const meta = typeMeta(view.artifact.type);
  const rev = view.revision;
  return (
    <header className="stage-head">
      <div className="stage-kind">
        <TypeGlyph type={view.artifact.type} size={14} />
        <span>{meta.label}</span>
        {view.artifact.subsystem && (
          <>
            <CaretRight size={10} />
            <span>{view.artifact.subsystem}</span>
          </>
        )}
      </div>
      <div className="stage-title-row">
        <h1>{view.artifact.title}</h1>
        <Button
          size="sm"
          variant="ghost"
          icon={<At size={13} />}
          onClick={() =>
            askAbout(
              `About the Omen Flow ${meta.label.toLowerCase()} "${view.artifact.title}" (artifact ${view.artifact.id}${rev ? `, revision ${rev.seq}` : ''}): `,
            )
          }
        >
          Ask agent
        </Button>
      </div>
      <div className="stage-states">
        <State state={rev?.reviewState ?? 'draft'} label={rev ? undefined : 'No baseline'} />
        <State state={view.freshness} />
        {view.pendingProposal && (
          <button type="button" className="state-link" onClick={() => decide(proposalId)}>
            <State state="pending" label="Change in review" />
          </button>
        )}
        {view.draftCount > 0 && (
          <State
            state="draft"
            label={`${view.draftCount} draft${view.draftCount > 1 ? 's' : ''}`}
          />
        )}
        <span className="stage-rev">{rev ? `Revision ${rev.seq}` : 'Unrevised'}</span>
        {readOnly && <State state="read-only" label="Read-only project" tone="neutral" />}
      </div>
    </header>
  );
}

function StaleNotice({ view }: { view: ArtifactView }) {
  const stale = useStore((s) => s.stale[view.artifact.id] ?? []);
  const artifacts = useStore((s) => s.artifacts);
  const focus = useStore((s) => s.focus);
  if (!stale.length) return null;
  const title = (id: string) =>
    artifacts.find((v) => v.artifact.id === id)?.artifact.title ?? shortId(id);
  return (
    <div className="stale-notices">
      {stale.map((r, i) => (
        <Notice key={i} tone={r.reason === 'missing_input' ? 'err' : 'warn'}>
          <strong>
            {r.reason === 'missing_input'
              ? 'An input is missing.'
              : 'An input changed after this was recorded.'}
          </strong>{' '}
          <span className="impact-path">
            {r.path.map((pid, n) => (
              <React.Fragment key={`${pid}-${n}`}>
                {n > 0 && <ArrowRight size={11} />}
                {pid === view.artifact.id ? (
                  <span className="impact-self">this</span>
                ) : (
                  <button type="button" onClick={() => focus(pid)}>
                    {title(pid)}
                  </button>
                )}
              </React.Fragment>
            ))}
          </span>
        </Notice>
      ))}
    </div>
  );
}

function LinkList({
  title,
  links,
  side,
  empty,
}: {
  title: string;
  links: Link[];
  side: 'up' | 'down';
  empty: string;
}) {
  const artifacts = useStore((s) => s.artifacts);
  const stale = useStore((s) => s.stale);
  const focus = useStore((s) => s.focus);
  return (
    <section className={`links links-${side}`}>
      <h2>
        {title}
        {links.length > 0 && <span className="count">{links.length}</span>}
      </h2>
      {links.length ? (
        <ul>
          {links.map((l) => {
            const v = artifacts.find((a) => a.artifact.id === l.id);
            const out = (stale[l.id] ?? []).length > 0;
            return (
              <li key={l.id}>
                <button
                  type="button"
                  className="link-node"
                  onClick={() => focus(l.id)}
                  disabled={!v}
                >
                  <TypeGlyph type={v?.artifact.type ?? 'note'} size={14} />
                  <span className="link-copy">
                    <span className="link-title">
                      {v?.artifact.title ?? `Unavailable · ${shortId(l.id)}`}
                    </span>
                    <small>
                      {l.label || relationshipLabel(l.relationship)}
                      {l.pinnedRevisionId ? ' · pinned' : ''}
                    </small>
                  </span>
                  {out && <span className="map-mark tone-warn" aria-label="Out of date" />}
                  {v?.pendingProposal && !out && (
                    <span className="map-mark tone-warn" aria-label="In review" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rail-empty">{empty}</p>
      )}
    </section>
  );
}

function Record({ view }: { view: ArtifactView }) {
  const toast = useStore((s) => s.toast);
  const rev = view.revision;
  const payload = (rev?.payload ?? {}) as Record<string, unknown>;
  const rows: [string, React.ReactNode][] = [
    ['Origin', rev ? `${rev.origin}${rev.originDetail ? ` · ${rev.originDetail}` : ''}` : '—'],
    ['Recorded', rev ? relativeTime(rev.createdAt) : '—'],
  ];
  if (typeof payload.evidenceKind === 'string') rows.push(['Evidence', payload.evidenceKind]);
  if (payload.bounds && typeof payload.bounds === 'object') {
    const b = payload.bounds as { min: number[]; max: number[] };
    const unit = String(payload.modelUnit ?? 'mm');
    rows.push([
      'Bounds',
      <span className="num" key="b">
        {[0, 1, 2].map((i) => ((b.max[i] ?? 0) - (b.min[i] ?? 0)).toFixed(1)).join(' × ')} {unit}
      </span>,
    ]);
  }
  rows.push([
    'Identifier',
    <span className="mono" title={view.artifact.id} key="id">
      {shortId(view.artifact.id)}
    </span>,
  ]);
  return (
    <section className="record">
      <h2>Record</h2>
      <Facts rows={rows} />
      {rev && rev.files.length > 0 && (
        <button
          type="button"
          className="rail-action"
          onClick={() =>
            void cmd('artifact.reveal', { artifactId: view.artifact.id }).catch((e) =>
              toast('error', errMsg(e)),
            )
          }
        >
          <ArrowSquareOut size={13} />
          Reveal {rev.files.length} {rev.files.length === 1 ? 'file' : 'files'}
        </button>
      )}
    </section>
  );
}

function History({ view }: { view: ArtifactView }) {
  const projectId = useStore((s) => s.projectId);
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setError('');
    void cmd<{ revisions: Revision[] }>(
      'artifact.history',
      { artifactId: view.artifact.id },
      { projectId: projectId ?? undefined },
    )
      .then((r) => !cancelled && setRevisions(r.revisions))
      .catch((e) => !cancelled && setError(errMsg(e)));
    return () => {
      cancelled = true;
    };
  }, [view.artifact.id, view.revision?.id, view.draftCount, projectId]);
  const baseline = view.artifact.selectedRevisionId;
  const sorted = [...(revisions ?? [])].sort((a, b) => b.seq - a.seq).slice(0, 12);
  return (
    <section className="history">
      <h2>
        Revisions
        {revisions && <span className="count">{revisions.length}</span>}
      </h2>
      {error ? (
        <p className="rail-empty">History didn’t load: {error}</p>
      ) : !revisions ? (
        <p className="rail-empty">Loading…</p>
      ) : (
        <ol>
          {sorted.map((r) => (
            <li key={r.id} className={r.id === baseline ? 'baseline' : ''}>
              <span className="history-seq">r{r.seq}</span>
              <span className="history-copy">
                <span>
                  {r.id === baseline
                    ? 'Baseline'
                    : r.reviewState[0]!.toUpperCase() + r.reviewState.slice(1)}
                  <span className="dim"> · {r.origin}</span>
                </span>
                <small title={r.rationale || undefined}>
                  <time>{relativeTime(r.createdAt)}</time>
                  {r.rationale ? ` · ${r.rationale}` : ''}
                </small>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
