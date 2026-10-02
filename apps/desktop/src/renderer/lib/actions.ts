/** Project-level operations shared by the launcher, titlebar, omnibar, and lenses. */
import type { Project } from '@omenflow/contracts';
import { cmd, CommandError, errMsg } from '../api';
import { useStore } from '../store';

export async function enterProject(
  r: { project: Project; projectId: string; readOnly?: boolean },
  path: string,
) {
  const s = useStore.getState();
  if (s.projectId && s.projectId !== r.projectId) {
    await cmd('project.close', {}, { projectId: s.projectId });
  }
  s.set({ project: r.project, projectPath: path, readOnly: !!r.readOnly });
  s.setActive(r.projectId);
  await useStore.getState().refreshAll();
}

export async function openProjectAt(path?: string) {
  const dir = path ?? (await window.omenflow.pickDirectory('Open Omen Flow project'));
  if (!dir) return false;
  const r = await cmd<{ project: Project; projectId: string; readOnly?: boolean }>('project.open', {
    path: dir,
  });
  await enterProject(r, dir);
  return true;
}

export async function createProject(name: string, intent: string) {
  const dir = await window.omenflow.pickDirectory('Choose project folder');
  if (!dir) return false;
  const r = await cmd<{ project: Project; projectId: string }>('project.create', {
    name: name.trim(),
    path: dir,
    intent: intent.trim(),
  });
  await enterProject(r, dir);
  return true;
}

export async function importArchive() {
  const archivePath = await window.omenflow.pickFile({
    title: 'Import project archive',
    filters: [{ name: 'Project archive', extensions: ['zip', 'omenflow.zip'] }],
  });
  if (!archivePath) return false;
  const destDir = await window.omenflow.pickDirectory('Choose where to extract the project');
  if (!destDir) return false;
  const input = { archivePath, destDir };
  let r: { project: Project; projectId: string };
  try {
    r = await cmd('project.import_archive', input);
  } catch (e) {
    if (!(e instanceof CommandError) || e.code !== 'REVISION_CONFLICT') throw e;
    r = await cmd('project.import_archive', { ...input, newIdentity: true });
  }
  await enterProject(r, destDir);
  return true;
}

let closing: Promise<void> | null = null;
export function closeProject(): Promise<void> {
  if (closing) return closing;
  closing = closeActiveProject().finally(() => {
    closing = null;
  });
  return closing;
}

async function closeActiveProject() {
  const s = useStore.getState();
  if (!s.projectId) return;
  await cmd('project.close', {}, { projectId: s.projectId });
  if (useStore.getState().projectId !== s.projectId) return;
  s.set({ project: null, projectPath: null, readOnly: false, agentWindowOpen: false });
  s.setActive(null);
}

let exporting = false;
/** Returns only after the export operation itself reports success. */
export async function exportProject(kind: 'archive' | 'build', includeDrafts = false) {
  const { toast, projectId } = useStore.getState();
  if (exporting || !projectId) return;
  exporting = true;
  try {
    const dest = await window.omenflow.saveFile({
      defaultPath: kind === 'archive' ? 'project.omenflow.zip' : 'build-package.zip',
    });
    if (!dest) return;
    const result = await cmd<{ path: string; files: number; issues?: number }>(
      kind === 'archive' ? 'project.export_archive' : 'build.export',
      kind === 'archive' ? { destPath: dest } : { destPath: dest, includeDrafts },
      { projectId },
    );
    toast(
      'ok',
      `${kind === 'archive' ? 'Project archive' : 'Build package'} exported · ${result.files} files${
        result.issues ? ` · ${result.issues} issues to review` : ''
      }`,
    );
  } catch (e) {
    toast('error', errMsg(e));
  } finally {
    exporting = false;
  }
}

/** Type into the running agent CLI exactly as if pasted, then submit. */
export async function sendToAgent(text: string) {
  const { projectId, session } = useStore.getState();
  if (!projectId || session?.state !== 'running') throw new Error('No running agent session');
  await cmd('terminal.write', { data: `\x1b[200~${text}\x1b[201~` }, { projectId });
  await cmd('terminal.write', { data: '\r' }, { projectId });
}

/** Paste text into the running agent CLI without submitting, so the user can finish it. */
export async function typeIntoAgent(text: string) {
  const { projectId, session } = useStore.getState();
  if (!projectId || session?.state !== 'running') throw new Error('No running agent session');
  await cmd('terminal.write', { data: `\x1b[200~${text}\x1b[201~` }, { projectId });
}

/** Reveal the one agent terminal: its tab when already there, else the floating window. */
export function showAgent() {
  const s = useStore.getState();
  if (s.view.level !== 'agent') s.set({ agentWindowOpen: true });
  window.dispatchEvent(new CustomEvent('omenflow:focus-terminal'));
}

/** Start the agent CLI in this project; the caller presents failures and retry. */
export async function startAgent(adapterId: string) {
  const { projectId, readOnly, refreshSession } = useStore.getState();
  if (!projectId) throw new Error('Open a project before starting an agent');
  if (readOnly) throw new Error('Agent sessions are disabled for read-only projects');
  await cmd('terminal.start', { adapterId }, { projectId });
  if (useStore.getState().projectId === projectId) await refreshSession();
}
