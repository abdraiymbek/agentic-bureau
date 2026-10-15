import React, { useMemo } from 'react';
import type { ArtifactView, MaybeQuantity } from '@omenflow/contracts';
import { isUnknown } from '@omenflow/contracts/format';
import { recordedQuantityText } from '../../lib/diff';
import { errMsg } from '../../api';
import { useStore } from '../../store';
import { Button, Notice, TypeGlyph, shortId } from '../../ui/kit';
import { linkDestination, safeMarkdown, safeSvg } from '../../lib/markdown';
import type { FormShape, UnderneathChange } from '../../lib/revision-draft';
import type { RevisionDraft } from '../useRevisionDraft';

export interface StageProps {
  /** The object, carrying the revision that is on screen. */
  view: ArtifactView;
}

export function qty(q: MaybeQuantity | null | undefined) {
  if (q == null) return <span className="unknown">Not set</span>;
  if (isUnknown(q))
    return <span className="unknown">Unknown{'reason' in q ? ` — ${q.reason}` : ''}</span>;
  return recordedQuantityText(q);
}

/** Navigation from a stage. The store asks before it discards an unsaved edit. */
export function useNavigate() {
  return useMemo(
    () => ({
      focus: (id: string) => useStore.getState().focus(id),
      decide: (proposalId: string | null) => useStore.getState().decide(proposalId),
    }),
    [],
  );
}

/** A link to another object by its title, falling back to its short id. */
export function ObjectLink({
  id,
  fallback,
  glyph,
  className = 'cell-link',
  children,
}: {
  id: string;
  fallback?: string;
  glyph?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const target = useStore((s) => s.artifacts.find((v) => v.artifact.id === id));
  const { focus } = useNavigate();
  return (
    <button type="button" className={className} onClick={() => focus(id)}>
      {glyph && target && <TypeGlyph type={target.artifact.type} size={13} />}
      {target?.artifact.title ?? fallback ?? shortId(id)}
      {children}
    </button>
  );
}

/** Opens a clicked link in the system browser; the webview itself never follows it. */
function openContainedLink(event: React.MouseEvent<HTMLElement>) {
  const anchor = (event.target as Element).closest?.('a');
  if (!anchor) return;
  event.preventDefault();
  const url = linkDestination(anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href'));
  if (!url) return;
  void window.omenflow
    .openExternal(url)
    .catch((error) => useStore.getState().toast('error', errMsg(error)));
}

/** Recorded markdown, sanitised. Links leave through the system browser only. */
export function Prose({ markdown }: { markdown: string }) {
  const html = useMemo(() => safeMarkdown(markdown), [markdown]);
  return (
    <div
      className="prose"
      onClick={openContainedLink}
      onAuxClick={openContainedLink}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** A recorded or derived SVG, sanitised, with any links in it kept from navigating. */
export function SvgDiagram({
  svg,
  className = '',
  framed = true,
}: {
  svg: string;
  className?: string;
  /** Draw the island around it. A viewer that frames the drawing itself turns this off. */
  framed?: boolean;
}) {
  const html = useMemo(() => safeSvg(svg), [svg]);
  return (
    <div
      className={`${framed ? 'diagram island' : 'diagram-art'} ${className}`}
      onClick={openContainedLink}
      onAuxClick={openContainedLink}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export type FieldLabels<F extends FormShape> = {
  [K in keyof F & string]: {
    label: string;
    /** How a value of this field reads; `form` is the whole form that value belongs to. */
    show?: (value: F[K], form: F) => string;
  };
};

function plain(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'not set';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const text = String(value);
  return text.length > 72 ? `${text.length} characters` : text;
}

/** The sentence a human edit is recorded under: which fields it touched. */
export function editRationale<F extends FormShape>(
  what: string,
  edited: (keyof F & string)[],
  labels: FieldLabels<F>,
): string {
  const names = edited.map((k) => labels[k].label.toLowerCase());
  return names.length ? `Edit ${what}: ${names.join(', ')}` : `Edit ${what}`;
}

/** What changed underneath unsaved edits, with the choice that settles it. */
export function UnderneathNotice<F extends FormShape>({
  draft,
  labels,
}: {
  draft: RevisionDraft<F>;
  labels: FieldLabels<F>;
}) {
  const incoming = draft.incoming;
  if (!incoming) return null;
  const show = (change: UnderneathChange, value: unknown, form: F) => {
    const field = labels[change.field as keyof F & string];
    return field?.show ? field.show(value as never, form) : plain(value);
  };
  const name = incoming.revision ? `r${incoming.revision.seq}` : 'a newer revision';
  const from = draft.base ? `r${draft.base.seq}` : 'the revision you started from';
  const contested = incoming.changes.filter((c) => c.contested);
  return (
    <Notice tone="warn" role="alert">
      <div className="underneath">
        <p>
          <strong>The record moved to {name} while you were editing.</strong> Your edits are kept
          and still based on {from}. Nothing is saved until you choose.
        </p>
        {incoming.changes.length ? (
          <ul className="underneath-changes">
            {incoming.changes.map((change) => (
              <li key={change.field}>
                <span className="underneath-field">
                  {labels[change.field as keyof F & string]?.label ?? change.field}
                </span>
                <span className="num">
                  {show(change, change.was, incoming.was)} →{' '}
                  {show(change, change.now, incoming.now)}
                </span>
                {change.contested ? (
                  <span className="tone-warn-text">
                    You entered {show(change, change.mine, draft.form)}; keeping your edits replaces{' '}
                    {show(change, change.now, incoming.now)}.
                  </span>
                ) : change.mine !== undefined ? (
                  <span className="dim">Matches what you entered.</span>
                ) : (
                  <span className="dim">Not touched by your edits.</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="dim">The fields on this form read the same in {name}.</p>
        )}
        <div className="underneath-actions">
          <Button size="sm" variant="primary" disabled={draft.busy} onClick={draft.keepEdits}>
            Keep my edits on {name}
          </Button>
          <Button size="sm" variant="ghost" disabled={draft.busy} onClick={draft.discard}>
            Discard my edits and show {name}
          </Button>
          {contested.length > 0 && (
            <span className="dim">
              {contested.length} {contested.length === 1 ? 'field differs' : 'fields differ'}{' '}
              between your edits and {name}.
            </span>
          )}
        </div>
      </div>
    </Notice>
  );
}

/**
 * The bar where an edit becomes a revision. Quiet until something changed; then it says what
 * saving will record, and it is the only place a save or a discard happens.
 */
export function SaveBar<F extends FormShape>({
  draft,
  saveLabel,
  consequence,
  onSave,
  extra,
}: {
  draft: RevisionDraft<F>;
  saveLabel: string;
  /** What a save records, as a sentence. Shown while there are unsaved changes. */
  consequence: string;
  onSave: () => void;
  extra?: React.ReactNode;
}) {
  const count = draft.dirtyFields.length;
  return (
    <div className={`save-bar ${draft.dirty ? 'dirty' : ''}`} data-toast-avoid>
      <div className="save-bar-copy">
        <span className="save-bar-state">
          {draft.dirty
            ? `Unsaved changes · ${count} ${count === 1 ? 'field' : 'fields'}`
            : (draft.lock ?? 'Recorded in this revision')}
        </span>
        {draft.dirty && !draft.error && (
          <span className="save-bar-note">
            {draft.incoming
              ? 'Choose what to do about the newer revision before saving.'
              : consequence}
          </span>
        )}
        {draft.restored && !draft.error && (
          <span className="save-bar-note">
            These edits were left unsaved earlier and have been brought back.
          </span>
        )}
        {draft.error && (
          <span className="save-bar-error" role="alert">
            {draft.error}
          </span>
        )}
      </div>
      <span className="grow" />
      {extra}
      {draft.dirty && (
        <Button size="sm" variant="ghost" disabled={draft.busy} onClick={draft.discard}>
          Discard
        </Button>
      )}
      <Button
        size="sm"
        variant="primary"
        busy={draft.busy}
        disabled={!draft.dirty || !!draft.incoming}
        onClick={onSave}
      >
        {saveLabel}
      </Button>
    </div>
  );
}

/** Numbered steps: a test procedure or a build sequence. */
export function Steps({
  steps,
}: {
  steps: { n: number; key: React.Key; body: React.ReactNode }[];
}) {
  return (
    <ol className="steps">
      {steps.map((s) => (
        <li key={s.key}>
          <span className="step-n num">{s.n}</span>
          <div>{s.body}</div>
        </li>
      ))}
    </ol>
  );
}
