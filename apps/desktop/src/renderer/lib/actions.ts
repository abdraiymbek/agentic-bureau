/** Project-level operations shared by the launcher, titlebar, omnibar, and lenses. */
import type { Project } from '@bureau/contracts';
import { cmd, CommandError, errMsg } from '../api';
import { useStore } from '../store';
import { confirmLeave, guardLeave } from './dirty';
import { useChat } from '../chat/chat-store';
import { paneFor, useAgentUi } from '../shell/agent/agent-store';
import { sanitizePaste } from '../shell/agent/buffer';
import { surfacePhase, autostartAdapter } from '../shell/agent/phase';
import { quiet } from '../shell/agent/quiet';
import { terminalPort } from '../shell/agent/terminal-port';

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

/**
 * Opens the project at `path`, or one the person picks. Unsaved edits in the open project are
 * asked about only once the other project has opened, and discarded only when the switch happens:
 * a cancelled picker or a folder that does not open leaves them as they were.
 */
export async function openProjectAt(path?: string) {
  const dir = path ?? (await window.bureau.pickDirectory('Open Bureau project'));
  if (!dir) return false;
  const r = await cmd<{ project: Project; projectId: string; readOnly?: boolean }>('project.open', {
    path: dir,
  });
  if (!(await confirmLeave('open another project', { keep: true }))) {
    // The person stays: the project opened only to be asked about is closed again.
    if (r.projectId !== useStore.getState().projectId)
      await cmd('project.close', {}, { projectId: r.projectId });
    return false;
  }
  await enterProject(r, dir);
  return true;
}

export async function importArchive() {
  const archivePath = await window.bureau.pickFile({
    title: 'Import project archive',
    filters: [{ name: 'Project archive', extensions: ['zip', 'bureau.zip'] }],
  });
  if (!archivePath) return false;
  const destDir = await window.bureau.pickDirectory('Choose where to extract the project');
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
  return new Promise((resolve, reject) =>
    guardLeave(
      () => {
        closing ??= closeActiveProject().finally(() => {
          closing = null;
        });
        closing.then(resolve, reject);
      },
      // The edits go with the project once it has closed, not before the close succeeds.
      { action: 'close the project', cancel: resolve, keep: true },
    ),
  );
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
    const dest = await window.bureau.saveFile({
      defaultPath: kind === 'archive' ? 'project.bureau.zip' : 'build-package.zip',
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

/* ------------------------------------------------------------------ */
/* The agent                                                            */
/* ------------------------------------------------------------------ */

function liveSession() {
  const { session } = useStore.getState();
  return session?.state === 'running' ? session : null;
}

/**
 * Ask the agent. On the conversation pane the text joins the composer's draft and waits for Send.
 * On the terminal pane it is pasted into the CLI's input for the person to finish and send; with
 * no session ready for input it waits in a visible queue — the surface opens, a chosen CLI starts,
 * and the text is pasted once the CLI shows its prompt. It is never dropped or sent.
 */
export type AskOutcome = 'pasted' | 'queued' | 'drafted' | 'shown';

export function askAgent(text: string): AskOutcome {
  const { projectId: current } = useStore.getState();
  if (current && paneFor(current) === 'conversation') {
    showAgent();
    if (!text.trim()) return 'shown';
    useChat.getState().offer(current, text);
    return 'drafted';
  }
  showAgent();
  const clean = sanitizePaste(text);
  if (!clean.trim()) return 'shown';
  const { projectId } = useStore.getState();
  const port = terminalPort(projectId);
  if (liveSession() && port?.readyForInput() && !useAgentUi.getState().pending.length) {
    port.paste(clean);
    return 'pasted';
  }
  useAgentUi.getState().enqueue(clean);
  startIfUnambiguous();
  return 'queued';
}

/** What became of an ask, as a sentence about `what` ("The rebase request"). */
export function askedWords(outcome: AskOutcome, what: string): string {
  return outcome === 'drafted'
    ? `${what} is in the conversation’s message box, not sent. Read it there and press Send.`
    : outcome === 'pasted'
      ? `${what} is typed into the agent’s input, not sent. Read it there and press Enter to send it.`
      : `${what} waits beside the agent’s input and is typed once the agent is ready. Nothing is sent.`;
}

/**
 * Paste everything waiting in the ask queue. `force` pastes even before the CLI has shown its
 * prompt (the person pressed "Paste now"); the port then types it on one line, so a start-up
 * dialog or a half-ready input never receives an Enter. Returns false when nothing could be pasted.
 */
export function flushAsks(force = false): boolean {
  const { projectId } = useStore.getState();
  const port = terminalPort(projectId);
  if (!port || !liveSession() || (!force && !port.readyForInput())) return false;
  const pending = useAgentUi.getState().takePending();
  if (!pending.length) return false;
  if (!port.paste(pending.map((p) => p.text).join('\n'))) {
    for (const p of pending) useAgentUi.getState().enqueue(p.text);
    return false;
  }
  port.focus();
  return true;
}

/** Start the agent when there is no session yet and exactly one CLI is the choice. */
function startIfUnambiguous() {
  const s = useStore.getState();
  const ui = useAgentUi.getState();
  const adapterId = autostartAdapter(
    surfacePhase({
      readOnly: s.readOnly,
      session: s.session,
      adapters: s.adapters,
      detection: ui.detection,
      start: ui.start,
      agentId: s.agentId,
      conversationRunning: !!s.projectId && conversationBusy(s.projectId),
    }),
  );
  if (adapterId) void startAgent(adapterId).catch(() => {});
}

/** Paste text into the agent CLI without submitting, so the person can finish it. */
export async function typeIntoAgent(text: string) {
  askAgent(text);
}

/**
 * Paste text and submit it, for an instruction the person asked to send as it is. Without a live
 * session it waits in the ask queue and is pasted, not submitted, once the CLI is ready.
 */
export async function sendToAgent(text: string) {
  const { projectId } = useStore.getState();
  const port = terminalPort(projectId);
  if (!liveSession() || !port || !port.paste(text)) {
    askAgent(text);
    return;
  }
  await port.write('\r');
}

/** A conversation response is running in this project. */
function conversationBusy(projectId: string): boolean {
  return !!useChat
    .getState()
    .projects[projectId]?.record.conversations.some((c) =>
      c.turns.some((t) => t.state === 'running'),
    );
}

/**
 * Reveal the agent: its tab when already there, else the floating window. Focus goes to the pane
 * that shows, the terminal or the conversation's composer.
 */
export function showAgent() {
  const s = useStore.getState();
  if (s.view.level !== 'agent') s.set({ agentWindowOpen: true });
  window.dispatchEvent(new CustomEvent('bureau:focus-terminal'));
}

/**
 * Start the agent CLI in this project at the size the terminal shows. The agent surface presents
 * progress and the host's error from the agent store, so the failure is not also raised as an
 * application error; the caller may still handle the rejection.
 */
export async function startAgent(adapterId: string, size?: { cols: number; rows: number }) {
  const { projectId, readOnly, refreshSession } = useStore.getState();
  if (!projectId) throw new Error('Open a project before starting an agent');
  if (readOnly) throw new Error('Agent sessions are disabled for read-only projects');
  const ui = useAgentUi.getState();
  if (ui.start.status === 'starting') return;
  const measured = size ?? terminalPort(projectId)?.size() ?? null;
  ui.setStart({ status: 'starting', adapterId });
  const r = await quiet('terminal.start', { adapterId, ...(measured ?? {}) }, { projectId });
  if (!r.ok) {
    const error = new CommandError(r.error);
    if (useStore.getState().projectId === projectId)
      useAgentUi.getState().setStart({ status: 'failed', adapterId, error: errMsg(error) });
    throw error;
  }
  try {
    if (useStore.getState().projectId === projectId) await refreshSession();
  } finally {
    useAgentUi.getState().setStart({ status: 'idle' });
  }
}

/** Start from a control on the agent surface, which shows progress and any failure itself. */
export function startAgentFromSurface(adapterId: string) {
  void startAgent(adapterId).catch(() => {});
}

/** Start a new session on the same CLI. The conversation starts over; the record does not. */
export async function restartAgent() {
  const { session } = useStore.getState();
  if (!session) return;
  await startAgent(session.adapterId);
}

export async function stopAgent() {
  const { projectId } = useStore.getState();
  if (projectId) await cmd('terminal.stop', {}, { projectId });
}

/** Send Ctrl-C to the CLI, as the person would to cancel what it is doing. */
export async function interruptAgent() {
  const { projectId } = useStore.getState();
  if (projectId && liveSession()) await cmd('terminal.interrupt', {}, { projectId });
}
