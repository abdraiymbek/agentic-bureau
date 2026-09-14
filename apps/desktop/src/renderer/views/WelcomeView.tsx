import React, { useEffect, useState } from 'react';
import { cmd, errMsg, CommandError } from '../api';
import { useStore } from '../store';
import type { Project } from '@stark/contracts';

/** First-run surface: create, open, or reopen a recent project. */
export function WelcomeView() {
  const { set, setActive, toast } = useStore();
  const [recents, setRecents] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void cmd<{ projects: string[] }>('app.recent_projects')
      .then((r) => setRecents(r.projects))
      .catch(() => {});
  }, []);

  const afterOpen = async (
    r: { project: Project; projectId: string; readOnly?: boolean },
    path: string,
  ) => {
    set({ project: r.project, projectPath: path, readOnly: !!r.readOnly });
    setActive(r.projectId);
    await useStore.getState().refreshArtifacts();
    await useStore.getState().refreshProposals();
    await useStore.getState().refreshEvents();
    await useStore.getState().refreshSession();
  };

  const create = async () => {
    if (!name.trim()) return;
    const dir = await window.stark.pickDirectory('Choose project folder');
    if (!dir) return;
    setBusy(true);
    try {
      const r = await cmd<{ project: Project; projectId: string }>('project.create', {
        name,
        path: dir,
        intent,
      });
      await afterOpen({ ...r }, dir);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const open = async (dir?: string) => {
    const p = dir ?? (await window.stark.pickDirectory('Open STARK project'));
    if (!p) return;
    setBusy(true);
    try {
      const r = await cmd<{ project: Project; projectId: string; readOnly?: boolean }>(
        'project.open',
        { path: p },
      );
      await afterOpen(r, p);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const importArchive = async () => {
    const archivePath = await window.stark.pickFile({
      title: 'Import STARK archive',
      filters: [{ name: 'STARK archive', extensions: ['zip', 'stark.zip'] }],
    });
    if (!archivePath) return;
    const destDir = await window.stark.pickDirectory('Choose where to extract the project');
    if (!destDir) return;
    setBusy(true);
    try {
      const input = { archivePath, destDir };
      let r: { project: Project; projectId: string };
      try {
        r = await cmd('project.import_archive', input);
      } catch (e) {
        // Same project already open/on disk → import as a copy instead.
        if (!(e instanceof CommandError) || e.code !== 'VALIDATION') throw e;
        r = await cmd('project.import_archive', { ...input, newIdentity: true });
      }
      await afterOpen({ ...r }, destDir);
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 560, margin: '10vh auto', padding: 24 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>STARK</h1>
      <p className="dim" style={{ marginBottom: 24 }}>
        Local engineering workspace. Bring your agent CLI — STARK supplies the project, tools, and
        review boundary.
      </p>

      <div
        className="col"
        style={{
          gap: 12,
          background: 'var(--bg-main)',
          padding: 16,
          borderRadius: 6,
          border: '1px solid var(--border)',
        }}
      >
        <div
          className="dim"
          style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}
        >
          New project
        </div>
        <input placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea
          placeholder="What are you building? (intent)"
          rows={3}
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
        />
        <button className="primary" onClick={create} disabled={busy || !name.trim()}>
          Create project
        </button>
      </div>

      <div className="col" style={{ gap: 8, marginTop: 16 }}>
        <button onClick={() => open()} disabled={busy}>
          Open project folder…
        </button>
        <button onClick={importArchive} disabled={busy}>
          Import project archive…
        </button>
        {recents.length > 0 && (
          <>
            <div
              className="dim"
              style={{
                fontSize: 12,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginTop: 8,
              }}
            >
              Recent
            </div>
            {recents.map((r) => (
              <div
                key={r}
                role="button"
                tabIndex={0}
                onClick={() => open(r)}
                onKeyDown={(e) => e.key === 'Enter' && open(r)}
                style={{ padding: '6px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
                className="dim"
              >
                {r}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
