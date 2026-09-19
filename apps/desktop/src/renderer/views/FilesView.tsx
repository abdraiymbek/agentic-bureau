import React, { useState } from 'react';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import { EmptyBlock } from './OverviewView';

/** Files surface: every artifact's working files + project archive export. */
export function FilesView() {
  const { artifacts, projectPath, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ artifactId: string; path: string } | null>(null);
  const [content, setContent] = useState<string | null>(null);

  const openFile = async (artifactId: string, p: string) => {
    if (open?.path === p) {
      setOpen(null);
      setContent(null);
      return;
    }
    setOpen({ artifactId, path: p });
    setContent(null);
    try {
      const r = await cmd<{ contentBase64: string }>('artifact.read_file', {
        artifactId,
        path: p,
      });
      const bytes = Uint8Array.from(atob(r.contentBase64), (c) => c.charCodeAt(0));
      setContent(new TextDecoder().decode(bytes));
    } catch (e) {
      setContent(`(cannot preview: ${errMsg(e)})`);
    }
  };

  const exportArchive = async () => {
    const dest = await window.omenflow.saveFile({ defaultPath: 'project.omenflow.zip' });
    if (!dest) return;
    setBusy(true);
    try {
      const r = await cmd<{ path: string; files: number }>('project.export_archive', {
        destPath: dest,
      });
      toast('ok', `Exported ${r.files} files`);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const exportBuild = async (includeDrafts: boolean) => {
    const dest = await window.omenflow.saveFile({ defaultPath: 'build-package.zip' });
    if (!dest) return;
    setBusy(true);
    try {
      const r = await cmd<{ path: string; files: number; status: string; issues: number }>(
        'build.export',
        { destPath: dest, includeDrafts },
      );
      toast('ok', `Exported ${r.status} package (${r.files} files, ${r.issues} issues)`);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 16, overflowY: 'auto', height: '100%' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Files & export</h3>
        <div className="row">
          <button style={{ height: 26, fontSize: 12 }} onClick={exportArchive} disabled={busy}>
            Export project archive…
          </button>
          <button
            className="primary"
            style={{ height: 26, fontSize: 12 }}
            onClick={() => exportBuild(true)}
            disabled={busy}
          >
            Export build package…
          </button>
        </div>
      </div>
      <div className="faint" style={{ fontSize: 12, marginBottom: 12 }}>
        Project root: <span className="mono">{projectPath}</span> — archives carry DB snapshot +
        objects + readable tree; credentials and machine settings are never exported.
      </div>
      {artifacts.length === 0 && (
        <EmptyBlock title="No files" body="Artifacts materialize files under artifacts/." />
      )}
      {artifacts.map((v) => {
        const files = v.revision?.files ?? [];
        if (files.length === 0) return null;
        return (
          <div key={v.artifact.id} style={{ marginBottom: 10 }}>
            <div className="dim" style={{ fontSize: 12, fontWeight: 600 }}>
              {v.artifact.title}
            </div>
            {files.map((f, i) => (
              <div key={i}>
                <div className="row mono" style={{ fontSize: 12, padding: '3px 0' }}>
                  <span
                    role="button"
                    tabIndex={0}
                    style={{
                      flex: 1,
                      cursor: 'pointer',
                      color:
                        open?.path === f.path ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                    onClick={() => void openFile(v.artifact.id, f.path)}
                    onKeyDown={(e) => e.key === 'Enter' && void openFile(v.artifact.id, f.path)}
                  >
                    {f.path}
                  </span>
                  <button
                    style={{ height: 20, fontSize: 11 }}
                    onClick={() =>
                      void cmd('artifact.reveal', { artifactId: v.artifact.id }).catch(() => {})
                    }
                  >
                    Reveal
                  </button>
                </div>
                {open?.path === f.path && (
                  <pre
                    className="mono"
                    style={{
                      fontSize: 11,
                      margin: '2px 0 8px',
                      padding: 8,
                      background: 'var(--bg-inset)',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      overflowX: 'auto',
                      maxHeight: 320,
                      overflowY: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                    }}
                  >
                    {content ?? '…'}
                  </pre>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
