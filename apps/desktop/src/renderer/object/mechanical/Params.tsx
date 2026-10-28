import React from 'react';
import type { ArtifactView, MechanicalPayload, Revision } from '@bureau/contracts';
import { cmd } from '../../api';
import { useStore } from '../../store';
import { Block, Skeleton, State, Tooltip } from '../../ui/kit';
import {
  parameterForm,
  parameterOverrides,
  parameterRows,
  parameterText,
  type ParameterForm,
  type ParameterRow,
} from '../../lib/scad-params';
import { renderOutcome, type CadWriteResult, type RenderOutcome } from '../../lib/render-jobs';
import { useRevisionDraft } from '../useRevisionDraft';
import { SaveBar, UnderneathNotice, type FieldLabels } from '../stages/shared';
import type { CadSource, Loaded } from './useCad';

const UNIT_ORIGIN: Record<NonNullable<ParameterRow['unitSource']>, string> = {
  recorded: 'Unit recorded with the value',
  manifest: 'Unit declared for this parameter',
  'source-comment': 'Unit as written in the source comment',
};

/**
 * Every parameter the source declares, with the value this revision renders with. Changing
 * one renders a new draft candidate; the baseline and its mesh are never altered in place.
 */
export function Params({
  view,
  sources,
  onOutcome,
  blocked,
}: {
  view: ArtifactView;
  sources: Record<string, Loaded<CadSource>>;
  onOutcome: (outcome: RenderOutcome) => void;
  /** Why parameters cannot be edited right now, when another editor holds the part. */
  blocked: string | null;
}) {
  const toast = useStore((s) => s.toast);
  const rev = view.revision;
  const hasSource = !!rev?.files.some((f) => f.path.toLowerCase().endsWith('.scad'));
  const loaded = rev ? sources[rev.id] : undefined;
  const rowsOf = (revision: Revision | null): ParameterRow[] | null => {
    if (!revision) return [];
    const payload = (revision.payload ?? {}) as Partial<MechanicalPayload>;
    const source = sources[revision.id];
    const scad = revision.files.some((f) => f.path.toLowerCase().endsWith('.scad'));
    if (scad && source?.status !== 'ready' && source?.status !== 'failed') return null;
    return parameterRows(
      source?.status === 'ready' ? source.value.text : null,
      payload.params ?? {},
      payload.paramManifest ?? [],
    );
  };
  const rows = rowsOf(rev) ?? [];
  const draft = useRevisionDraft<ParameterForm>({
    view,
    slot: 'params',
    label: `parameters of “${view.artifact.title}”`,
    anchor: 'newest',
    empty: {},
    toForm: (revision) => {
      const known = rowsOf(revision);
      return known ? parameterForm(known) : null;
    },
    baseVersion: Object.entries(sources)
      .map(([id, s]) => `${id}:${s.status}`)
      .join(' '),
    check: (form) => {
      const edit = parameterOverrides(rows, form);
      return edit.ok ? null : edit.message;
    },
    save: async (form, base, edited) => {
      const source = sources[base.id];
      const known = rowsOf(base);
      const edit = known ? parameterOverrides(known, form) : null;
      if (source?.status !== 'ready' || !edit?.ok)
        throw new Error('The source of this revision has not been read, so it cannot be rendered.');
      const result = await cmd<CadWriteResult>('cad.write_source', {
        artifactId: view.artifact.id,
        expectedRevisionId: base.id,
        source: source.value.text,
        params: edit.params,
        rationale: `Set parameters: ${edited.join(', ')}`,
      });
      onOutcome(renderOutcome(result));
      return result.revisionId;
    },
  });
  const labels = Object.fromEntries(
    Object.keys(draft.form).map((name) => [name, { label: name }]),
  ) as FieldLabels<ParameterForm>;

  if (!rev) return null;
  const overridden = rows.filter((r) => r.overridden).length;
  const save = async () => {
    const id = await draft.save();
    if (id) toast('info', 'A new draft candidate was recorded. Its render result is shown above.');
  };

  return (
    <Block
      title="Parameters"
      count={
        hasSource && loaded?.status !== 'ready' && loaded?.status !== 'failed'
          ? undefined
          : rows.length
      }
    >
      <UnderneathNotice draft={draft} labels={labels} />
      {hasSource && (!loaded || loaded.status === 'loading') ? (
        <Skeleton lines={3} />
      ) : !rows.length ? (
        <p className="dim">
          {hasSource
            ? 'The source declares no file-scope parameters, and none are recorded.'
            : 'This revision has no OpenSCAD source, and no parameters are recorded.'}
        </p>
      ) : (
        <fieldset disabled={!draft.canEdit || draft.busy || !!blocked} className="bare">
          <div className="params">
            {rows.map((row) => (
              <ParamCell
                key={row.name}
                row={row}
                text={draft.form[row.name] ?? parameterText(row.value)}
                edited={draft.changed(row.name)}
                onChange={(text) => draft.edit({ [row.name]: text })}
              />
            ))}
          </div>
        </fieldset>
      )}
      {loaded?.status === 'failed' && (
        <p className="footnote tone-warn-text">
          The source could not be read ({loaded.error}), so only recorded overrides are listed.{' '}
          <button type="button" className="link" onClick={loaded.retry}>
            Read it again
          </button>
        </p>
      )}
      {draft.dirty || draft.error ? (
        <SaveBar
          draft={draft}
          saveLabel="Render candidate"
          consequence="Rendering records a new draft candidate with these values. The baseline does not change until you accept it."
          onSave={() => void save()}
        />
      ) : (
        rows.length > 0 && (
          <p className="footnote">
            {blocked ??
              draft.lock ??
              'Edit a value to render a new draft candidate. The baseline stays as it is.'}{' '}
            {overridden > 0 &&
              `${overridden} ${overridden === 1 ? 'value overrides' : 'values override'} the source default.`}
          </p>
        )
      )}
    </Block>
  );
}

function ParamCell({
  row,
  text,
  edited,
  onChange,
}: {
  row: ParameterRow;
  text: string;
  edited: boolean;
  onChange: (text: string) => void;
}) {
  const kind = row.declared?.kind;
  const unit = row.unit || (kind === 'number' ? 'unit unspecified' : '');
  const label = `${row.name}${row.unit ? ` (${row.unit})` : ''}${row.description ? `, ${row.description}` : ''}`;
  const name = <span className="param-name mono">{row.name}</span>;
  return (
    <div className={`param ${edited ? 'edited' : ''}`}>
      <span className="param-head">
        {row.description ? <Tooltip label={row.description}>{name}</Tooltip> : name}
        {row.overridden && !edited && (
          <State
            state="override"
            label={
              row.declared && row.declared.value !== null
                ? `Override · default ${parameterText(row.declared.value)}`
                : 'Override'
            }
            tone="neutral"
            quiet
          />
        )}
        {edited && <State state="edited" label="Edited" tone="signal" quiet />}
        {!row.declared && <State state="stale" label="Not declared in the source" quiet />}
      </span>
      {!row.editable ? (
        <span className="mono param-static">
          {kind === 'expression' ? `= ${row.declared!.expr}` : parameterText(row.value)}
        </span>
      ) : kind === 'boolean' ? (
        <select aria-label={label} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          aria-label={label}
          className={kind === 'number' ? 'num' : 'mono'}
          inputMode={kind === 'number' ? 'decimal' : undefined}
          spellCheck={false}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {kind === 'expression' ? (
        <span className="param-unit">computed</span>
      ) : row.unitSource ? (
        <Tooltip label={UNIT_ORIGIN[row.unitSource]}>
          <span className="param-unit">{unit}</span>
        </Tooltip>
      ) : (
        <span className="param-unit">{unit}</span>
      )}
    </div>
  );
}
