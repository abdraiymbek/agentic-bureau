import { describe, expect, it } from 'vitest';
import type { AdapterStatus, SessionInfo } from '@omenflow/contracts';
import {
  elapsedLabel,
  latestCounts,
  profileLabel,
  sessionFacts,
  sessionStatus,
} from '../../apps/desktop/src/renderer/shell/agent/session-view';
import {
  adapterRowView,
  argsHint,
  formatArgs,
  modelAndProfileInput,
  needsRestart,
  openscadProbe,
  parseArgs,
  parseEnv,
  resolvedProfileText,
  testSteps,
} from '../../apps/desktop/src/renderer/shell/agent/adapter-view';
import { surfacePhase, autostartAdapter } from '../../apps/desktop/src/renderer/shell/agent/phase';
import {
  offersStarters,
  starterPrompts,
} from '../../apps/desktop/src/renderer/shell/agent/starters';

const base: AdapterStatus = {
  adapterId: 'codex',
  label: 'Codex CLI',
  available: true,
  executablePath: '/Users/me/.local/bin/codex',
  version: '0.156.1',
  testedVersionRange: null,
  recognizedVersion: true,
  capabilities: { mcp: true, cli: true, resume: false },
  lastTestAt: null,
  lastTestOk: null,
  lastError: null,
  installHint: 'Install Codex CLI or set an executable path.',
};

const v1: AdapterStatus = {
  ...base,
  model: 'gpt-6-luna',
  profile: 'auto',
  resolvedProfile: 'compact',
  models: [
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', tier: 'compact' },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', tier: 'full' },
  ],
  verified: true,
  docsUrl: 'https://example.org/codex',
  guideChannels: ['mcp-instructions'],
};

const session: SessionInfo = {
  id: 's1',
  adapterId: 'codex',
  executablePath: '/bin/codex',
  state: 'running',
  pid: 4,
  exitCode: null,
  cols: 120,
  rows: 40,
  startedAt: '2026-10-13T10:00:00.000Z',
  endedAt: null,
  waitingForReview: false,
  lastError: null,
};

describe('session words', () => {
  it('labels the profile with where it came from', () => {
    expect(profileLabel('compact', 'model')).toBe('Compact · from model');
    expect(profileLabel('full', 'user')).toBe('Full · your setting');
    expect(profileLabel('standard', 'adapter-default')).toBe('Standard · adapter default');
    expect(profileLabel('standard', undefined)).toBe('Standard');
    expect(profileLabel(undefined, 'model')).toBeNull();
  });

  it('pulses only while running and reports exit codes as recorded', () => {
    expect(sessionStatus(session)).toMatchObject({ word: 'Running', live: true, over: false });
    expect(sessionStatus({ ...session, state: 'starting' })).toMatchObject({
      live: false,
      over: false,
    });
    expect(sessionStatus({ ...session, state: 'exited', exitCode: 0 })).toMatchObject({
      word: 'Ended',
      tone: 'neutral',
      over: true,
      exit: 'exit code 0',
    });
    expect(sessionStatus({ ...session, state: 'exited', exitCode: 2 }).tone).toBe('err');
    expect(sessionStatus({ ...session, state: 'exited' }).exit).toBeNull();
    expect(sessionStatus(null)).toMatchObject({ word: 'Not started', live: false });
  });

  it('formats elapsed time and leaves an unrecorded start unknown', () => {
    const start = '2026-10-13T10:00:00.000Z';
    const at = (s: number) => Date.parse(start) + s * 1000;
    expect(elapsedLabel(start, null, at(42))).toBe('42 s');
    expect(elapsedLabel(start, null, at(4 * 60 + 5))).toBe('4 min');
    expect(elapsedLabel(start, null, at(72 * 60))).toBe('1 h 12 min');
    expect(elapsedLabel(start, '2026-10-13T11:00:00.000Z', at(99999))).toBe('1 h');
    expect(elapsedLabel(null, null, at(1))).toBeNull();
    expect(elapsedLabel('not a time', null, at(1))).toBeNull();
  });

  it('omits every fact the host did not report', () => {
    expect(sessionFacts(session)).toEqual([]);
    const full = {
      ...session,
      model: 'gpt-6-luna',
      profile: 'compact' as const,
      profileSource: 'model' as const,
      toolCount: 13,
      calls: 4,
      errors: 1,
    };
    expect(sessionFacts(full).map((f) => f.value)).toEqual([
      'gpt-6-luna',
      'Compact · from model',
      '13 tools',
      '4 calls · 1 failed',
    ]);
    // The ledger can be ahead of the last session snapshot; the counts come as one pair.
    expect(sessionFacts(full, { calls: 7, errors: 2 }).at(-1)!.value).toBe('7 calls · 2 failed');
    expect(sessionFacts(full, { calls: 2, errors: 2 }).at(-1)!.value).toBe('4 calls · 1 failed');
    expect(sessionFacts(session, { calls: 1, errors: 0 }).map((f) => f.value)).toEqual(['1 call']);
    expect(latestCounts({ calls: 3, errors: 0 }, null)).toEqual({ calls: 3, errors: 0 });
    expect(latestCounts({}, null)).toBeNull();
  });
});

describe('adapter row', () => {
  it('says whether this build verified the launch path, and only when the host says', () => {
    expect(adapterRowView(v1).verification).toEqual({
      word: 'Verified with this build',
      verified: true,
    });
    expect(adapterRowView({ ...v1, verified: false }).verification?.word).toBe(
      'Documented, not verified here',
    );
    // Nothing documents a custom CLI, and the hint names where the person sets it.
    const custom = adapterRowView({
      ...v1,
      adapterId: 'custom',
      verified: false,
      installHint: 'Set an executable path via connection.configure.',
    });
    expect(custom.verification?.word).toBe('Not verified here');
    expect(custom.installHint).toBe('Set its executable path under Configure.');
    expect(adapterRowView(base).verification).toBeNull();
    expect(adapterRowView(base).profile).toBeNull();
    expect(adapterRowView(base).models).toEqual([]);
  });

  it('names model tiers in words', () => {
    expect(adapterRowView(v1).models).toEqual([
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', tier: 'Compact tier' },
      { id: 'gpt-6-sol', label: 'GPT-6 Sol', tier: 'Full tier' },
    ]);
  });

  it('lists Claude models by full id, so a saved alias the host canonicalised shows as listed', () => {
    // connection.list reports a saved `haiku` as the full id it launches.
    const claude: AdapterStatus = {
      ...v1,
      adapterId: 'claude-code',
      label: 'Claude Code',
      model: 'claude-haiku-5-5',
      models: [
        { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', tier: 'full' },
        { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', tier: 'full' },
        { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', tier: 'standard' },
        { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', tier: 'compact' },
      ],
    };
    const row = adapterRowView(claude);
    expect(row.models.map((m) => m.id)).toContain(claude.model);
    expect(row.models.at(-1)).toEqual({
      id: 'claude-haiku-5-5',
      label: 'Claude Haiku 5.5',
      tier: 'Compact tier',
    });
    const running = {
      adapterId: 'claude-code',
      state: 'running',
      model: 'claude-haiku-5-5',
      profile: 'compact' as const,
    };
    expect(
      needsRestart(running, 'claude-code', {
        model: 'claude-haiku-5-5',
        resolvedProfile: 'compact',
      }),
    ).toBe(false);
  });

  it('saves a model only when the person picked another, so a saved alias survives other changes', () => {
    // The host lists a saved `haiku` as `claude-haiku-5-5`; saving a new profile or environment
    // must not write that id over the alias the person's routing may depend on.
    const row = adapterRowView({ ...v1, adapterId: 'claude-code', model: 'claude-haiku-5-5' });
    expect(modelAndProfileInput(row, { model: 'claude-haiku-5-5', profile: 'auto' })).toEqual({
      profile: 'auto',
    });
    expect(modelAndProfileInput(row, { model: 'claude-sonnet-5-5', profile: 'full' })).toEqual({
      model: 'claude-sonnet-5-5',
      profile: 'full',
    });
    // Choosing the CLI default clears the saved model.
    expect(modelAndProfileInput(row, { model: null, profile: 'auto' })).toEqual({
      model: null,
      profile: 'auto',
    });
    // A host that predates profiles is sent neither.
    expect(modelAndProfileInput(adapterRowView(base), { model: 'x', profile: 'auto' })).toEqual({});
  });

  it('flags an unrecognised version only for a detected built-in CLI', () => {
    expect(adapterRowView({ ...base, recognizedVersion: false }).versionUnrecognised).toBe(true);
    expect(
      adapterRowView({ ...base, available: false, recognizedVersion: false }).versionUnrecognised,
    ).toBe(false);
    expect(
      adapterRowView({ ...base, adapterId: 'custom', recognizedVersion: false })
        .versionUnrecognised,
    ).toBe(false);
  });

  it('shows the resolved profile without guessing for models the host has not resolved', () => {
    expect(resolvedProfileText(v1, { model: 'gpt-6-luna', profile: 'auto' })).toBe(
      'Automatic → Compact for this model',
    );
    expect(resolvedProfileText(v1, { model: 'gpt-6-sol', profile: 'auto' })).toBe(
      'Automatic → Full for this model',
    );
    expect(resolvedProfileText(v1, { model: 'my-local:7b', profile: 'auto' })).toBe(
      'Automatic → decided by the host when you save',
    );
    expect(
      resolvedProfileText(
        { ...v1, model: null, resolvedProfile: 'standard' },
        { model: null, profile: 'auto' },
      ),
    ).toBe('Automatic → Standard for the CLI’s default model');
    expect(resolvedProfileText(v1, { model: 'gpt-6-luna', profile: 'full' })).toBe(
      'Full for every model',
    );
  });

  it('offers a restart only when the running session differs from what was saved', () => {
    const live = {
      adapterId: 'codex',
      state: 'running',
      model: 'gpt-6-luna',
      profile: 'compact' as const,
    };
    expect(needsRestart(live, 'codex', { model: 'gpt-6-luna', resolvedProfile: 'compact' })).toBe(
      false,
    );
    expect(needsRestart(live, 'codex', { model: 'gpt-6-sol', resolvedProfile: 'full' })).toBe(true);
    expect(needsRestart(live, 'codex', { model: 'gpt-6-luna', resolvedProfile: 'full' })).toBe(
      true,
    );
    expect(needsRestart(live, 'claude-code', { model: null })).toBe(false);
    expect(needsRestart({ ...live, state: 'exited' }, 'codex', { model: 'x' })).toBe(false);
    expect(needsRestart(null, 'codex', { model: 'x' })).toBe(false);
  });

  it('reads connection test steps, and labels a single outcome for what it exercised', () => {
    expect(
      testSteps({
        ok: false,
        steps: [
          { label: 'Version probe', ok: true, detail: 'codex-cli 0.156.1' },
          { name: 'Bridge round trip', ok: false, error: 'socket refused' },
          {},
        ],
      }),
    ).toEqual({
      ok: false,
      steps: [
        { label: 'Version probe', ok: true, detail: 'codex-cli 0.156.1' },
        { label: 'Bridge round trip', ok: false, detail: 'socket refused' },
        { label: 'Step 3', ok: null, detail: null },
      ],
    });
    expect(testSteps({ ok: true, detail: 'bridge ok · Codex CLI' })).toEqual({
      ok: true,
      steps: [{ label: 'Bridge round trip', ok: true, detail: 'bridge ok · Codex CLI' }],
    });
    expect(testSteps({ ok: false }).steps[0]!.detail).toBe('The host gave no reason.');
  });

  it('splits arguments like a shell and refuses an open quote', () => {
    expect(parseArgs('--model "gpt 6" --flag')).toEqual(['--model', 'gpt 6', '--flag']);
    expect(parseArgs("--name 'my agent' a\\ b")).toEqual(['--name', 'my agent', 'a b']);
    expect(parseArgs('--empty ""')).toEqual(['--empty', '']);
    expect(parseArgs('  ')).toEqual([]);
    expect(parseArgs('--x "open')).toBeNull();
  });

  it('shows a custom CLI’s saved arguments once the host reports them, and reads them defensively', () => {
    const custom = { ...base, adapterId: 'custom', label: 'Custom CLI' };
    const saved = adapterRowView({
      ...custom,
      args: ['-i', '--name', 'my agent', 'say "hi"'],
    } as AdapterStatus);
    expect(saved.savedArgs).toBe('-i --name "my agent" "say \\"hi\\""');
    expect(parseArgs(saved.savedArgs!)).toEqual(['-i', '--name', 'my agent', 'say "hi"']);
    expect(argsHint(saved)).toMatch(/^Saved: -i --name "my agent" .*Leave empty to keep them\./);
    expect(argsHint(adapterRowView({ ...custom, args: [] } as AdapterStatus))).toMatch(
      /^No arguments are saved\./,
    );
    // An older host says nothing about them, and a malformed answer is not shown as saved.
    for (const args of [undefined, 'x', [1, 2], null]) {
      const v = adapterRowView({ ...custom, args } as unknown as AdapterStatus);
      expect(v.savedArgs).toBeNull();
      expect(argsHint(v)).toMatch(/^Leave empty to keep the saved arguments\./);
    }
    // Only the custom CLI takes arguments here.
    expect(adapterRowView({ ...base, args: ['-x'] } as AdapterStatus).savedArgs).toBeNull();
    expect(parseArgs(formatArgs(['', 'a\\b', "it's"]))).toEqual(['', 'a\\b', "it's"]);
  });

  it('parses KEY=VALUE lines and names the line that is wrong', () => {
    expect(parseEnv('A=1\n\nB = two=2\n')).toEqual({ env: { A: '1', B: ' two=2' } });
    expect(parseEnv('A=1\nnot a pair')).toEqual({ error: 'Line 2 needs KEY=VALUE.' });
    expect(parseEnv('=x')).toEqual({ error: 'Line 1 needs KEY=VALUE.' });
  });

  it('reads the OpenSCAD probe as reported', () => {
    expect(
      openscadProbe({
        openscad: { available: true, version: '2021.01', executablePath: '/bin/openscad' },
      }),
    ).toEqual({ available: true, version: '2021.01', path: '/bin/openscad', error: null });
    expect(openscadProbe({ openscad: { available: false, error: 'OpenSCAD not found' } })).toEqual({
      available: false,
      version: null,
      path: null,
      error: 'OpenSCAD not found',
    });
    expect(openscadProbe({})).toBeNull();
  });
});

describe('surface phase', () => {
  const input = {
    readOnly: false,
    session: null,
    adapters: [base, { ...base, adapterId: 'claude-code', label: 'Claude Code', available: false }],
    detection: { status: 'ready' as const },
    start: { status: 'idle' as const },
    agentId: null,
  };

  it('says it is looking while detection runs, never "not found"', () => {
    expect(surfacePhase({ ...input, adapters: [], detection: { status: 'detecting' } }).kind).toBe(
      'detecting',
    );
    const offline = input.adapters.map((a) => ({ ...a, available: false }));
    expect(
      surfacePhase({ ...input, adapters: offline, detection: { status: 'detecting' } }).kind,
    ).toBe('detecting');
    expect(surfacePhase({ ...input, adapters: offline }).kind).toBe('none-found');
    expect(
      surfacePhase({ ...input, adapters: [], detection: { status: 'failed', error: 'x' } }),
    ).toEqual({
      kind: 'detect-failed',
      error: 'x',
    });
  });

  it('starts on its own only for an unambiguous choice', () => {
    expect(autostartAdapter(surfacePhase(input))).toBe('codex');
    const both = input.adapters.map((a) => ({ ...a, available: true }));
    expect(surfacePhase({ ...input, adapters: both }).kind).toBe('choose');
    expect(
      autostartAdapter(surfacePhase({ ...input, adapters: both, agentId: 'claude-code' })),
    ).toBe('claude-code');
    const missing = surfacePhase({ ...input, agentId: 'claude-code' });
    expect(missing.kind).toBe('choose');
    expect(missing.kind === 'choose' && missing.missing?.adapterId).toBe('claude-code');
  });

  it('waits for a running conversation response instead of starting a terminal', () => {
    const busy = surfacePhase({ ...input, conversationRunning: true });
    expect(busy.kind).toBe('conversation-running');
    expect(autostartAdapter(busy)).toBeNull();
    const ended = { state: 'exited', adapterId: 'codex' } as const;
    expect(surfacePhase({ ...input, session: ended, conversationRunning: true }).kind).toBe(
      'conversation-running',
    );
    // A live terminal is shown as live; the host refuses the second agent either way.
    const live = { state: 'running', adapterId: 'codex' } as const;
    expect(surfacePhase({ ...input, session: live, conversationRunning: true }).kind).toBe('live');
  });

  it('shows a failed start even over an ended transcript, and never autostarts after an end', () => {
    const ended = { state: 'exited' as const, adapterId: 'codex' };
    expect(surfacePhase({ ...input, session: ended }).kind).toBe('ended');
    expect(autostartAdapter(surfacePhase({ ...input, session: ended }))).toBeNull();
    expect(
      surfacePhase({
        ...input,
        session: ended,
        start: { status: 'failed', adapterId: 'codex', error: 'spawn failed' },
      }),
    ).toEqual({ kind: 'start-failed', adapterId: 'codex', error: 'spawn failed' });
    expect(surfacePhase({ ...input, session: { state: 'running', adapterId: 'codex' } }).kind).toBe(
      'live',
    );
    expect(surfacePhase({ ...input, readOnly: true }).kind).toBe('read-only');
  });
});

describe('starter prompts', () => {
  const view = (id: string, title: string, freshness: 'current' | 'stale' | 'missing_input') => ({
    artifact: {
      id,
      type: 'calculation' as const,
      title,
      subsystem: null,
      selectedRevisionId: null,
      archived: false,
      createdAt: '',
    },
    revision: null,
    freshness,
    staleReasons: [],
    draftCount: 0,
    pendingProposal: false,
  });

  it('starts an empty project from its intent', () => {
    const [first] = starterPrompts({ intent: 'An inspection rover under 2 kg.' }, [], []);
    expect(first!.label).toBe('Draft the first requirements');
    expect(first!.text).toContain('Intent: An inspection rover under 2 kg.');
  });

  it('lists precise references for what waits on the agent', () => {
    const starters = starterPrompts(
      { intent: '' },
      [view('a1', 'Rover mass budget', 'stale'), view('a2', 'Wheel torque', 'current')],
      [
        {
          id: 'p1',
          reason: 'Increase payload',
          state: 'changes_requested',
        } as never,
      ],
    );
    expect(starters.map((s) => s.label)).toEqual([
      'Address requested changes: Increase payload',
      'Bring 1 out-of-date object up to date',
    ]);
    expect(starters[1]!.text).toContain('Rover mass budget (calculation, artifact a1)');
    expect(starters[1]!.text).not.toContain('Wheel torque');
  });

  it('offers starters only while a live session waits for its first instruction', () => {
    const fresh = {
      sessionId: 's1',
      live: true,
      hasInput: false,
      waiting: 0,
      calls: 0,
      dismissed: null,
    };
    expect(offersStarters(fresh)).toBe(true);
    // The launcher brief was typed into the input, or still waits to be.
    expect(offersStarters({ ...fresh, hasInput: true })).toBe(false);
    expect(offersStarters({ ...fresh, waiting: 1 })).toBe(false);
    expect(offersStarters({ ...fresh, calls: 2 })).toBe(false);
    expect(offersStarters({ ...fresh, dismissed: 's1' })).toBe(false);
    expect(offersStarters({ ...fresh, dismissed: 's0' })).toBe(true);
    expect(offersStarters({ ...fresh, live: false })).toBe(false);
    expect(offersStarters({ ...fresh, sessionId: null })).toBe(false);
  });

  it('offers nothing for a current project with nothing returned', () => {
    expect(starterPrompts({ intent: 'x' }, [view('a', 'A', 'current')], [])).toEqual([]);
  });
});
