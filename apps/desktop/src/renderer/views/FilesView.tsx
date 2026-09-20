import React, { useRef, useState } from 'react';
import { DownloadSimple, File, ArrowSquareOut, Folder, X } from '@phosphor-icons/react';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import { EmptyState, PageHeader, SearchField, IconButton } from '../components/ui';

export function FilesView() {
  const { artifacts, projectPath, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [open, setOpen] = useState<{ artifactId: string; path: string } | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const request = useRef(0);
  const files = artifacts
    .flatMap((v) =>
      (v.revision?.files ?? []).map((file) => ({
        ...file,
        title: v.artifact.title,
        artifactId: v.artifact.id,
        revision: v.revision?.seq,
      })),
    )
    .filter((f) => `${f.path} ${f.title}`.toLowerCase().includes(query.toLowerCase()));
  const openFile = async (artifactId: string, path: string) => {
    const id = ++request.current;
    setOpen({ artifactId, path });
    setContent(null);
    if (!/\.(md|txt|json|scad|csv|yaml|yml|py|ts|js|c|cpp|h|toml|svg)$/i.test(path)) {
      setContent(
        'This file needs a dedicated viewer. Open its design object or reveal it in your file browser.',
      );
      return;
    }
    try {
      const result = await cmd<{ contentBase64: string }>('artifact.read_file', {
        artifactId,
        path,
      });
      if (request.current === id)
        setContent(
          new TextDecoder().decode(
            Uint8Array.from(atob(result.contentBase64), (c) => c.charCodeAt(0)),
          ),
        );
    } catch (e) {
      if (request.current === id) setContent(`Couldn’t preview this file. ${errMsg(e)}`);
    }
  };
  const exportFile = async (kind: 'archive' | 'build') => {
    if (busy) return;
    setBusy(true);
    try {
      const dest = await window.omenflow.saveFile({
        defaultPath: kind === 'archive' ? 'project.omenflow.zip' : 'build-package.zip',
      });
      if (!dest) return;
      const result = await cmd<{ path: string; files: number; status?: string; issues?: number }>(
        kind === 'archive' ? 'project.export_archive' : 'build.export',
        kind === 'archive' ? { destPath: dest } : { destPath: dest, includeDrafts },
      );
      toast(
        'ok',
        `${kind === 'archive' ? 'Project archive' : 'Build package'} exported. ${result.files} files${result.issues ? `, ${result.issues} issues to review` : ''}.`,
      );
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <PageHeader
        title="Files & exports"
        description="The working files and portable record of your engineering."
      >
        <button onClick={() => void exportFile('archive')} disabled={busy}>
          <DownloadSimple size={14} />
          Project archive
        </button>
        <button className="primary" onClick={() => void exportFile('build')} disabled={busy}>
          <DownloadSimple size={14} />
          Export build
        </button>
      </PageHeader>
      <div className="toolbar">
        <SearchField value={query} onChange={setQuery} placeholder="Find a file" />
        <span className="grow" />
        <label className="row dim" style={{ fontSize: 11 }}>
          <input
            type="checkbox"
            checked={includeDrafts}
            onChange={(e) => setIncludeDrafts(e.target.checked)}
          />
          Include drafts in build
        </label>
      </div>
      <div className="page-scroll">
        <div className="file-location">
          <Folder size={16} />
          <span className="truncate">{projectPath}</span>
          <IconButton
            label="Reveal project folder"
            onClick={() => {
              if (projectPath) void window.omenflow.revealPath(projectPath);
            }}
          >
            <ArrowSquareOut size={15} />
          </IconButton>
        </div>
        {!files.length ? (
          <EmptyState
            title={query ? 'No matching files' : 'Your project files will appear here'}
            body={
              query
                ? 'Try another file name or clear the filter.'
                : 'Create engineering objects with working files, then export the approved design as a build package.'
            }
          />
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Engineering object</th>
                  <th>Revision</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr
                    key={`${f.artifactId}:${f.path}`}
                    className={
                      open?.artifactId === f.artifactId && open.path === f.path ? 'selected' : ''
                    }
                  >
                    <td>
                      <button
                        className="table-title-button"
                        onClick={() => void openFile(f.artifactId, f.path)}
                      >
                        <File size={15} />
                        {f.path}
                      </button>
                    </td>
                    <td className="dim">{f.title}</td>
                    <td className="faint num">r{f.revision}</td>
                    <td>
                      <IconButton
                        label={`Reveal ${f.path}`}
                        onClick={() =>
                          void cmd('artifact.reveal', { artifactId: f.artifactId }).catch((e) =>
                            toast('error', errMsg(e)),
                          )
                        }
                      >
                        <ArrowSquareOut size={14} />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {open && (
          <section className="file-preview">
            <div className="section-heading">
              <h2>
                <File size={15} />
                {open.path}
              </h2>
              <IconButton
                label="Close file preview"
                onClick={() => {
                  ++request.current;
                  setOpen(null);
                }}
              >
                <X size={15} />
              </IconButton>
            </div>
            <pre>{content ?? 'Loading file…'}</pre>
          </section>
        )}
        <p className="table-footnote">
          Project archives preserve history and working files. Credentials and machine settings stay
          on this device.
        </p>
      </div>
    </div>
  );
}
