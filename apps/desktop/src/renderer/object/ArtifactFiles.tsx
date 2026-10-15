import React, { useEffect, useState } from 'react';
import type { FileRef, Revision } from '@omenflow/contracts';
import { cmd, errMsg } from '../api';
import { Block, Button, Notice, decodeBase64 } from '../ui/kit';
import { SvgDiagram } from './stages/shared';

/** Preview immutable bytes from the displayed revision, never from a mutable working file. */
export function ArtifactFiles({
  revision,
  files,
  visualPath,
}: {
  revision: Revision;
  files: FileRef[];
  visualPath?: string;
}) {
  const [path, setPath] = useState<string | null>(visualPath ?? null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');
  const image = path?.match(/\.(png|jpe?g|gif|webp)$/i)?.[1]?.toLowerCase();
  const svg = path?.toLowerCase().endsWith('.svg');
  const text =
    path && /\.(md|txt|json|scad|csv|yaml|yml|py|tsx?|jsx?|c|cpp|h|ino|rs|toml|svg)$/i.test(path);
  useEffect(() => {
    let active = true;
    setContent(null);
    setError('');
    if (!path || (!image && !text)) return;
    void cmd<{ contentBase64: string }>('artifact.read_file', {
      artifactId: revision.artifactId,
      revisionId: revision.id,
      path,
    })
      .then(
        (r) =>
          active &&
          setContent(
            image
              ? `data:image/${image === 'jpg' ? 'jpeg' : image};base64,${r.contentBase64}`
              : new TextDecoder().decode(decodeBase64(r.contentBase64)),
          ),
      )
      .catch((e) => active && setError(errMsg(e)));
    return () => {
      active = false;
    };
  }, [path, image, text, revision.id, revision.artifactId]);
  if (!files.length) return null;
  return (
    <Block title="Files" count={files.length}>
      <ul className="plain-list mono">
        {files.map((f) => (
          <li key={f.path}>
            <button type="button" className="cell-link" onClick={() => setPath(f.path)}>
              {f.path}
            </button>
          </li>
        ))}
      </ul>
      {path && (
        <div className="stack">
          <div className="row">
            <span className="mono">{path}</span>
            <Button size="sm" variant="ghost" onClick={() => setPath(null)}>
              Close preview
            </Button>
          </div>
          {error ? (
            <Notice tone="err">File preview unavailable: {error}</Notice>
          ) : !image && !text ? (
            <p className="dim">
              This format needs a dedicated viewer. Reveal files from the record rail.
            </p>
          ) : !content ? (
            <p role="status" className="dim">
              Reading saved file…
            </p>
          ) : image ? (
            <img className="artifact-image" src={content} alt={`Recorded visual: ${path}`} />
          ) : svg ? (
            <SvgDiagram svg={content} />
          ) : (
            <pre className="artifact-file-text">{content}</pre>
          )}
        </div>
      )}
    </Block>
  );
}
