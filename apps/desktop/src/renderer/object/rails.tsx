import React, { useRef, useState } from 'react';
import { ArrowSquareOut, CaretDoubleLeft, CaretDoubleRight } from '@phosphor-icons/react';
import type { ArtifactView, MechanicalPayload, Revision } from '@omenflow/contracts';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import { relationshipLabel, type Link } from '../lib/graph';
import { LATEST_WORK, revisionRole, type RevisionPick } from '../lib/mechanical-revisions';
import { formatEnvelope } from '../lib/viewport-math';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import {
  Facts,
  IconButton,
  Skeleton,
  TypeGlyph,
  relativeTime,
  shortId,
  stateLabel,
} from '../ui/kit';
import { useObjectRevisions } from './revisions';
import { useNavigate } from './stages/shared';

/**
 * One side rail of the object view: inputs on the left, consequences on the right. It folds to
 * its edge (remembered for every object, `omen.rails`), and a rail that fails to render says so
 * while the stage and the other rail keep working.
 */
export function ObjectRail({
  side,
  label,
  children,
}: {
  side: 'inputs' | 'consequences';
  /** The rail's name, as in "Inputs and record". */
  label: string;
  children: React.ReactNode;
}) {
  const folded = useStore((s) => s.rails[side]);
  const setRailCollapsed = useStore((s) => s.setRailCollapsed);
  const left = side === 'inputs';
  const Icon = left === folded ? CaretDoubleRight : CaretDoubleLeft;
  return (
    <aside
      className={`rail ${left ? 'rail-up' : 'rail-down'}${folded ? ' folded' : ''}`}
      aria-label={label}
    >
      <IconButton
        size="sm"
        className="rail-fold"
        label={`${folded ? 'Show' : 'Hide'} ${label.toLowerCase()}`}
        aria-expanded={!folded}
        onClick={() => setRailCollapsed(side, !folded)}
      >
        <Icon size={13} />
      </IconButton>
      {!folded && <ErrorBoundary label={label}>{children}</ErrorBoundary>}
    </aside>
  );
}

/** What stands out about a linked object, in words. */
function linkState(target: ArtifactView | undefined, stale: boolean): string | null {
  if (!target) return null;
  if (!target.artifact.selectedRevisionId) return 'not yet approved';
  if (stale) return 'out of date';
  if (target.pendingProposal) return 'in review';
  return null;
}

export function LinkList({
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
  const { focus } = useNavigate();
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
            const state = linkState(v, (stale[l.id] ?? []).length > 0);
            // A recorded input names one revision; say when the baseline has since moved on.
            const baseline = v?.artifact.selectedRevisionId;
            const pin = !l.pinnedRevisionId
              ? ''
              : baseline && baseline !== l.pinnedRevisionId
                ? ' · pinned to an earlier revision'
                : ' · pinned';
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
                      {pin}
                      {state && <span className="link-state"> · {state}</span>}
                    </small>
                  </span>
                  {state && <span className="map-mark tone-warn" aria-hidden="true" />}
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

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Facts about the revision on screen. */
export function Record({ view }: { view: ArtifactView }) {
  const toast = useStore((s) => s.toast);
  const revisions = useObjectRevisions(view);
  const rev = view.revision;
  const payload = (rev?.payload ?? {}) as Partial<MechanicalPayload> & { evidenceKind?: unknown };
  const baseline = revisions.revisions?.find((r) => r.id === revisions.baselineId) ?? null;
  // The core records the agent session a revision came from; its short form fits the rail.
  const session = rev?.originDetail && SESSION_ID.test(rev.originDetail) ? rev.originDetail : null;
  const rows: [string, React.ReactNode][] = [
    [
      'Origin',
      !rev ? (
        '—'
      ) : session ? (
        <span key="o" title={session}>
          {rev.origin} · session <span className="mono">{shortId(session)}</span>
        </span>
      ) : (
        `${rev.origin}${rev.originDetail ? ` · ${rev.originDetail}` : ''}`
      ),
    ],
    [
      'Recorded',
      rev ? (
        <time key="t" dateTime={rev.createdAt} title={new Date(rev.createdAt).toLocaleString()}>
          {relativeTime(rev.createdAt)}
        </time>
      ) : (
        '—'
      ),
    ],
  ];
  if (typeof payload.evidenceKind === 'string') rows.push(['Evidence', payload.evidenceKind]);
  if (payload.bounds)
    rows.push([
      'Bounds',
      <span className="num" key="b">
        {formatEnvelope(payload.bounds, payload.modelUnit ?? 'mm')}
      </span>,
    ]);
  rows.push([
    'Identifier',
    <span className="mono" title={view.artifact.id} key="id">
      {shortId(view.artifact.id)}
    </span>,
  ]);
  // Reveal opens the baseline's files in the project folder; other revisions have none there.
  const files = baseline?.files.length ?? 0;
  return (
    <section className="record">
      <h2>Record{rev ? ` · r${rev.seq}` : ''}</h2>
      <Facts rows={rows} />
      {files > 0 && (
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
          {baseline?.id === rev?.id
            ? `Reveal ${files} ${files === 1 ? 'file' : 'files'}`
            : `Reveal baseline files (${files})`}
        </button>
      )}
    </section>
  );
}

const VISIBLE = 12;

/**
 * Every recorded revision, newest first, and the control for which one is on screen. The
 * baseline and the displayed revision are both marked in words.
 */
export function RevisionRail({ view }: { view: ArtifactView }) {
  const revisions = useObjectRevisions(view);
  const list = useRef<HTMLOListElement>(null);
  const [all, setAll] = useState(false);
  const history = revisions.revisions;
  const sorted = [...(history ?? [])].sort((a, b) => b.seq - a.seq);
  const shown = all ? sorted : sorted.slice(0, VISIBLE);
  const displayedId = revisions.displayed?.id ?? null;
  const following = revisions.pick.kind === 'latest';

  const pickOf = (revision: Revision): RevisionPick =>
    revision.id === revisions.baselineId
      ? { kind: 'baseline' }
      : { kind: 'revision', id: revision.id };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const to =
      event.key === 'ArrowDown'
        ? Math.min(rows.length - 1, at + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, at - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? rows.length - 1
              : -1;
    if (to < 0 || at < 0) return;
    event.preventDefault();
    rows[to]?.focus();
  };

  return (
    <section className="history">
      <h2>
        Revisions
        {history && <span className="count">{history.length}</span>}
      </h2>
      {revisions.error && !history ? (
        <p className="rail-empty">
          Revisions didn’t load: {revisions.error}{' '}
          <button type="button" className="link" onClick={() => void revisions.reload()}>
            Try again
          </button>
        </p>
      ) : !history ? (
        <div className="rail-empty">
          <Skeleton lines={3} />
        </div>
      ) : !sorted.length ? (
        <p className="rail-empty">Nothing is recorded yet.</p>
      ) : (
        <>
          <button
            type="button"
            className="rev-follow"
            aria-pressed={following}
            onClick={() => revisions.choose(LATEST_WORK)}
          >
            <span>Latest work</span>
            <small>
              {following ? 'Following the newest draft or the baseline' : 'Go back to following'}
            </small>
          </button>
          <ol ref={list} aria-label="Recorded revisions" onKeyDown={onKeyDown}>
            {shown.map((r, i) => {
              const role = revisionRole(r, history, revisions.baselineId);
              const current = r.id === displayedId;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    className={`rev-row ${role === 'baseline' ? 'baseline' : ''}`}
                    aria-current={current ? 'true' : undefined}
                    // One tab stop for the list; arrow keys walk it.
                    tabIndex={current || (!displayedId && i === 0) ? 0 : -1}
                    onClick={() => revisions.choose(pickOf(r))}
                  >
                    <span className="history-seq">r{r.seq}</span>
                    <span className="history-copy">
                      <span>
                        {role === 'baseline' ? 'Baseline' : stateLabel(r.reviewState)}
                        {role === 'history' && r.reviewState === 'draft'
                          ? ' on an older baseline'
                          : ''}
                        <span className="dim"> · {r.origin}</span>
                        {current && <span className="rev-shown"> · Shown</span>}
                      </span>
                      <small>
                        <time dateTime={r.createdAt}>{relativeTime(r.createdAt)}</time>
                      </small>
                      {r.rationale && <span className="rev-rationale">{r.rationale}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          {sorted.length > VISIBLE && (
            <button type="button" className="rail-action" onClick={() => setAll((v) => !v)}>
              {all ? 'Show the newest 12' : `Show all ${sorted.length}`}
            </button>
          )}
          {revisions.error && (
            <p className="rail-empty">
              This list could not be refreshed: {revisions.error}{' '}
              <button type="button" className="link" onClick={() => void revisions.reload()}>
                Try again
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}
