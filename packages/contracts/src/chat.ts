/** Durable project-local conversations. User-only transport, session-scoped rich presentation. */
import type { WorkStatusSeverity } from './agent.js';

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
  /** Set when this request continues an earlier turn of the conversation. */
  continues?: ChatContinues;
  /** What work_status reported when the turn ended. Recorded by the host, never by an agent. */
  gate?: ChatGate;
  /** The model id Omen Flow passed to the CLI; absent when the CLI chose or the record predates 0.2.4. */
  model?: string;
  /** The model the CLI reported it ran (Claude Code's init event). */
  resolvedModel?: string;
  /** Tokens the CLI reported. Recorded, not shown, and never a cost. */
  usage?: ChatUsage;
  /** The CLI's own conversation id, used to resume it. */
  cliConversationId?: string;
}

/** One outstanding item as the host recorded it from work_status. Never written by an agent. */
export interface ChatGateItem {
  /** A work_status kind (`cad_unverified`, …). Newer hosts may record kinds this build does not know. */
  kind: string;
  severity: WorkStatusSeverity;
  artifactId: string;
  title: string;
  detail: string;
  /** Underscore name of the tool that resolves it; null when only a person can. */
  tool: string | null;
}
export type ChatSkipReason =
  | 'needs_person'
  | 'already_continued'
  | 'jobs_running'
  | 'busy'
  | 'prompt_limit'
  | 'agent_unavailable'
  | 'project_closed'
  | 'read_only';
/** What Omen Flow did about unfinished work when the turn ended. Later hosts may add states. */
export type ChatAutoContinue =
  | { state: 'off' }
  | { state: 'started'; requestId: string }
  | { state: 'skipped'; reason: ChatSkipReason; detail?: string };
/** The completion gate when a turn ended, read by the host from work_status. */
export interface ChatGate {
  ready: boolean;
  /** work_status's own summary, as it was returned. */
  summary: string;
  blockers: number;
  advice: number;
  /** Proposals of these sessions waiting for the person. */
  waiting: number;
  /** Blockers first, at most five. */
  outstanding: ChatGateItem[];
  /** Items not listed here; work_status lists them all. */
  more: number;
  /** This turn's agent session and those of the turns it continues, oldest first. */
  sessionIds: string[];
  /** Calls those sessions made to Omen Flow, from the host's call ledger. */
  calls: number;
  /** Artifacts those sessions wrote, ran a job on or proposed. */
  inScope: number;
  /** Jobs of those sessions still queued or running when the turn ended. */
  jobsRunning: number;
  checkedAt: string;
  /** Absent when ready, and on a failed turn: only a completed turn can be continued automatically. */
  auto?: ChatAutoContinue;
}
export interface ChatContinues {
  /** The turn this request continues. */
  requestId: string;
  /** True only when Omen Flow sent it. The transport cannot set this. */
  automatic: boolean;
}
/** Tokens the CLI reported for the run. Never a cost. */
export interface ChatUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Models the CLI says ran (Claude Code `modelUsage` keys). */
  models?: string[];
}

/**
 * The text of a continuation, sent by Continue and by Omen Flow's one automatic continuation.
 * Kept equal to `CONTINUE_TEXT` in crates/agent-host/src/chat.rs.
 */
export const CHAT_CONTINUE_TEXT =
  'Continue the unfinished work that work_status reported, through tool calls, using only facts you can observe or that the project records. Leave any item that needs information you do not have and name it. Finish when work_status, or the workStatus digest in a tool reply, reports ready, or name every remaining blocker.';
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
