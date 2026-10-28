import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, MagnifyingGlass, Sparkle, X } from '../ui/icons';
import type { CoverageEvidence, CoverageReport, CoverageRequirement } from '@bureau/contracts';
import { errMsg } from '../api';
import { useStore } from '../store';
import { useViewState } from '../lib/view-memory';
import {
  Button,
  Empty,
  IconButton,
  Segmented,
  Skeleton,
  State,
  TypeGlyph,
  typeMeta,
} from '../ui/kit';
import { askAgent } from '../lib/actions';
import {
  COVERAGE_LABEL,
  COVERAGE_TONE,
  EVIDENCE_STATE_LABEL,
  EVIDENCE_STATE_TONE,
  PRIORITY_LABEL,
  RELATION_LABEL,
  REVIEW_STATE,
  coverageSentence,
  filterCounts,
  filterRequirements,
  gapPrompt,
  targetView,
  verdictOf,
  type CoverageFilter,
} from './evidence';
import { optionalCommand } from './optional-op';
import { useRowNav, type RowProps } from './row-nav';

export type CoverageState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }
  | { status: 'ready'; report: CoverageReport };

/** Coalesces the artifact and link refreshes one project event triggers. */
const REFRESH_DELAY_MS = 200;

/** The requirement → evidence traceability matrix, read from `project.coverage`. */
export default function EvidenceLens() {
  const projectId = useStore((s) => s.projectId);
  const artifacts = useStore((s) => s.artifacts);
  const edges = useStore((s) => s.edges);
  const [state, setState] = useState<CoverageState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // Artifacts and links are reloaded by the store whenever a revision, baseline, link or
  // decision event arrives; coverage follows them.
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void optionalCommand<CoverageReport>('project.coverage', {}, { projectId }).then((r) => {
        if (!active) return;
        if (r.status === 'ok') setState({ status: 'ready', report: r.value });
        else if (r.status === 'unavailable') setState({ status: 'unavailable' });
        else setState({ status: 'error', message: errMsg(r.error) });
      });
    }, REFRESH_DELAY_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [projectId, artifacts, edges, attempt]);

  return (
    <EvidenceView
      state={state}
      onRetry={() => {
        setState({ status: 'loading' });
        setAttempt((n) => n + 1);
      }}
    />
  );
}

export function EvidenceView({ state, onRetry }: { state: CoverageState; onRetry: () => void }) {
  const go = useStore((s) => s.go);
  if (state.status === 'loading')
    return (
      <div className="lens-page" aria-busy="true">
        <Skeleton lines={5} width="100%" />
      </div>
    );
  if (state.status === 'unavailable')
    return (
      <div className="lens-page">
        <Empty
          title="Coverage is not available in this build"
          body="The workspace service here does not answer project.coverage, so requirement coverage is not shown. Nothing is estimated in its place."
        />
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="lens-page">
        <Empty
          title="Coverage didn’t load"
          body={state.message}
          action={<Button onClick={onRetry}>Try again</Button>}
        />
      </div>
    );
  if (!state.report.requirements.length)
    return (
      <div className="lens-page">
        <Empty
          title="No requirements yet"
          body="Coverage starts with what the project must do. Each requirement appears here with the calculations and tests that check it."
          action={
            <Button onClick={() => go({ level: 'project', lens: 'flow' })}>Open the flow</Button>
          }
        />
      </div>
    );
  return <CoverageMatrix report={state.report} />;
}

function CoverageMatrix({ report }: { report: CoverageReport }) {
  const focus = useStore((s) => s.focus);
  const readOnly = useStore((s) => s.readOnly);
  const [filter, setFilter] = useViewState<CoverageFilter>('evidence:filter', 'all');
  const [query, setQuery] = useViewState('evidence:query', '');
  const [prompt, setPrompt] = useState<string | null>(null);
  const counts = useMemo(() => filterCounts(report.requirements), [report]);
  const rows = useMemo(
    () => filterRequirements(report.requirements, filter, query),
    [report, filter, query],
  );
  const gaps = rows.filter((r) => r.coverage !== 'covered');
  const rowProps = useRowNav(rows.map((r) => r.artifactId));

  return (
    <div className="lens-page">
      <div className="lens-bar">
        <Segmented
          label="Show requirements"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'gaps', label: 'Gaps', count: counts.gaps },
            { value: 'stale', label: 'Out of date', count: counts.stale },
            { value: 'none', label: 'No evidence', count: counts.none },
          ]}
        />
        <label className="find">
          <MagnifyingGlass size={13} />
          <input
            aria-label="Filter requirements"
            placeholder="Filter requirements"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="grow" />
        <Button
          size="sm"
          icon={<Sparkle size={13} />}
          disabled={!gaps.length || readOnly}
          aria-expanded={prompt !== null}
          onClick={() => setPrompt(prompt === null ? gapPrompt(gaps) : null)}
        >
          {gaps.length
            ? `Ask agent to close ${gaps.length} ${gaps.length === 1 ? 'gap' : 'gaps'}`
            : 'No gaps in view'}
        </Button>
      </div>

      <p className="evidence-summary" role="status">
        {coverageSentence(report.totals)}
      </p>

      {prompt !== null && (
        <section className="evidence-ask island" aria-label="Prompt for the agent">
          <header>
            <h3>Prompt for the agent</h3>
            <IconButton size="sm" label="Close the prompt" onClick={() => setPrompt(null)}>
              <X size={12} />
            </IconButton>
          </header>
          <textarea
            aria-label="Prompt for the agent"
            value={prompt}
            rows={8}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <footer>
            <span className="footnote">
              Typed into the agent terminal once it is ready, not sent. Review it there and press
              Enter.
            </span>
            <Button
              size="sm"
              variant="primary"
              disabled={!prompt.trim()}
              trailing={<ArrowRight size={13} />}
              onClick={() => {
                askAgent(prompt);
                setPrompt(null);
              }}
            >
              Type into agent
            </Button>
          </footer>
        </section>
      )}

      {!rows.length ? (
        <p className="lens-muted">
          {query
            ? `No requirement matches “${query}”.`
            : filter === 'gaps'
              ? 'No gaps: every requirement has current evidence.'
              : 'No requirement is in this state.'}
        </p>
      ) : (
        <div className="lens-table">
          <table className="table evidence-table" data-rows="">
            <thead>
              <tr>
                <th scope="col">Requirement</th>
                <th scope="col" className="num">
                  Target
                </th>
                <th scope="col">Coverage</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <RequirementRow
                  key={r.artifactId}
                  requirement={r}
                  onOpen={focus}
                  rowProps={rowProps(r.artifactId, () => focus(r.artifactId))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="footnote">
        A verdict appears only where a test recorded one. Approval is not validation, and a result
        is never compared with its target here.
      </p>
    </div>
  );
}

function RequirementRow({
  requirement: r,
  onOpen,
  rowProps,
}: {
  requirement: CoverageRequirement;
  onOpen: (id: string) => void;
  rowProps: RowProps;
}) {
  const target = targetView(r.target);
  return (
    <tr {...rowProps} className="lens-row" aria-label={`${r.title}, ${COVERAGE_LABEL[r.coverage]}`}>
      <td className="evidence-req">
        <button
          type="button"
          className="cell-link"
          tabIndex={-1}
          onClick={() => onOpen(r.artifactId)}
        >
          <TypeGlyph type="requirement" size={13} />
          {r.title}
        </button>
        {r.statement && <p className="evidence-statement">{r.statement}</p>}
        <span className="evidence-meta">
          {PRIORITY_LABEL[r.priority]}
          <State state={REVIEW_STATE[r.review]} quiet />
        </span>
      </td>
      <td className="num evidence-target">
        {target.kind === 'value' ? (
          <span className="mono">{target.text}</span>
        ) : target.kind === 'unknown' ? (
          <span className="unknown">
            Unknown
            {target.reason && <small>{target.reason}</small>}
          </span>
        ) : (
          <span className="dim">No quantitative target</span>
        )}
      </td>
      <td className="evidence-coverage">
        <State
          state={r.coverage}
          label={COVERAGE_LABEL[r.coverage]}
          tone={COVERAGE_TONE[r.coverage]}
        />
        {r.reason && <small>{r.reason}</small>}
      </td>
      <td>
        {r.evidence.length ? (
          <ul className="evidence-chips">
            {r.evidence.map((e) => (
              <li key={`${e.artifactId}:${e.relation}`}>
                <EvidenceChip evidence={e} onOpen={() => onOpen(e.artifactId)} />
              </li>
            ))}
          </ul>
        ) : (
          <span className="unknown">Nothing linked</span>
        )}
      </td>
    </tr>
  );
}

function EvidenceChip({ evidence: e, onOpen }: { evidence: CoverageEvidence; onOpen: () => void }) {
  const verdict = verdictOf(e);
  const state = EVIDENCE_STATE_LABEL[e.state];
  const label = [
    `${typeMeta(e.type).label} ${e.title}`,
    `${RELATION_LABEL[e.relation]} this requirement`,
    state,
    e.result && `result ${e.result}`,
    verdict && `recorded verdict ${verdict}`,
    e.evidenceKind && `evidence ${e.evidenceKind}`,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <button type="button" className="evidence-chip" aria-label={label} onClick={onOpen}>
      <TypeGlyph type={e.type} size={13} />
      <span className="evidence-chip-title truncate">{e.title}</span>
      <span className={`evidence-chip-state tone-${EVIDENCE_STATE_TONE[e.state]}`}>{state}</span>
      {e.result && <span className="evidence-chip-result mono">{e.result}</span>}
      {verdict && (
        <span className={`evidence-chip-verdict tone-${verdict === 'Pass' ? 'ok' : 'err'}`}>
          {verdict}
        </span>
      )}
    </button>
  );
}
