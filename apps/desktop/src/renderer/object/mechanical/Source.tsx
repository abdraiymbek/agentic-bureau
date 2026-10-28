import React, { useState } from 'react';
import type { ArtifactView, Revision } from '@bureau/contracts';
import { cmd, errMsg } from '../../api';
import { useStore } from '../../store';
import { Button, Disclosure, Notice, Skeleton } from '../../ui/kit';
import { renderOutcome, type CadWriteResult, type RenderOutcome } from '../../lib/render-jobs';
import { useRevisionDraft } from '../useRevisionDraft';
import { SaveBar, UnderneathNotice, type FieldLabels } from '../stages/shared';
import type { CadSource, Loaded } from './useCad';

type SourceForm = { source: string };

const lines = (text: string) => `${text ? text.split('\n').length : 0} lines`;
const LABELS: FieldLabels<SourceForm> = { source: { label: 'Source', show: lines } };

type Validation = { revisionId: string; ok: boolean; errors: string[] } | null;

/**
 * The OpenSCAD source of the revision on screen. Saving an edit renders it as a new draft
 * candidate; the recorded revision itself is never rewritten.
 */
export function Source({
  view,
  sources,
  onOutcome,
  blocked,
}: {
  view: ArtifactView;
  sources: Record<string, Loaded<CadSource>>;
  onOutcome: (outcome: RenderOutcome) => void;
  /** Why the source cannot be edited right now, when another editor holds the part. */
  blocked: string | null;
}) {
  const projectId = useStore((s) => s.projectId);
  const readOnly = useStore((s) => s.readOnly);
  const toast = useStore((s) => s.toast);
  const rev = view.revision;
  const scad = rev?.files.find((f) => f.path.toLowerCase().endsWith('.scad'));
  const loaded = rev ? sources[rev.id] : undefined;
  const [open, setOpen] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<Validation>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const draft = useRevisionDraft<SourceForm>({
    view,
    slot: 'source',
    label: `source of “${view.artifact.title}”`,
    anchor: 'newest',
    empty: { source: '' },
    toForm: (revision: Revision | null) => {
      const source = revision ? sources[revision.id] : undefined;
      return source?.status === 'ready' ? { source: source.value.text } : null;
    },
    baseVersion: Object.entries(sources)
      .map(([id, s]) => `${id}:${s.status}`)
      .join(' '),
    check: (form) => (form.source.trim() ? null : 'The source is empty.'),
    save: async (form, base) => {
      const recorded = sources[base.id];
      if (recorded?.status !== 'ready')
        throw new Error('The source of this revision has not been read, so it cannot be revised.');
      const result = await cmd<CadWriteResult>('cad.write_source', {
        artifactId: view.artifact.id,
        expectedRevisionId: base.id,
        source: form.source,
        params: recorded.value.recordedParams,
        rationale: `Revise the source of revision ${base.seq}`,
      });
      onOutcome(renderOutcome(result));
      return result.revisionId;
    },
  });

  if (!rev || !scad) return null;
  const ready = loaded?.status === 'ready';
  const save = async () => {
    const id = await draft.save();
    if (id) toast('info', 'A new draft candidate was recorded. Its render result is shown above.');
  };
  const validate = async () => {
    if (!projectId) return;
    setValidating(true);
    setValidationError(null);
    try {
      const r = await cmd<{ ok: boolean; errors: string[] }>(
        'cad.validate_source',
        { artifactId: view.artifact.id, revisionId: rev.id },
        { projectId },
      );
      setValidation({ revisionId: rev.id, ok: r.ok, errors: r.errors ?? [] });
    } catch (e) {
      setValidationError(errMsg(e));
    } finally {
      setValidating(false);
    }
  };
  const checked = validation?.revisionId === rev.id ? validation : null;
  const overrides = ready ? Object.keys(loaded.value.recordedParams).length : 0;

  return (
    <>
      <Disclosure
        label="OpenSCAD source"
        meta={<span className="mono">{scad.path}</span>}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        actions={
          <Button
            size="sm"
            busy={validating}
            disabled={!ready || draft.dirty || readOnly}
            onClick={() => void validate()}
          >
            Check saved source
          </Button>
        }
      >
        <UnderneathNotice draft={draft} labels={LABELS} />
        {loaded?.status === 'failed' ? (
          <Notice
            tone="err"
            role="alert"
            action={
              <Button size="sm" onClick={loaded.retry}>
                Try again
              </Button>
            }
          >
            The source of r{rev.seq} could not be read: {loaded.error}
          </Notice>
        ) : !ready ? (
          <Skeleton lines={4} />
        ) : (
          <textarea
            aria-label={`OpenSCAD source of revision ${rev.seq}`}
            className="code-editor"
            spellCheck={false}
            rows={18}
            readOnly={!draft.canEdit || !!blocked}
            disabled={draft.busy}
            value={draft.form.source}
            onChange={(e) => draft.edit({ source: e.target.value })}
          />
        )}
        {validationError && (
          <Notice tone="err" role="alert">
            The check did not run: {validationError}
          </Notice>
        )}
        {checked && (
          <Notice tone={checked.ok ? 'ok' : 'err'} role="status">
            {checked.ok ? (
              <>The saved source of r{rev.seq} parses in OpenSCAD. That is syntax only.</>
            ) : (
              <>
                <strong>The saved source of r{rev.seq} does not parse.</strong>
                {checked.errors.length > 0 && (
                  <pre className="render-log">{checked.errors.join('\n')}</pre>
                )}
              </>
            )}
          </Notice>
        )}
        <p className="footnote">
          {blocked ??
            draft.lock ??
            (overrides
              ? `Saving renders a new draft candidate and keeps the ${overrides} recorded parameter ${overrides === 1 ? 'override' : 'overrides'}.`
              : 'Saving renders a new draft candidate. The baseline stays as it is.')}
        </p>
      </Disclosure>
      {(draft.dirty || draft.error) && (
        <SaveBar
          draft={draft}
          saveLabel="Render candidate"
          consequence="Rendering records a new draft candidate from this source. The baseline does not change until you accept it."
          onSave={() => void save()}
        />
      )}
    </>
  );
}
