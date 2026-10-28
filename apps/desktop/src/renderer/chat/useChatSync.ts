import { useEffect } from 'react';
import { useChat } from './chat-store';

/** While the host reports changes, such as streamed text, the record is read at most this often. */
export const CHANGE_GAP_MS = 100;
/** Without a change the record is still read this often, to catch anything an event missed. */
export const FALLBACK_MS = 30_000;

/**
 * Keep the project's conversation record current while the agent surface is mounted. The host
 * says when the record changes (`onChat`) and the record is read again: one read at a time, at
 * most every 100 ms however fast the agent streams, and every 30 s without a change.
 */
export function useChatSync(projectId: string | null) {
  useEffect(() => {
    if (!projectId) return;
    const chat = useChat.getState;
    chat().ensure(projectId);
    let alive = true;
    let reading = false;
    /** A change arrived after the latest read started. */
    let stale = false;
    let lastRead = 0;
    let soon: ReturnType<typeof setTimeout> | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      soon = undefined;
      reading = true;
      stale = false;
      lastRead = Date.now();
      clearTimeout(fallback);
      try {
        await chat().refresh(projectId);
      } finally {
        reading = false;
      }
      if (!alive) return;
      fallback = setTimeout(changed, FALLBACK_MS);
      if (stale) changed();
    };
    const changed = () => {
      stale = true;
      if (!alive || reading || soon !== undefined) return;
      soon = setTimeout(() => void read(), Math.max(0, lastRead + CHANGE_GAP_MS - Date.now()));
    };
    const unsubscribe = window.bureau.onChat?.((change) => {
      if (change.projectId === projectId) changed();
    });
    void read();
    return () => {
      alive = false;
      clearTimeout(soon);
      clearTimeout(fallback);
      unsubscribe?.();
    };
  }, [projectId]);
}
