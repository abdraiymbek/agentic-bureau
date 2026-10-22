/**
 * The Settings row and onboarding entry for one adapter, derived from `connection.list` alone.
 * V1 fields may be missing from older hosts; a missing field becomes a missing line, not a default.
 */
import type { AdapterStatus, CapabilityProfile, ProfileSetting } from '@omenflow/contracts';
import type { Tone } from '../../ui/kit';
import { PROFILE_WORDS } from './session-view';

export const PROFILE_CHOICES: { value: ProfileSetting; label: string; explain: string }[] = [
  {
    value: 'auto',
    label: 'Automatic',
    explain: 'Chosen from the launch model: small models get Compact, the largest get Full.',
  },
  {
    value: 'compact',
    label: 'Compact',
    explain: 'Fifteen core tools and the CAD playbook in its brief, for small and local models.',
  },
  {
    value: 'standard',
    label: 'Standard',
    explain: 'The everyday engineering tools, for mid-size models.',
  },
  { value: 'full', label: 'Full', explain: 'Every agent tool, for the most capable models.' },
];

export interface ModelOption {
  id: string;
  label: string;
  /** "Compact tier" — the profile Automatic resolves to for this model, in words. */
  tier: string;
}

export interface AdapterRowView {
  id: string;
  label: string;
  available: boolean;
  availability: { word: string; tone: Tone };
  version: string | null;
  /** Detected on this machine but outside the versions this build recognises. */
  versionUnrecognised: boolean;
  path: string | null;
  /** Null when the host does not say. */
  verification: { word: string; verified: boolean } | null;
  models: ModelOption[];
  /** The configured launch model; null leaves the choice to the CLI. */
  model: string | null;
  /** The person's profile setting; null when the host predates profiles. */
  profile: ProfileSetting | null;
  docsUrl: string | null;
  installHint: string | null;
  lastError: string | null;
  lastTest: { ok: boolean; at: string | null } | null;
  canResume: boolean;
  /**
   * The custom CLI's saved arguments, as an argument line that parses back to them; null when the
   * host does not report them (it is then unknown what is saved, not "none").
   */
  savedArgs: string | null;
}

/** Arguments the host reports as saved, when it reports them as a list of strings. */
function reportedArgs(a: AdapterStatus): string[] | null {
  const args = (a as { args?: unknown }).args;
  return Array.isArray(args) && args.every((x) => typeof x === 'string') ? args : null;
}

/** What the custom CLI's arguments field says about what is saved. */
export function argsHint(v: Pick<AdapterRowView, 'path' | 'savedArgs'>): string {
  const quoting = 'Quote an argument that contains spaces: --name "my agent".';
  if (v.savedArgs !== null)
    return `${v.savedArgs ? `Saved: ${v.savedArgs}. Leave empty to keep them.` : 'No arguments are saved.'} ${quoting}`;
  // An older host does not say what is saved, so nothing is claimed about it.
  return `${v.path ? 'Leave empty to keep the saved arguments. ' : ''}${quoting}`;
}

/** An argument list as one line `parseArgs` reads back to the same list. */
export function formatArgs(args: string[]): string {
  return args
    .map((arg) => (arg && !/[\s"'\\]/.test(arg) ? arg : `"${arg.replace(/["\\]/g, '\\$&')}"`))
    .join(' ');
}

export function adapterRowView(a: AdapterStatus): AdapterRowView {
  const args = a.adapterId === 'custom' ? reportedArgs(a) : null;
  return {
    id: a.adapterId,
    label: a.label,
    available: a.available,
    availability: a.available
      ? { word: 'Detected', tone: 'ok' }
      : { word: 'Not detected', tone: 'neutral' },
    version: a.version,
    versionUnrecognised: a.available && a.adapterId !== 'custom' && a.recognizedVersion === false,
    path: a.executablePath,
    verification:
      typeof a.verified === 'boolean'
        ? a.verified
          ? { word: 'Verified with this build', verified: true }
          : // A custom CLI is whatever the person points it at: nothing documents it.
            {
              word:
                a.adapterId === 'custom' ? 'Not verified here' : 'Documented, not verified here',
              verified: false,
            }
        : null,
    models: (a.models ?? []).map((m) => ({
      id: m.id,
      label: m.label,
      tier: `${PROFILE_WORDS[m.tier] ?? m.tier} tier`,
    })),
    model: a.model ?? null,
    profile: a.profile ?? null,
    docsUrl: a.docsUrl ?? null,
    // The host names its own operation; in the interface the path is set under Configure.
    installHint:
      a.adapterId === 'custom' ? 'Set its executable path under Configure.' : a.installHint,
    lastError: a.lastError,
    lastTest: typeof a.lastTestOk === 'boolean' ? { ok: a.lastTestOk, at: a.lastTestAt } : null,
    canResume: a.capabilities?.resume === true,
    savedArgs: args ? formatArgs(args) : null,
  };
}

/**
 * What a session started now would get, in words. Only the host resolves `auto` for a model it
 * has not listed, so an unsaved free-text model says that rather than guessing.
 */
export function resolvedProfileText(
  a: Pick<AdapterStatus, 'model' | 'profile' | 'resolvedProfile' | 'models'>,
  draft: { model: string | null; profile: ProfileSetting },
): string {
  if (draft.profile !== 'auto') return `${PROFILE_WORDS[draft.profile]} for every model`;
  const saved = (a.model ?? null) === draft.model && (a.profile ?? 'auto') === 'auto';
  const who = draft.model ? 'this model' : 'the CLI’s default model';
  if (saved && a.resolvedProfile)
    return `Automatic → ${PROFILE_WORDS[a.resolvedProfile]} for ${who}`;
  const listed = draft.model ? a.models?.find((m) => m.id === draft.model) : undefined;
  if (listed) return `Automatic → ${PROFILE_WORDS[listed.tier]} for this model`;
  return 'Automatic → decided by the host when you save';
}

/**
 * The model and profile part of what Settings saves. The host lists a saved alias as the id it
 * launches (`claude-haiku-5-5` for `haiku`), so the model goes only when the person picked another:
 * saving anything else keeps the alias, which their own model routing may depend on.
 */
export function modelAndProfileInput(
  v: Pick<AdapterRowView, 'model' | 'profile'>,
  draft: { model: string | null; profile: ProfileSetting },
): { model?: string | null; profile?: ProfileSetting } {
  if (v.profile === null) return {};
  return draft.model === v.model
    ? { profile: draft.profile }
    : { model: draft.model, profile: draft.profile };
}

/** A configuration change that a running session on this adapter would only pick up on restart. */
export function needsRestart(
  session: {
    adapterId: string;
    state: string;
    model?: string | null;
    profile?: CapabilityProfile;
  } | null,
  adapterId: string,
  saved: { model: string | null; resolvedProfile?: CapabilityProfile },
): boolean {
  if (!session || session.adapterId !== adapterId) return false;
  if (session.state !== 'running' && session.state !== 'starting') return false;
  if (session.model !== undefined && (session.model ?? null) !== saved.model) return true;
  return (
    session.profile !== undefined &&
    saved.resolvedProfile !== undefined &&
    session.profile !== saved.resolvedProfile
  );
}

export interface TestStep {
  label: string;
  ok: boolean | null;
  detail: string | null;
}

/**
 * Steps of a connection test. Hosts that report steps list each one; older hosts answer with a
 * single outcome, shown as one step labelled for what it actually exercised.
 */
export function testSteps(result: unknown): { ok: boolean; steps: TestStep[] } {
  const r = (result ?? {}) as {
    ok?: unknown;
    error?: unknown;
    detail?: unknown;
    steps?: unknown;
  };
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const ok = r.ok === true;
  if (Array.isArray(r.steps) && r.steps.length) {
    const steps = r.steps.map((raw, i): TestStep => {
      const s = (raw ?? {}) as Record<string, unknown>;
      return {
        label: text(s.label) ?? text(s.name) ?? text(s.id) ?? `Step ${i + 1}`,
        ok: typeof s.ok === 'boolean' ? s.ok : null,
        detail: text(s.detail) ?? text(s.error) ?? text(s.message),
      };
    });
    return { ok, steps };
  }
  return {
    ok,
    steps: [
      {
        label: 'Bridge round trip',
        ok,
        detail: ok
          ? text(r.detail)
          : (text(r.error) ?? text(r.detail) ?? 'The host gave no reason.'),
      },
    ],
  };
}

/**
 * Split an argument line the way a shell would for plain words and quotes: "two words" and
 * 'two words' stay one argument, a backslash escapes the next character. Returns null when a
 * quote is left open, so a half-typed line is never saved as something else.
 */
export function parseArgs(line: string): string[] | null {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) current += line[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === '\\' && i + 1 < line.length) {
      current += line[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) return null;
  if (started) args.push(current);
  return args;
}

/** KEY=VALUE lines. Blank lines are skipped; a line without "=" or with an empty key is an error. */
export function parseEnv(text: string): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {};
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.trim();
    if (!line) continue;
    const at = line.indexOf('=');
    const key = at > 0 ? line.slice(0, at).trim() : '';
    if (!key) return { error: `Line ${n + 1} needs KEY=VALUE.` };
    env[key] = line.slice(at + 1);
  }
  return { env };
}

export interface ToolProbe {
  available: boolean;
  version: string | null;
  path: string | null;
  error: string | null;
}

/**
 * The STEP converter entry of `tool.doctor` (a Python that imports OCP), or null when the host
 * did not probe it.
 */
export function pythonProbe(
  results: unknown,
): (ToolProbe & { ocp: string | null; note: string | null }) | null {
  const entry = (results as { python?: Record<string, unknown> } | null)?.python;
  if (!entry || typeof entry !== 'object') return null;
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    available: entry.available === true,
    version: text(entry.version),
    path: text(entry.executablePath),
    error: text(entry.error),
    ocp: text(entry.ocp),
    note: text(entry.note),
  };
}

/** The OpenSCAD entry of `tool.doctor`, or null when the host did not probe it. */
export function openscadProbe(results: unknown): ToolProbe | null {
  const entry = (results as { openscad?: Record<string, unknown> } | null)?.openscad;
  if (!entry || typeof entry !== 'object') return null;
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    available: entry.available === true,
    version: text(entry.version),
    path: text(entry.executablePath) ?? text(entry.path),
    error: text(entry.error),
  };
}
