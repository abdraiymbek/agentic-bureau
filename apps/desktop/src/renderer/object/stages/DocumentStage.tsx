import React, { useState } from 'react';
import type { ConceptPayload, Revision, SoftwarePayload } from '@omenflow/contracts';
import { cmd } from '../../api';
import { useStore } from '../../store';
import { Block, Button, Facts } from '../../ui/kit';
import { documentForm, documentTextKey, type DocumentForm } from '../../lib/stage-forms';
import { ArtifactFiles } from '../ArtifactFiles';
import { useRevisionDraft } from '../useRevisionDraft';
import {
  Prose,
  SaveBar,
  SvgDiagram,
  UnderneathNotice,
  qty,
  type FieldLabels,
  type StageProps,
} from './shared';

const lines = (text: string) => `${text ? text.split('\n').length : 0} lines`;
const LABELS: FieldLabels<DocumentForm> = { text: { label: 'Text', show: lines } };

const payloadOf = (revision: Revision | null) =>
  (revision?.payload ?? {}) as Record<string, unknown>;

/** Concept, architecture, subsystem, software and note: prose first, structure after. */
export function DocumentStage({ view }: StageProps) {
  const toast = useStore((s) => s.toast);
  const type = view.artifact.type;
  const rev = view.revision;
  const payload = payloadOf(rev);
  const draft = useRevisionDraft<DocumentForm>({
    view,
    label: `text of “${view.artifact.title}”`,
    toForm: (revision) => documentForm(type, payloadOf(revision)),
    save: async (form, base) => {
      const recorded = payloadOf(base);
      const r = await cmd<{ revision: Revision }>('artifact.apply_edit', {
        artifactId: view.artifact.id,
        baseRevisionId: base.id,
        payload: { ...recorded, [documentTextKey(type, recorded)]: form.text },
        rationale: 'Edit text',
      });
      return r.revision.id;
    },
  });
  const [editorOpen, setEditorOpen] = useState(false);
  const editing = editorOpen && draft.canEdit;
  const text = draft.form.text;
  const save = async () => {
    const id = await draft.save();
    if (!id) return;
    setEditorOpen(false);
    toast('ok', 'Text saved as the new baseline');
  };
  const software = type === 'software' ? (payload as Partial<SoftwarePayload>) : null;
  const concept = type === 'concept' ? (payload as Partial<ConceptPayload>) : null;
  const preview = text ? <Prose markdown={text} /> : <p className="dim">No text recorded.</p>;
  return (
    <div className={`doc ${editing ? 'wide' : ''}`}>
      {software && (
        <Facts
          rows={[
            ['Language', software.language ?? 'Not specified'],
            [
              'Entry point',
              <span className="mono" key="e">
                {software.entryPoint ?? 'Not specified'}
              </span>,
            ],
          ]}
        />
      )}
      <UnderneathNotice draft={draft} labels={LABELS} />
      <div className="stage-toolbar">
        <Button
          size="sm"
          variant="ghost"
          disabled={!draft.canEdit}
          aria-expanded={editing}
          onClick={() => setEditorOpen((open) => !open)}
        >
          {editing ? 'Close editor' : 'Edit text'}
        </Button>
        {draft.lock && <span className="stage-toolbar-note">{draft.lock}</span>}
      </div>
      {editing ? (
        <div className="doc-edit">
          <div className="doc-edit-pane">
            <span className="field-label">Markdown</span>
            <textarea
              aria-label="Object text"
              className="code-editor prose-editor"
              spellCheck
              disabled={draft.busy}
              value={text}
              onChange={(e) => draft.edit({ text: e.target.value })}
            />
          </div>
          <div className="doc-edit-pane">
            <span className="field-label">
              {draft.dirty ? 'Preview of what will be saved' : 'Preview'}
            </span>
            <div className="doc-preview">{preview}</div>
          </div>
        </div>
      ) : (
        <>
          {draft.dirty && (
            <p className="doc-unsaved" role="status">
              Showing your unsaved text, not the recorded revision.
            </p>
          )}
          {preview}
        </>
      )}
      {(editing || draft.dirty || draft.error) && (
        <SaveBar
          draft={draft}
          saveLabel="Save text"
          consequence="Saving records a new baseline revision without a review."
          onSave={() => void save()}
        />
      )}
      {typeof payload.diagramSvg === 'string' && <SvgDiagram svg={payload.diagramSvg} />}
      {concept && Object.keys(concept.approxDimensions ?? {}).length > 0 && (
        <Block title="Approximate dimensions">
          <Facts
            rows={Object.entries(concept.approxDimensions!).map(([name, q]) => [
              name,
              <span className="num" key={name}>
                {qty(q)}
              </span>,
            ])}
          />
        </Block>
      )}
      {concept &&
        [
          { title: 'Systems', items: concept.systems },
          { title: 'Alternatives', items: concept.alternatives },
          { title: 'Uncertainties', items: concept.uncertainties },
        ].map(
          (s) =>
            (s.items?.length ?? 0) > 0 && (
              <Block key={s.title} title={s.title} count={s.items!.length}>
                <ul className="plain-list">
                  {s.items!.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </Block>
            ),
        )}
      {rev && (
        <ArtifactFiles
          key={rev.id}
          revision={rev}
          visualPath={concept?.visualFile?.path}
          files={[
            ...new Map(
              [
                ...rev.files,
                ...(software?.files ?? []),
                ...(concept?.visualFile ? [concept.visualFile] : []),
              ].map((f) => [f.path, f]),
            ).values(),
          ]}
        />
      )}
    </div>
  );
}
