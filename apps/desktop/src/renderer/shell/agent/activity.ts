/**
 * The agent's recorded tool calls, as the host ledger reports them. Nothing here invents a call,
 * an outcome or a duration: records are merged, counted and grouped, never synthesised.
 */
import type { AgentCallAlsoRan, AgentCallRecord, AgentSessionSummary } from '@omenflow/contracts';
import { stateLabel } from '../../ui/vocabulary';

/** Calls kept in memory per project; older ones stay in the ledger and can be paged in. */
export const CALL_LIMIT = 1000;

/** A pause longer than this starts a new group in the rail. */
export const GROUP_GAP_MS = 5 * 60_000;

/** How long after the last arrival the agent counts as "working" for the activity-bar mark. */
export const ARRIVING_MS = 6_000;

const ACRONYMS: Record<string, string> = {
  cad: 'CAD',
  bom: 'BOM',
  ui: 'UI',
  mcp: 'MCP',
  id: 'ID',
  ids: 'IDs',
  url: 'URL',
  stl: 'STL',
};

/** "cad_check" → "CAD check"; "mcp__omenflow__artifact_read" → "Artifact read". */
export function toolWords(tool: string): string {
  const bare = tool.includes('__') ? tool.slice(tool.lastIndexOf('__') + 2) : tool;
  const words = bare
    .split(/[_.\s]+/)
    .filter(Boolean)
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w.toLowerCase());
  if (!words.length) return tool;
  const sentence = words.join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** "84 ms", "1.4 s", "2 min 3 s". */
export function durationLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const rest = seconds % 60;
  return rest ? `${Math.floor(seconds / 60)} min ${rest} s` : `${Math.floor(seconds / 60)} min`;
}

/** What the host ran inside a call, as it sent it; entries without a tool name are dropped. */
export function asAlsoRan(value: unknown): AgentCallAlsoRan[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AgentCallAlsoRan[] => {
    const v = item as Partial<AgentCallAlsoRan> | null;
    if (!v || typeof v !== 'object' || typeof v.tool !== 'string' || !v.tool) return [];
    const text = (x: unknown) => (typeof x === 'string' ? x : undefined);
    const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
    const flag = (x: unknown) => (typeof x === 'boolean' ? x : undefined);
    return [
      {
        tool: v.tool,
        op: text(v.op) ?? v.tool,
        ok: v.ok === true,
        code: text(v.code),
        replayed: flag(v.replayed),
        verificationStatus: text(v.verificationStatus),
        committed: flag(v.committed),
        passed: count(v.passed),
        total: count(v.total),
        scope: text(v.scope),
        ready: flag(v.ready),
        blockers: count(v.blockers),
      },
    ];
  });
}

/**
 * One line for something the host ran inside a call: its tool and what it answered, a check's state
 * in the state vocabulary's words. `warn` marks a run that did not answer or a check that did not
 * pass, so a call that was ok is not read as verified.
 */
export function alsoRanLine(entry: AgentCallAlsoRan): { text: string; warn: boolean } {
  if (!entry.ok)
    return { text: `${entry.tool} did not run${entry.code ? ` (${entry.code})` : ''}`, warn: true };
  const replayed = entry.replayed ? ', replayed' : '';
  if (entry.op === 'cad.check') {
    const counts =
      entry.passed !== undefined && entry.total !== undefined
        ? `, ${entry.passed} of ${entry.total} assertions pass`
        : '';
    const committed =
      entry.committed === true ? ', committed' : entry.committed === false ? ', not committed' : '';
    const status = entry.verificationStatus
      ? stateLabel(entry.verificationStatus, 'verification')
      : 'no status';
    return {
      text: `${entry.tool}: ${status}${counts}${committed}${replayed}`,
      warn: entry.verificationStatus !== 'passed',
    };
  }
  if (entry.op === 'work.status') {
    const scope =
      entry.scope === 'session' ? ' (this session)' : entry.scope ? ` (${entry.scope})` : '';
    const state =
      entry.ready === true
        ? 'ready'
        : entry.ready === false
          ? `not ready${entry.blockers !== undefined ? `, ${entry.blockers} ${entry.blockers === 1 ? 'blocker' : 'blockers'}` : ''}`
          : 'answered';
    return { text: `${entry.tool}${scope}: ${state}${replayed}`, warn: false };
  }
  return { text: `${entry.tool}: ok${replayed}`, warn: false };
}

/** A record as the host sent it, or null when it lacks the fields the rail relies on. */
export function asCallRecord(value: unknown): AgentCallRecord | null {
  const v = value as Partial<AgentCallRecord> | null;
  if (!v || typeof v !== 'object') return null;
  if (typeof v.seq !== 'number' || typeof v.tool !== 'string' || typeof v.ok !== 'boolean')
    return null;
  if (typeof v.sessionId !== 'string' || typeof v.at !== 'string') return null;
  const alsoRan = asAlsoRan(v.alsoRan);
  return {
    seq: v.seq,
    at: v.at,
    projectId: typeof v.projectId === 'string' ? v.projectId : '',
    sessionId: v.sessionId,
    tool: v.tool,
    op: typeof v.op === 'string' ? v.op : v.tool,
    via: v.via === 'call' ? 'call' : 'mcp',
    ok: v.ok,
    code: typeof v.code === 'string' ? v.code : null,
    message: typeof v.message === 'string' ? v.message : null,
    durationMs: typeof v.durationMs === 'number' ? v.durationMs : NaN,
    mutating: v.mutating === true,
    artifactIds: Array.isArray(v.artifactIds)
      ? v.artifactIds.filter((id): id is string => typeof id === 'string')
      : [],
    notes: Array.isArray(v.notes) ? v.notes.filter((n): n is string => typeof n === 'string') : [],
    // Absent when nothing else ran, as the host records it.
    ...(alsoRan.length ? { alsoRan } : {}),
  };
}

/** Union by sequence number, oldest first; paging back keeps the older edge of the window. */
export function mergeCalls(
  current: AgentCallRecord[],
  incoming: AgentCallRecord[],
  limit = CALL_LIMIT,
  keep: 'newest' | 'oldest' = 'newest',
): AgentCallRecord[] {
  if (!incoming.length) return current;
  const bySeq = new Map<number, AgentCallRecord>();
  for (const call of current) bySeq.set(call.seq, call);
  for (const call of incoming) bySeq.set(call.seq, call);
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return merged.length > limit
    ? keep === 'oldest'
      ? merged.slice(0, limit)
      : merged.slice(merged.length - limit)
    : merged;
}

export interface CallGroup {
  sessionId: string;
  /** ISO time of the newest call in the group. */
  latest: string;
  /** ISO time of the oldest call in the group. */
  earliest: string;
  /** Newest first. */
  calls: AgentCallRecord[];
  failures: number;
}

/**
 * Newest group first. A new group starts wherever consecutive calls are `gapMs` apart or belong
 * to different sessions.
 */
export function groupCalls(calls: AgentCallRecord[], gapMs = GROUP_GAP_MS): CallGroup[] {
  const groups: CallGroup[] = [];
  let current: CallGroup | null = null;
  let previous = Number.NaN;
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i]!;
    const at = Date.parse(call.at);
    if (!current || current.sessionId !== call.sessionId || !(Math.abs(previous - at) < gapMs)) {
      current = {
        sessionId: call.sessionId,
        latest: call.at,
        earliest: call.at,
        calls: [],
        failures: 0,
      };
      groups.push(current);
    }
    current.calls.push(call);
    current.earliest = call.at;
    if (!call.ok) current.failures++;
    previous = at;
  }
  return groups;
}

/** "1:09:15 PM – 1:11:13 PM"; one time when both ends read the same as `clock` shows them. */
export function timeRange(earliest: string, latest: string, clock: (iso: string) => string) {
  const from = clock(earliest);
  const to = clock(latest);
  return from === to ? from : `${from} – ${to}`;
}

/**
 * Calls and failures recorded for one session: the ledger's summary plus live records that
 * arrived after that summary was read.
 */
export function sessionCounts(
  sessionId: string,
  calls: AgentCallRecord[],
  sessions: AgentSessionSummary[],
  summarySeq: number,
): { calls: number; errors: number } | null {
  const summary = sessions.find((s) => s.sessionId === sessionId);
  const later = calls.filter(
    (c) => c.sessionId === sessionId && (summary ? c.seq > summarySeq : true),
  );
  if (!summary && !later.length) return null;
  return {
    calls: (summary?.calls ?? 0) + later.length,
    errors: (summary?.errors ?? 0) + later.filter((c) => !c.ok).length,
  };
}

/** What the activity-bar mark says about the agent's calls right now. */
export function activitySignal(
  calls: AgentCallRecord[],
  sessionId: string | null,
  lastArrival: number | null,
  now: number,
): { arriving: boolean; lastFailed: AgentCallRecord | null } {
  const mine = sessionId ? calls.filter((c) => c.sessionId === sessionId) : [];
  const last = mine[mine.length - 1] ?? null;
  return {
    arriving: lastArrival !== null && now - lastArrival < ARRIVING_MS,
    lastFailed: last && !last.ok ? last : null,
  };
}
