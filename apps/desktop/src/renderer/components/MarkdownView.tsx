import React, { useEffect, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import type { ArtifactView } from '@omenflow/contracts';

/** Read a revision's markdown-ish content + file list, with sanitized render. */
export function MarkdownView({ view }: { view: ArtifactView }) {
  const { refreshArtifacts, toast, readOnly } = useStore();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const rev = view.revision;

  const contentOf = (payload: unknown): string => {
    const p = (payload ?? {}) as Record<string, unknown>;
    for (const k of ['markdown', 'statement', 'description', 'body', 'notes']) {
      if (typeof p[k] === 'string') return p[k];
    }
    return '';
  };
  const current = contentOf(rev?.payload);

  useEffect(() => {
    setText(current);
    setEditing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev?.id]);

  const save = async () => {
    if (!rev) return;
    const p = { ...(rev.payload as Record<string, unknown>) };
    const key =
      ['markdown', 'statement', 'description', 'body', 'notes'].find(
        (k) => typeof p[k] === 'string',
      ) ?? 'markdown';
    p[key] = text;
    try {
      await cmd('artifact.apply_edit', {
        artifactId: view.artifact.id,
        baseRevisionId: rev.id,
        payload: p,
        rationale: 'edit text',
      });
      await refreshArtifacts();
      setEditing(false);
      toast('ok', 'Saved');
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button
          style={{ height: 24, fontSize: 12 }}
          disabled={readOnly || !rev}
          onClick={() => setEditing((e) => !e)}
        >
          {editing ? 'Preview' : 'Edit'}
        </button>
        {editing && (
          <button
            className="primary"
            style={{ height: 24, fontSize: 12 }}
            disabled={readOnly}
            onClick={save}
          >
            Save
          </button>
        )}
      </div>
      {editing ? (
        <textarea
          aria-label="Object text"
          className="mono"
          rows={18}
          style={{ width: '100%', fontSize: 12 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <div
          className="md"
          style={{ fontSize: 13, lineHeight: 1.6 }}
          dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(
              marked.parse(current || '_No content_', { async: false }) as string,
            ),
          }}
        />
      )}
      {rev && rev.files.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>
            Files
          </div>
          {rev.files.map((f) => (
            <div key={f.path} className="mono dim" style={{ fontSize: 12, padding: '2px 0' }}>
              {f.path}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
