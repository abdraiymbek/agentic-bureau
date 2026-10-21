/** Durable project-local conversations. User-only transport, session-scoped rich presentation. */
export type ChatRunState =
  'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unavailable';
export interface ChatTurn {
  requestId: string;
  text: string;
  response: string;
  parts?: ChatCard[];
  input?: ChatInput;
  adapterId: string;
  sessionId: string | null;
  state: ChatRunState;
  error: string | null;
  createdAt: string;
}
export interface ChatConversation {
  id: string;
  title: string;
  turns: ChatTurn[];
  cards?: ChatCard[];
}
export interface ChatRecord {
  version: 1;
  conversations: ChatConversation[];
}

/** A bounded, declarative vocabulary. No agent-supplied code or URLs execute. */
export type ChatPart =
  | { kind: 'artifact'; artifactId: string; revisionId?: string }
  | { kind: 'review'; proposalId: string }
  | {
      kind: 'chart';
      title: string;
      xLabel: string;
      xUnit: string;
      yLabel: string;
      yUnit: string;
      source: string;
      provenance: 'illustrative';
      points: { x: number; y: number }[];
    }
  | {
      kind: 'form';
      title: string;
      fields: {
        name: string;
        label: string;
        unit: string;
        value: number | null;
        reason?: string;
      }[];
    }
  | { kind: 'choices'; title: string; options: { label: string; prompt: string }[] };
/** A part as recorded. The host pins artifact revisions and adds artifact and review titles. */
export type ChatCard = ChatPart & { id: string; origin?: 'user' | 'agent'; title?: string };
export interface ChatInput {
  artifactId?: string;
  revisionId?: string;
  title: string;
  intent: 'render' | 'evaluate';
  fields: { name: string; text: string; unit: string; unknown: boolean; reason?: string }[];
}
