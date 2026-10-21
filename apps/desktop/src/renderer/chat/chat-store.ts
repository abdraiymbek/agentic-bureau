import { create } from 'zustand';
import type { ChatRecord, ChatInput, ChatPart, ChatCard } from '@omenflow/contracts';
import { cmd, errMsg, CommandError } from '../api';
import { resolveInspection } from './inspection';
import { shareDeep } from '../lib/share';

export interface ChatDraft {
  text: string;
  version: number;
  input?: ChatInput;
}
export interface SendAttempt {
  conversationId: string;
  requestId: string;
  text: string;
  adapterId: 'codex' | 'claude-code';
  draftVersion: number;
  input?: ChatInput;
  error?: string;
}
export interface ProjectChat {
  record: ChatRecord;
  /** Memory-only context for snapshots that the host correctly refuses to mutate. */
  inspections: Record<string, { title: string; cards: ChatCard[] }>;
  activeId: string;
  drafts: Record<string, ChatDraft>;
  pending: Record<string, SendAttempt>;
  sending: Record<string, boolean>;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  storageError: boolean;
}
interface ChatState {
  projects: Record<string, ProjectChat>;
  ensure: (project: string) => void;
  refresh: (project: string) => Promise<void>;
  select: (project: string, conversation: string) => void;
  newConversation: (project: string) => void;
  draft: (project: string, text: string) => void;
  offer: (project: string, text: string) => void;
  send: (project: string, adapter: 'codex' | 'claude-code', retry?: SendAttempt) => Promise<void>;
  clearInput: (project: string) => void;
  prepare: (project: string, text: string, input: ChatInput) => void;
  open: (project: string, part: ChatPart) => Promise<void>;
  cancel: (project: string, conversation: string) => Promise<void>;
}
const key = (project: string) => `omen.chat.v1.${project}`;
const emptyRecord = (): ChatRecord => ({ version: 1, conversations: [] });
function initial(project: string): ProjectChat {
  let saved: Partial<ProjectChat> = {};
  try {
    saved = JSON.parse(localStorage.getItem(key(project)) ?? '{}') as Partial<ProjectChat>;
  } catch {
    /* A failed preference never blocks the engineering record. */
  }
  const drafts: Record<string, ChatDraft> = {};
  for (const [id, d] of Object.entries(saved.drafts ?? {})) {
    if (d && typeof d.text === 'string' && Number.isInteger(d.version)) drafts[id] = d;
  }
  const pending: Record<string, SendAttempt> = {};
  for (const [id, p] of Object.entries(saved.pending ?? {})) {
    if (
      p &&
      typeof p.requestId === 'string' &&
      typeof p.text === 'string' &&
      p.conversationId === id &&
      (p.adapterId === 'codex' || p.adapterId === 'claude-code')
    )
      pending[id] = {
        ...p,
        error:
          typeof p.error === 'string'
            ? p.error
            : 'Delivery was not confirmed. Retry checks the original request ID, so an accepted request will not run twice.',
      };
  }
  return {
    record: emptyRecord(),
    inspections: {},
    activeId: typeof saved.activeId === 'string' ? saved.activeId : crypto.randomUUID(),
    drafts,
    pending,
    sending: {},
    loading: false,
    loaded: false,
    error: null,
    storageError: false,
  };
}
function persist(project: string, state: ProjectChat): ProjectChat {
  try {
    localStorage.setItem(
      key(project),
      JSON.stringify({ activeId: state.activeId, drafts: state.drafts, pending: state.pending }),
    );
    return { ...state, storageError: false };
  } catch {
    return { ...state, storageError: true };
  }
}
/** Acknowledging an old request must never overwrite text typed after Send was pressed. */
export function acknowledge(state: ProjectChat, record: ChatRecord): ProjectChat {
  let pending = state.pending;
  let drafts = state.drafts;
  for (const c of record.conversations) {
    const p = pending[c.id];
    if (!p || !c.turns.some((t) => t.requestId === p.requestId)) continue;
    if (pending === state.pending) pending = { ...pending };
    const current = drafts[c.id];
    if (
      current?.version === p.draftVersion &&
      current.text === p.text &&
      JSON.stringify(current.input) === JSON.stringify(p.input)
    ) {
      if (drafts === state.drafts) drafts = { ...drafts };
      drafts[c.id] = { text: '', version: current.version + 1 };
    }
    delete pending[c.id];
  }
  const shared = shareDeep(state.record, record);
  if (
    shared === state.record &&
    pending === state.pending &&
    drafts === state.drafts &&
    state.loaded &&
    !state.loading &&
    !state.error
  )
    return state;
  return { ...state, record: shared, pending, drafts, loaded: true, loading: false, error: null };
}
const reads = new Map<string, number>();
export const useChat = create<ChatState>((set, get) => {
  const update = (project: string, change: (s: ProjectChat) => ProjectChat) => {
    const existing = get().projects[project];
    const state = existing ?? initial(project);
    const next = change(state);
    if (existing && next === state) return;
    const metadataChanged =
      !existing ||
      next.activeId !== state.activeId ||
      next.drafts !== state.drafts ||
      next.pending !== state.pending ||
      state.storageError;
    set({
      projects: { ...get().projects, [project]: metadataChanged ? persist(project, next) : next },
    });
  };
  return {
    projects: {},
    ensure: (project) => {
      if (!get().projects[project]) update(project, (s) => s);
    },
    refresh: async (project) => {
      get().ensure(project);
      const request = (reads.get(project) ?? 0) + 1;
      reads.set(project, request);
      update(project, (s) => (s.loaded || s.loading ? s : { ...s, loading: true }));
      try {
        const record = await cmd<ChatRecord>('chat.read', {}, { projectId: project });
        if (reads.get(project) === request) update(project, (s) => acknowledge(s, record));
      } catch (e) {
        if (reads.get(project) === request)
          update(project, (s) => ({ ...s, loading: false, error: errMsg(e) }));
      }
    },
    select: (project, conversation) => update(project, (s) => ({ ...s, activeId: conversation })),
    newConversation: (project) => update(project, (s) => ({ ...s, activeId: crypto.randomUUID() })),
    draft: (project, text) =>
      update(project, (s) => ({
        ...s,
        drafts: {
          ...s.drafts,
          [s.activeId]: {
            ...s.drafts[s.activeId],
            text,
            version: (s.drafts[s.activeId]?.version ?? 0) + 1,
          },
        },
      })),
    offer: (project, text) => {
      get().ensure(project);
      const s = get().projects[project]!;
      const current = s.drafts[s.activeId]?.text ?? '';
      get().draft(project, current.trim() ? `${current}\n\n${text}` : text);
    },
    clearInput: (project) =>
      update(project, (s) => {
        const current = s.drafts[s.activeId];
        return !current
          ? s
          : {
              ...s,
              drafts: {
                ...s.drafts,
                [s.activeId]: { text: current.text, version: current.version + 1 },
              },
            };
      }),
    prepare: (project, text, input) => {
      get().ensure(project);
      update(project, (s) => ({
        ...s,
        drafts: {
          ...s.drafts,
          [s.activeId]: {
            text: s.drafts[s.activeId]?.text.trim() ? s.drafts[s.activeId]!.text : text,
            input:
              s.drafts[s.activeId]?.input?.artifactId === input.artifactId &&
              s.drafts[s.activeId]?.input?.revisionId === input.revisionId &&
              (!!input.artifactId || s.drafts[s.activeId]?.input?.title === input.title)
                ? {
                    ...input,
                    fields: [
                      ...new Map(
                        [...(s.drafts[s.activeId]?.input?.fields ?? []), ...input.fields].map(
                          (f) => [f.name, f],
                        ),
                      ).values(),
                    ],
                  }
                : input,
            version: (s.drafts[s.activeId]?.version ?? 0) + 1,
          },
        },
      }));
      window.dispatchEvent?.(new Event('omenflow:focus-composer'));
    },
    open: async (project, part) => {
      get().ensure(project);
      const conversationId = get().projects[project]!.activeId;
      try {
        await cmd('chat.open', { conversationId, part }, { projectId: project });
        await get().refresh(project);
      } catch (error) {
        if (!(error instanceof CommandError) || error.code !== 'READ_ONLY') throw error;
        const resolved = await resolveInspection(project, part);
        update(project, (s) => {
          const current = s.inspections[conversationId];
          if (
            current?.cards.some((card) => {
              const reference: Record<string, unknown> = { ...card };
              delete reference.id;
              delete reference.origin;
              return JSON.stringify(reference) === JSON.stringify(resolved.part);
            })
          )
            return s;
          const card: ChatCard = { ...resolved.part, id: crypto.randomUUID(), origin: 'user' };
          return {
            ...s,
            inspections: {
              ...s.inspections,
              [conversationId]: {
                title: current?.title || resolved.title,
                cards: [...(current?.cards ?? []), card],
              },
            },
          };
        });
      }
      window.dispatchEvent?.(
        new CustomEvent('omenflow:open-card', { detail: { project, conversationId } }),
      );
    },
    send: async (project, adapter, retry) => {
      get().ensure(project);
      const state = get().projects[project]!;
      const id = retry?.conversationId ?? state.activeId;
      if (state.sending[id]) return;
      // An unconfirmed request has its own durable ID. Do not silently replace it with a new one.
      if (!retry && state.pending[id]) return;
      const draft = state.drafts[id];
      if (!retry && !draft?.text.trim()) return;
      const attempt: SendAttempt = retry ?? {
        conversationId: id,
        requestId: crypto.randomUUID(),
        text: draft!.text.trim(),
        adapterId: adapter,
        draftVersion: draft!.version,
        ...(draft!.input ? { input: draft!.input } : {}),
      };
      // Capture whitespace exactly too: the comparison uses what the person actually typed.
      if (!retry) attempt.text = draft!.text;
      update(project, (s) => ({
        ...s,
        pending: { ...s.pending, [id]: { ...attempt, error: undefined } },
        sending: { ...s.sending, [id]: true },
      }));
      try {
        // Preserve exactly what the person wrote; whitespace-only messages are refused.
        const response = await cmd<ChatRecord>(
          'chat.send',
          {
            conversationId: id,
            requestId: attempt.requestId,
            text: attempt.text,
            adapterId: attempt.adapterId,
            ...(attempt.input ? { input: attempt.input } : {}),
          },
          { projectId: project },
        );
        // A send snapshot can arrive after a newer read; only reconcile its acceptance, then read afresh.
        update(project, (s) => {
          const next = acknowledge(s, response);
          return { ...next, record: s.record, loaded: s.loaded, error: s.error };
        });
        await get().refresh(project);
      } catch (e) {
        update(project, (s) => ({
          ...s,
          pending: { ...s.pending, [id]: { ...attempt, error: errMsg(e) } },
        }));
      } finally {
        update(project, (s) => ({ ...s, sending: { ...s.sending, [id]: false } }));
      }
    },
    cancel: async (project, conversation) => {
      try {
        await cmd('chat.cancel', { conversationId: conversation }, { projectId: project });
        await get().refresh(project);
      } catch (e) {
        update(project, (s) => ({ ...s, error: errMsg(e) }));
      }
    },
  };
});
