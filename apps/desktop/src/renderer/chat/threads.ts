import type { ChatConversation } from '@bureau/contracts';
import type { ProjectChat } from './chat-store';

/**
 * Every conversation a person can return to: the recorded ones, read-only inspections, and unsent
 * drafts that have no record yet. Oldest first.
 */
export function conversationThreads(
  state: ProjectChat | undefined,
): Pick<ChatConversation, 'id' | 'title' | 'turns'>[] {
  if (!state) return [];
  const recorded = (id: string) => state.record.conversations.some((c) => c.id === id);
  return [
    ...state.record.conversations,
    ...Object.entries(state.inspections)
      .filter(([id]) => !recorded(id))
      .map(([id, context]) => ({ id, title: context.title, turns: [] })),
    ...Object.entries(state.drafts)
      .filter(
        ([id, d]) =>
          (d.text.trim() || state.pending[id]) && !recorded(id) && !state.inspections[id],
      )
      .map(([id, d]) => ({
        id,
        title: `Draft · ${d.text.slice(0, 48) || state.pending[id]?.text.slice(0, 48) || 'Unsent message'}`,
        turns: [],
      })),
  ];
}

/** A turn of this project is running, in any conversation. */
export function conversationRunning(state: ProjectChat | undefined): boolean {
  return !!state?.record.conversations.some((c) => c.turns.some((t) => t.state === 'running'));
}
