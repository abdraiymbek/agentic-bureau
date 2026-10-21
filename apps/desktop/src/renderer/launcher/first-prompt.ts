/**
 * The brief typed in the launcher becomes the agent's first prompt, never submitted: the
 * conversation's draft at once, or pasted into the CLI's input once it is ready. The person reads
 * it, edits it, and sends it.
 */
import { askAgent, askedWords } from '../lib/actions';
import { paneFor } from '../shell/agent/agent-store';
import { useStore } from '../store';

/** The CLI is taken as ready once its start-up output has been quiet this long. */
export const QUIET_MS = 1500;
/** A CLI that keeps drawing is given the prompt after this long regardless. */
export const MAX_WAIT_MS = 15_000;

export function firstPromptFor(brief: string): string {
  return `Read the project intent and draft the first requirements with measurable targets and acceptance criteria. Intent: ${brief.trim()}`;
}

/**
 * On the conversation pane, puts `text` in the composer now. On the terminal pane, waits for the
 * project's agent session to run and settle, then types `text` into it, stopping without typing
 * when the project closes or the session ends first. Returns a cancel.
 */
export function offerFirstPrompt(projectId: string, text: string): () => void {
  if (paneFor(projectId) === 'conversation') {
    if (useStore.getState().projectId === projectId)
      useStore.getState().toast('info', askedWords(askAgent(text), 'Your brief'));
    return () => {};
  }
  let done = false;
  let started = false;
  let quiet: number | undefined;
  let deadline: number | undefined;

  const finish = () => {
    done = true;
    window.clearTimeout(quiet);
    window.clearTimeout(deadline);
    unsubscribe();
    unData();
  };
  const type = () => {
    if (done) return;
    finish();
    useStore.getState().toast('info', askedWords(askAgent(text), 'Your brief'));
  };
  const settle = () => {
    window.clearTimeout(quiet);
    quiet = window.setTimeout(type, QUIET_MS);
  };
  const check = (s: ReturnType<typeof useStore.getState>) => {
    if (done) return;
    if (s.projectId !== projectId) return finish();
    const running = s.session?.state === 'running';
    if (running && !started) {
      started = true;
      settle();
      deadline = window.setTimeout(type, MAX_WAIT_MS);
    } else if (started && !running) finish();
  };

  const unData = window.omenflow.onTerminalData((d) => {
    if (started && !done && d.projectId === projectId) settle();
  });
  const unsubscribe = useStore.subscribe(check);
  check(useStore.getState());
  return finish;
}
