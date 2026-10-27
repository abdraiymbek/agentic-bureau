/**
 * Words for an agent session, taken only from what the host reported. A field the host did not
 * send is left out; nothing here fills a gap with a guess.
 */
import type {
  AdapterStatus,
  CapabilityProfile,
  ProfileSource,
  SessionInfo,
} from '@bureau/contracts';
import type { Tone } from '../../ui/kit';

export const PROFILE_WORDS: Record<CapabilityProfile, string> = {
  compact: 'Compact',
  standard: 'Standard',
  full: 'Full',
};

const SOURCE_WORDS: Record<ProfileSource, string> = {
  user: 'your setting',
  model: 'from model',
  'adapter-default': 'adapter default',
};

/** "Compact · from model". Null when the host did not report a profile. */
export function profileLabel(
  profile: CapabilityProfile | undefined,
  source: ProfileSource | undefined,
): string | null {
  if (!profile || !(profile in PROFILE_WORDS)) return null;
  const word = PROFILE_WORDS[profile];
  return source && source in SOURCE_WORDS ? `${word} · ${SOURCE_WORDS[source]}` : word;
}

export interface SessionStatus {
  word: string;
  tone: Tone;
  /** The CLI is running and reading input. Only then does anything pulse. */
  live: boolean;
  /** The session can no longer take input. */
  over: boolean;
  /** "exit code 1" when the host recorded one. */
  exit: string | null;
}

const STATUS: Record<SessionInfo['state'], { word: string; tone: Tone }> = {
  starting: { word: 'Starting', tone: 'signal' },
  running: { word: 'Running', tone: 'signal' },
  exited: { word: 'Ended', tone: 'neutral' },
  interrupted: { word: 'Interrupted', tone: 'warn' },
  failed: { word: 'Failed', tone: 'err' },
};

export function sessionStatus(session: SessionInfo | null): SessionStatus {
  if (!session)
    return { word: 'Not started', tone: 'neutral', live: false, over: false, exit: null };
  const known = STATUS[session.state] ?? { word: session.state, tone: 'neutral' as Tone };
  const exit = typeof session.exitCode === 'number' ? `exit code ${session.exitCode}` : null;
  // A non-zero exit is a failure even when the host files it under "exited".
  const failedExit =
    session.state === 'exited' && typeof session.exitCode === 'number' && session.exitCode !== 0;
  return {
    word: known.word,
    tone: failedExit ? 'err' : known.tone,
    live: session.state === 'running',
    over: session.state !== 'running' && session.state !== 'starting',
    exit,
  };
}

/** "12 s", "4 min", "1 h 12 min". Null when the start time is not recorded or unreadable. */
export function elapsedLabel(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
  now: number,
): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const end = endedAt ? Date.parse(endedAt) : now;
  const seconds = Math.max(0, Math.floor(((Number.isFinite(end) ? end : now) - start) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function adapterLabel(adapters: AdapterStatus[], adapterId: string | undefined): string {
  if (!adapterId) return 'Agent';
  return adapters.find((a) => a.adapterId === adapterId)?.label ?? adapterId;
}

export interface SessionFact {
  key: 'model' | 'profile' | 'tools' | 'calls';
  label: string;
  value: string;
  tone?: Tone;
}

/**
 * Recorded calls and failures for a session. The host's counters and the activity ledger count
 * the same calls; whichever has seen more is the more recent, and its pair is used as a whole.
 */
export function latestCounts(
  session: Pick<SessionInfo, 'calls' | 'errors'>,
  ledger: { calls: number; errors: number } | null | undefined,
): { calls: number; errors: number } | null {
  const host =
    typeof session.calls === 'number'
      ? { calls: session.calls, errors: session.errors ?? 0 }
      : null;
  if (!host) return ledger ?? null;
  if (!ledger) return host;
  return ledger.calls > host.calls ? ledger : host;
}

/** What the session bar may say about a session, in order. */
export function sessionFacts(
  session: SessionInfo,
  ledger?: { calls: number; errors: number } | null,
): SessionFact[] {
  const facts: SessionFact[] = [];
  if (session.model) facts.push({ key: 'model', label: 'Model', value: session.model });
  const profile = profileLabel(session.profile, session.profileSource);
  if (profile) facts.push({ key: 'profile', label: 'Tool profile', value: profile });
  if (typeof session.toolCount === 'number' && session.toolCount > 0)
    facts.push({
      key: 'tools',
      label: 'Tools listed',
      value: `${session.toolCount} ${session.toolCount === 1 ? 'tool' : 'tools'}`,
    });
  const counts = latestCounts(session, ledger);
  if (counts)
    facts.push({
      key: 'calls',
      label: 'Recorded calls',
      value:
        `${counts.calls} ${counts.calls === 1 ? 'call' : 'calls'}` +
        (counts.errors > 0 ? ` · ${counts.errors} failed` : ''),
      tone: counts.errors > 0 ? 'err' : undefined,
    });
  return facts;
}
