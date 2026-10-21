import { useEffect } from 'react';
import { useChat, type ProjectChat } from './chat-store';

/** A response is running or a send is unconfirmed: read the record often. */
export function chatBusy(state: ProjectChat | undefined): boolean {
  return (
    !!state &&
    (Object.keys(state.pending).length > 0 ||
      state.record.conversations.some((c) => c.turns.some((t) => t.state === 'running')))
  );
}

/**
 * Keep the project's conversation record current while the agent surface is mounted: every 200 ms
 * while a response runs, every 5 s otherwise.
 */
export function useChatSync(projectId: string | null) {
  const busy = useChat((s) => chatBusy(projectId ? s.projects[projectId] : undefined));
  useEffect(() => {
    if (!projectId) return;
    useChat.getState().ensure(projectId);
    void useChat.getState().refresh(projectId);
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!alive) return;
      await useChat.getState().refresh(projectId);
      if (alive)
        timer = setTimeout(
          () => void poll(),
          chatBusy(useChat.getState().projects[projectId]) ? 200 : 5000,
        );
    };
    timer = setTimeout(() => void poll(), busy ? 50 : 900);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [projectId, busy]);
}
