import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight } from '@phosphor-icons/react';
import { useStore } from '../store';
import { Disclosure, Notice, State, TypeGlyph, shortId, typeMeta } from '../ui/kit';
import { diffPayload } from '../lib/diff';
import { changeBaseMoved, isCarrier, type ChangeDetail } from './model';
import type { ReviewNotes } from './memory';
import { quietCmd } from './io';
import { CadReview, type ReviewStatus } from './CadReview';
import { ArtifactContent } from './ArtifactContent';
import { FileChanges } from './FileChanges';
import { PayloadDiff } from './PayloadDiff';
import { RefTitle } from './parts';

const KIND: Record<string, string> = {
  baseline_update: 'Baseline update',
  new_artifact: 'New object',
  component_selection: 'Component selection',
  bom_edit: 'Bill of materials edit',
  archive: 'Archive',
};

const ORIGIN: Record<string, string> = { agent: 'the agent', user: 'you', system: 'the system' };

const RELATION: Record<string, string> = {
  depends_on: 'depends on',
  derived_from: 'derived from',
  validates: 'validates',
  connects_to: 'connects to',
  belongs_to: 'belongs to',
  alternative_to: 'alternative to',
};

/** Lines a change removes from the bill of materials, named from the current bill. */
function useRemovedLines(projectId: string | null, ids: string[] | undefined) {
  const [names, setNames] = useState<Record<string, string>>({});
  const key = ids?.join(',') ?? '';
  useEffect(() => {
    if (!key || !projectId) return;
    let cancelled = false;
    quietCmd<{
      lines?: {
        line?: { id?: string; quantity?: number };
        id?: string;
        quantity?: number;
        componentTitle?: string;
      }[];
    }>('bom.read', {}, { projectId })
      .then((r) => {
        if (cancelled) return;
        const out: Record<string, string> = {};
        for (const l of r.lines ?? []) {
          const id = l.line?.id ?? l.id;
          const quantity = l.line?.quantity ?? l.quantity;
          if (id && l.componentTitle)
            out[id] =
              quantity !== undefined ? `${quantity} × ${l.componentTitle}` : l.componentTitle;
        }
        setNames(out);
      })
      .catch(() => !cancelled && setNames({}));
    return () => {
      cancelled = true;
    };
  }, [projectId, key]);
  return names;
}

function Inputs({ item }: { item: ChangeDetail }) {
  const artifacts = useStore((s) => s.artifacts);
  const inputs = item.next?.inputs ?? [];
  if (!inputs.length) return null;
  return (
    <section className="change-inputs">
      <h4>Recorded inputs</h4>
      <ul>
        {inputs.map((input, i) => {
          const view = artifacts.find((a) => a.artifact.id === input.artifactId);
          const pin = !view
            ? 'not in the current list'
            : view.artifact.selectedRevisionId === input.revisionId
              ? 'the current baseline'
              : view.revision
                ? `an earlier revision (baseline is now r${view.revision.seq})`
                : 'a revision that is not the baseline';
          return (
            <li key={i}>
              <span className="dim">{RELATION[input.relationship] ?? input.relationship}</span>{' '}
              <RefTitle id={input.artifactId} />
              <span className="dim"> · pinned to {pin}</span>
              {input.label && <span className="dim"> · {input.label}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** One change of a proposal: what it does to which object, shown in full. */
export function ChangeSection({
  index,
  total,
  item,
  projectId,
  open,
  notes,
  onToggle,
  onScope,
  canDecide,
  onStatus,
  sectionRef,
}: {
  index: number;
  total: number;
  item: ChangeDetail;
  projectId: string | null;
  /** The proposal is still open for a decision. */
  open: boolean;
  notes: ReviewNotes;
  onToggle: (key: string) => void;
  onScope: (artifactId: string, evidenceHash: string | null) => void;
  canDecide: boolean;
  onStatus: (revisionId: string, status: ReviewStatus) => void;
  sectionRef: (el: HTMLElement | null) => void;
}) {
  const { change, artifact, base, next, verification } = item;
  const focus = useStore((s) => s.focus);
  const current = useStore((s) => s.artifacts.find((a) => a.artifact.id === change.artifactId));
  const removed = useRemovedLines(projectId, change.removeBomLineIds);
  const moved = open && changeBaseMoved(item);
  const title = artifact?.title ?? `Object ${shortId(change.artifactId)}`;
  const k = (key: string) => `${index}:${key}`;
  const toggle = (key: string) => onToggle(k(key));
  const entries = useMemo(
    () => (base && next ? diffPayload(base.payload, next.payload) : []),
    [base, next],
  );
  const opened = Object.fromEntries(
    Object.entries(notes.open)
      .filter(([key]) => key.startsWith(`${index}:`))
      .map(([key, v]) => [key.slice(String(index).length + 1), v]),
  );

  let body: React.ReactNode;
  if (change.kind === 'archive')
    body = (
      <p className="change-note">
        Archiving keeps the history of {title}. It leaves the flow map, the lists and the bill of
        materials.
      </p>
    );
  else if (!next)
    body = (
      <Notice tone="err" role="alert">
        The proposed revision {shortId(change.newRevisionId)} is missing from the record.
      </Notice>
    );
  else if (artifact?.type === 'mechanical')
    body = (
      <CadReview
        projectId={projectId}
        base={base}
        next={next}
        verification={verification}
        accepted={
          !!verification?.evidenceHash &&
          notes.scopes[change.artifactId] === verification.evidenceHash
        }
        onAcceptScope={(accepted) =>
          onScope(change.artifactId, accepted ? (verification?.evidenceHash ?? null) : null)
        }
        canDecide={canDecide}
        open={opened}
        onToggle={toggle}
        onStatus={(status) => onStatus(next.id, status)}
      />
    );
  else if (!base)
    body = <ArtifactContent type={artifact?.type ?? 'object'} payload={next.payload} />;
  else
    body = (
      <>
        <PayloadDiff entries={entries} empty="No field changes in the recorded content." />
        <Disclosure
          label="Complete proposed content"
          meta={`r${next.seq}`}
          open={!!opened.content}
          onToggle={() => toggle('content')}
        >
          <ArtifactContent type={artifact?.type ?? 'object'} payload={next.payload} />
        </Disclosure>
      </>
    );

  return (
    <section
      ref={sectionRef}
      className={`change ${moved ? 'is-moved' : ''}`}
      tabIndex={-1}
      data-change={index}
      aria-label={`Change ${index + 1} of ${total}: ${title}`}
    >
      <header className="change-head">
        <button
          type="button"
          className="change-object"
          disabled={!artifact}
          onClick={() => artifact && focus(artifact.id)}
        >
          {artifact && <TypeGlyph type={artifact.type} size={14} />}
          {title}
          <ArrowRight size={12} />
        </button>
        <span className="change-kind">
          {artifact ? `${typeMeta(artifact.type).label} · ` : ''}
          {KIND[change.kind] ?? change.kind.replaceAll('_', ' ')}
        </span>
        {moved && <State state="stale" tone="warn" label="Base moved" />}
        <span className="grow" />
        <span className="change-revs num">
          {isCarrier(item) && base
            ? `r${base.seq} stays the baseline`
            : `${base ? `r${base.seq}` : 'new'} → r${next?.seq ?? '?'}`}
        </span>
      </header>
      {moved && (
        <Notice tone="warn">
          This change was prepared on {base ? `r${base.seq}` : 'no baseline'}, but the baseline of{' '}
          {title} is now {current?.revision ? `r${current.revision.seq}` : 'a newer revision'}.
          Approving it would overwrite that newer work.
        </Notice>
      )}
      {body}
      {change.replacesArtifactId && (
        <p className="change-note">
          Replaces <RefTitle id={change.replacesArtifactId} />, which approval archives.
        </p>
      )}
      {!!change.bomLines?.length && (
        <section className="change-bom">
          <h4>Adds to the bill of materials</h4>
          <ul>
            {change.bomLines.map((l, j) => (
              <li key={j}>
                <span className="review-qty">{l.quantity} ×</span>{' '}
                <RefTitle id={l.componentArtifactId} />
                <span className="dim">
                  {l.subsystem ? ` · ${l.subsystem}` : ''}
                  {l.location ? ` · ${l.location}` : ''}
                  {l.offerId ? ' · offer chosen' : ' · no offer chosen'}
                  {l.notes ? ` · ${l.notes}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!change.removeBomLineIds?.length && (
        <section className="change-bom">
          <h4>Removes from the bill of materials</h4>
          <ul>
            {change.removeBomLineIds.map((id) => (
              <li key={id}>{removed[id] ?? <span className="mono">line {shortId(id)}</span>}</li>
            ))}
          </ul>
        </section>
      )}
      {next?.rationale?.trim() && (
        <p className="change-note">
          Note recorded with r{next.seq} by {ORIGIN[next.origin] ?? next.origin}: “{next.rationale}”
        </p>
      )}
      <Inputs item={item} />
      {next && (
        <FileChanges
          projectId={projectId}
          base={base}
          next={next}
          skip={artifact?.type === 'mechanical' ? (p) => /\.(stl|scad)$/i.test(p) : undefined}
          open={opened}
          onToggle={toggle}
        />
      )}
    </section>
  );
}
