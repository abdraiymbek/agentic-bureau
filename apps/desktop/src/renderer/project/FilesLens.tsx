import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowSquareOut,
  Copy,
  Export,
  FileText,
  FolderSimple,
  MagnifyingGlass,
  X,
} from '@phosphor-icons/react';
import type { Revision } from '@omenflow/contracts';
import { CommandError, cmd, errMsg } from '../api';
import { useStore } from '../store';
import { useViewState } from '../lib/view-memory';
import {
  Button,
  Checkbox,
  Empty,
  IconButton,
  Notice,
  State,
  Tooltip,
  TypeGlyph,
  decodeBase64,
} from '../ui/kit';
import { copyText } from './copy';
import {
  FILE_STATE_LABEL,
  PREVIEW_LIMIT_BYTES,
  baselineFiles,
  buildIssuesFromError,
  buildIssuesFromPreview,
  draftFiles,
  hasDraftWork,
  historyKey,
  isTextPath,
  previewText,
  projectFilePath,
  shortPath,
  type BuildIssueGroup,
  type FileRow,
} from './files';
import { optionalCommand } from './optional-op';
import { useRowNav } from './row-nav';

type Preview =
  | { status: 'loading' }
  | { status: 'text'; lines: string[]; truncated: boolean }
  | { status: 'binary' }
  | { status: 'error'; message: string };

type Outcome =
  | {
      kind: 'archive' | 'build';
      status: 'saved';
      path: string;
      files: number;
      draft: boolean;
      issues: number;
    }
  | { kind: 'build'; status: 'refused'; message: string; groups: BuildIssueGroup[] }
  | { kind: 'archive' | 'build'; status: 'failed'; message: string };

const HISTORY_CONCURRENCY = 4;

/** Working files of approved revisions and current drafts, plus the two ways out. */
export function FilesLens() {
  const artifacts = useStore((s) => s.artifacts);
  const projectPath = useStore((s) => s.projectPath);
  const projectId = useStore((s) => s.projectId);
  const [query, setQuery] = useViewState('files:query', '');
  const [includeDrafts, setIncludeDrafts] = useViewState('files:drafts', false);
  const [drafts, setDrafts] = useState<Map<string, FileRow[]>>(new Map());
  const [draftError, setDraftError] = useState('');
  const [open, setOpen] = useState<FileRow | null>(null);
  const [preview, setPreview] = useState<Preview>({ status: 'loading' });
  const [busy, setBusy] = useState<'archive' | 'build' | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const request = useRef(0);

  // Draft files live on revisions the store does not hold; read each object's history once per
  // change to its drafts or baseline.
  useEffect(() => {
    const wanted = artifacts.filter(hasDraftWork);
    const keys = new Set(wanted.map(historyKey));
    const missing = wanted.filter((v) => !drafts.has(historyKey(v)));
    if (!missing.length) {
      if ([...drafts.keys()].some((k) => !keys.has(k)))
        setDrafts(new Map([...drafts].filter(([k]) => keys.has(k))));
      return;
    }
    let active = true;
    const read = async () => {
      const found = new Map<string, FileRow[]>();
      const queue = [...missing];
      await Promise.all(
        Array.from({ length: Math.min(HISTORY_CONCURRENCY, queue.length) }, async () => {
          for (let v = queue.shift(); v; v = queue.shift()) {
            const r = await cmd<{ revisions: Revision[] }>('artifact.history', {
              artifactId: v.artifact.id,
            });
            found.set(historyKey(v), draftFiles(v, r.revisions));
          }
        }),
      );
      return found;
    };
    void read()
      .then((found) => {
        if (!active) return;
        setDrafts((prev) => new Map([...[...prev].filter(([k]) => keys.has(k)), ...found]));
        setDraftError('');
      })
      .catch((e) => active && setDraftError(errMsg(e)));
    return () => {
      active = false;
    };
  }, [artifacts, drafts]);

  const files = useMemo(() => {
    const q = query.trim().toLowerCase();
    const live = artifacts.filter(hasDraftWork).flatMap((v) => drafts.get(historyKey(v)) ?? []);
    return [...baselineFiles(artifacts), ...live]
      .filter((f) => `${f.path} ${f.title}`.toLowerCase().includes(q))
      .sort((a, b) => a.path.localeCompare(b.path) || b.seq - a.seq);
  }, [artifacts, drafts, query]);
  const rowProps = useRowNav(files.map((f) => f.key));

  const show = async (f: FileRow) => {
    const id = ++request.current;
    setOpen(f);
    if (!isTextPath(f.path)) {
      setPreview({ status: 'binary' });
      return;
    }
    setPreview({ status: 'loading' });
    try {
      const r = await cmd<{ contentBase64: string }>('artifact.read_file', {
        artifactId: f.artifactId,
        path: f.path,
        revisionId: f.revisionId,
      });
      if (request.current === id)
        setPreview({ status: 'text', ...previewText(decodeBase64(r.contentBase64)) });
    } catch (e) {
      if (request.current === id) setPreview({ status: 'error', message: errMsg(e) });
    }
  };
  const close = () => {
    ++request.current;
    setOpen(null);
  };
  const reveal = (path: string) =>
    void window.omenflow
      .revealPath(path)
      .catch((e) => useStore.getState().toast('error', errMsg(e)));

  // The outcome shown is the host's answer: a path and file count, or the issues it refused on.
  const exportPackage = async (kind: 'archive' | 'build') => {
    if (busy || !projectId) return;
    setBusy(kind);
    setOutcome(null);
    try {
      const dest = await window.omenflow.saveFile({
        defaultPath: kind === 'archive' ? 'project.omenflow.zip' : 'build-package.zip',
        filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
      });
      if (!dest) return;
      const r = await optionalCommand<{
        path: string;
        files: number;
        status?: string;
        issues?: number;
      }>(
        kind === 'archive' ? 'project.export_archive' : 'build.export',
        kind === 'archive' ? { destPath: dest } : { destPath: dest, includeDrafts },
        { projectId },
      );
      if (r.status === 'ok') {
        setOutcome({
          kind,
          status: 'saved',
          path: r.value.path,
          files: r.value.files,
          draft: r.value.status === 'draft',
          issues: r.value.issues ?? 0,
        });
        return;
      }
      const error = r.status === 'error' ? r.error : new Error('This host cannot export packages.');
      if (
        kind === 'build' &&
        error instanceof CommandError &&
        /^Build has \d+/.test(error.message)
      ) {
        const groups =
          buildIssuesFromError(error.body.details) ??
          buildIssuesFromPreview(
            await cmd<{ items?: unknown }>('build.preview', {}, { projectId }),
          );
        setOutcome({ kind, status: 'refused', message: error.message, groups });
        return;
      }
      setOutcome({ kind, status: 'failed', message: errMsg(error) });
    } catch (e) {
      setOutcome({ kind, status: 'failed', message: errMsg(e) });
    } finally {
      setBusy(null);
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
        {projectPath && (
          <Tooltip label={`Reveal ${projectPath}`}>
            <button type="button" className="path-chip" onClick={() => reveal(projectPath)}>
              <FolderSimple size={13} />
              <span className="truncate">{shortPath(projectPath, 1)}</span>
            </button>
          </Tooltip>
        )}
        <span className="grow" />
        <Checkbox
          checked={includeDrafts}
          onChange={setIncludeDrafts}
          label="Include drafts in build"
        />
        <Button
          size="sm"
          icon={<Archive size={13} />}
          busy={busy === 'archive'}
          onClick={() => void exportPackage('archive')}
        >
          Archive
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Export size={13} />}
          busy={busy === 'build'}
          onClick={() => void exportPackage('build')}
        >
          Export build
        </Button>
      </div>

      {outcome && (
        <ExportOutcome outcome={outcome} onReveal={reveal} onDismiss={() => setOutcome(null)} />
      )}
      {draftError && <p className="tone-warn-text">Draft files didn’t load: {draftError}</p>}

      <div className={`files ${open ? 'with-preview' : ''}`}>
        {!files.length ? (
          <Empty
            title={query ? 'No matching files' : 'No working files yet'}
            body={
              query
                ? 'Try another name.'
                : 'Objects with source, meshes, or attachments list their files here, approved and draft.'
            }
          />
        ) : (
          <div className="lens-table">
            <table className="table files-table" data-rows="">
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Object</th>
                  <th scope="col">State</th>
                  <th scope="col" className="num">
                    Rev
                  </th>
                  <th scope="col">
                    <span className="sr-only">Reveal</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr
                    key={f.key}
                    {...rowProps(f.key, () => void show(f))}
                    className={`lens-row ${open?.key === f.key ? 'picked' : ''}`}
                    aria-label={`${f.path}, ${FILE_STATE_LABEL[f.state]}, ${f.title}`}
                  >
                    <td>
                      <button
                        type="button"
                        className="cell-link mono"
                        tabIndex={-1}
                        onClick={() => void show(f)}
                      >
                        <FileText size={13} />
                        <span className="truncate">{f.path}</span>
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="cell-link dim"
                        tabIndex={-1}
                        onClick={() => useStore.getState().focus(f.artifactId)}
                      >
                        <TypeGlyph type={f.type} size={13} />
                        <span className="truncate">{f.title}</span>
                      </button>
                    </td>
                    <td>
                      <State state={f.state} label={FILE_STATE_LABEL[f.state]} quiet />
                    </td>
                    <td className="num dim">r{f.seq}</td>
                    <td className="files-reveal">
                      {projectPath && (
                        <IconButton
                          size="sm"
                          label={`Reveal ${f.path}`}
                          onClick={() => reveal(projectFilePath(projectPath, f.path))}
                        >
                          <ArrowSquareOut size={13} />
                        </IconButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {open && (
          <FilePreview
            file={open}
            preview={preview}
            onClose={close}
            onReveal={projectPath ? () => reveal(projectFilePath(projectPath, open.path)) : null}
          />
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

function FilePreview({
  file,
  preview,
  onClose,
  onReveal,
}: {
  file: FileRow;
  preview: Preview;
  onClose: () => void;
  onReveal: (() => void) | null;
}) {
  return (
    <section
      className="file-preview island"
      aria-label={`Preview of ${file.path}`}
      onKeyDown={(e) => {
        // Escape closes the preview and stays on the lens.
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <span className="mono truncate">{file.path}</span>
        <span className="dim">
          {FILE_STATE_LABEL[file.state]} · r{file.seq}
        </span>
        {preview.status === 'text' && (
          <IconButton
            size="sm"
            label="Copy the text"
            onClick={() => void copyText(preview.lines.join('\n'), 'the file text')}
          >
            <Copy size={12} />
          </IconButton>
        )}
        {onReveal && (
          <IconButton size="sm" label="Reveal the file" onClick={onReveal}>
            <ArrowSquareOut size={12} />
          </IconButton>
        )}
        <IconButton size="sm" label="Close preview" onClick={onClose}>
          <X size={12} />
        </IconButton>
      </header>
      {preview.status === 'loading' ? (
        <p className="file-preview-note" role="status">
          Reading the file…
        </p>
      ) : preview.status === 'binary' ? (
        <p className="file-preview-note">
          This file needs a dedicated viewer. Open its object, or reveal it in your file browser.
        </p>
      ) : preview.status === 'error' ? (
        <p className="file-preview-note tone-warn-text">
          Couldn’t preview this file. {preview.message}
        </p>
      ) : (
        <>
          <pre className="code-lines" tabIndex={0} aria-label={`Text of ${file.path}`}>
            {preview.lines.map((line, i) => (
              <span key={i} className="code-line">
                {line}
                {'\n'}
              </span>
            ))}
          </pre>
          {preview.truncated && (
            <p className="file-preview-note">
              Showing the first {PREVIEW_LIMIT_BYTES / 1024} KB. Reveal the file to read the rest.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function ExportOutcome({
  outcome,
  onReveal,
  onDismiss,
}: {
  outcome: Outcome;
  onReveal: (path: string) => void;
  onDismiss: () => void;
}) {
  const focus = useStore((s) => s.focus);
  const what = outcome.kind === 'archive' ? 'Project archive' : 'Build package';
  const dismiss = (
    <IconButton size="sm" label="Dismiss" onClick={onDismiss}>
      <X size={12} />
    </IconButton>
  );
  if (outcome.status === 'saved')
    return (
      <Notice
        tone={outcome.draft ? 'warn' : 'ok'}
        role="status"
        action={
          <>
            <Button size="sm" onClick={() => onReveal(outcome.path)}>
              Reveal
            </Button>
            {dismiss}
          </>
        }
      >
        <strong>
          {what} saved · {outcome.files} {outcome.files === 1 ? 'file' : 'files'}
        </strong>
        {outcome.draft && (
          <>
            {' '}
            · labelled Draft with {outcome.issues} unresolved{' '}
            {outcome.issues === 1 ? 'issue' : 'issues'}
          </>
        )}
        <span className="files-outcome-path mono">{outcome.path}</span>
      </Notice>
    );
  if (outcome.status === 'failed')
    return (
      <Notice tone="err" role="alert" action={dismiss}>
        <strong>{what} not saved.</strong> {outcome.message}
      </Notice>
    );
  return (
    <Notice tone="warn" role="alert" action={dismiss}>
      <strong>Build package not exported.</strong> {outcome.message}. To export anyway, turn on
      “Include drafts in build”; the package is then labelled Draft.
      {outcome.groups.length > 0 && (
        <ul className="build-issues">
          {outcome.groups.map((g, i) => (
            <li key={g.artifactId ?? i}>
              {g.artifactId ? (
                <button type="button" className="cell-link" onClick={() => focus(g.artifactId!)}>
                  {g.title}
                </button>
              ) : (
                <strong>{g.title}</strong>
              )}
              <ul>
                {g.issues.map((issue) => (
                  <li key={issue.message}>
                    {issue.message}
                    {issue.repair && <span className="dim"> — {issue.repair}</span>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Notice>
  );
}
