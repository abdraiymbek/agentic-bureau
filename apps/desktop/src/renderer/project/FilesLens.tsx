import React, { useRef, useState } from 'react';
import {
  ArrowSquareOut,
  Archive,
  Export,
  FileText,
  FolderSimple,
  MagnifyingGlass,
  X,
} from '@phosphor-icons/react';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import { Button, Empty, IconButton, TypeGlyph, decodeBase64 } from '../ui/kit';
import { exportProject } from '../lib/actions';

const TEXT = /\.(md|txt|json|scad|csv|yaml|yml|py|ts|js|c|cpp|h|toml|svg)$/i;

/** Working files by the object and revision that own them, plus the two ways out. */
export function FilesLens() {
  const artifacts = useStore((s) => s.artifacts);
  const projectPath = useStore((s) => s.projectPath);
  const { toast, focus } = useStore.getState();
  const [query, setQuery] = useState('');
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [open, setOpen] = useState<{ artifactId: string; path: string } | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const request = useRef(0);

  const files = artifacts
    .flatMap((v) =>
      (v.revision?.files ?? []).map((f) => ({
        ...f,
        artifactId: v.artifact.id,
        title: v.artifact.title,
        type: v.artifact.type,
        revision: v.revision?.seq,
      })),
    )
    .filter((f) => `${f.path} ${f.title}`.toLowerCase().includes(query.toLowerCase()));

  const preview = async (artifactId: string, path: string) => {
    const id = ++request.current;
    setOpen({ artifactId, path });
    setContent(null);
    if (!TEXT.test(path)) {
      setContent(
        'This file needs a dedicated viewer. Open its object, or reveal it in your file browser.',
      );
      return;
    }
    try {
      const r = await cmd<{ contentBase64: string }>('artifact.read_file', { artifactId, path });
      if (request.current === id)
        setContent(new TextDecoder().decode(decodeBase64(r.contentBase64)));
    } catch (e) {
      if (request.current === id) setContent(`Couldn’t preview this file. ${errMsg(e)}`);
    }
  };

  return (
    <div className="lens-page">
      <div className="lens-bar">
        <label className="find">
          <MagnifyingGlass size={13} />
          <input
            aria-label="Find a file"
            placeholder="Find a file"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="path-chip"
          title="Reveal project folder"
          onClick={() => projectPath && void window.omenflow.revealPath(projectPath)}
        >
          <FolderSimple size={13} />
          <span className="truncate">{projectPath}</span>
        </button>
        <span className="grow" />
        <label className="check">
          <input
            type="checkbox"
            checked={includeDrafts}
            onChange={(e) => setIncludeDrafts(e.target.checked)}
          />
          Include drafts in build
        </label>
        <Button
          size="sm"
          icon={<Archive size={13} />}
          onClick={() => void exportProject('archive')}
        >
          Archive
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Export size={13} />}
          onClick={() => void exportProject('build', includeDrafts)}
        >
          Export build
        </Button>
      </div>
      <div className={`files ${open ? 'with-preview' : ''}`}>
        {!files.length ? (
          <Empty
            title={query ? 'No matching files' : 'No working files yet'}
            body={
              query
                ? 'Try another name.'
                : 'Objects with source, meshes, or attachments list their files here by revision.'
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Object</th>
                  <th className="num">Rev</th>
                  <th aria-label="Reveal" />
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr
                    key={`${f.artifactId}:${f.path}`}
                    className={
                      open?.artifactId === f.artifactId && open.path === f.path ? 'picked' : ''
                    }
                  >
                    <td>
                      <button
                        type="button"
                        className="cell-link mono"
                        onClick={() => void preview(f.artifactId, f.path)}
                      >
                        <FileText size={13} />
                        {f.path}
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="cell-link dim"
                        onClick={() => focus(f.artifactId)}
                      >
                        <TypeGlyph type={f.type} size={13} />
                        {f.title}
                      </button>
                    </td>
                    <td className="num dim">r{f.revision}</td>
                    <td>
                      <IconButton
                        size="sm"
                        label={`Reveal ${f.path}`}
                        onClick={() =>
                          void cmd('artifact.reveal', { artifactId: f.artifactId }).catch((e) =>
                            toast('error', errMsg(e)),
                          )
                        }
                      >
                        <ArrowSquareOut size={13} />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {open && (
          <section className="file-preview island">
            <header>
              <span className="mono truncate">{open.path}</span>
              <IconButton
                size="sm"
                label="Close preview"
                onClick={() => {
                  ++request.current;
                  setOpen(null);
                }}
              >
                <X size={12} />
              </IconButton>
            </header>
            <pre>{content ?? 'Loading…'}</pre>
          </section>
        )}
      </div>
      <p className="footnote">
        An archive carries the full history and working files. A build package carries approved
        revisions{includeDrafts ? ' and drafts' : ''}. Credentials and machine settings stay on this
        device.
      </p>
    </div>
  );
}
