import React, { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowClockwise, Cube, FolderOpen, Play, TerminalWindow, X } from '../ui/icons';
import type { AdapterStatus, ProfileSetting } from '@bureau/contracts';
import { preferredAdapter, useStore } from '../store';
import { restartAgent, startAgent } from '../lib/actions';
import {
  Button,
  Disclosure,
  Field,
  IconButton,
  Mark,
  Notice,
  Segmented,
  Skeleton,
  Spinner,
  State,
} from '../ui/kit';
import { ExternalLink } from '../ui/ExternalLink';
import {
  adapterRowView,
  argsHint,
  modelAndProfileInput,
  needsRestart,
  openscadProbe,
  parseArgs,
  parseEnv,
  PROFILE_CHOICES,
  resolvedProfileText,
  testSteps,
  type TestStep,
  type ToolProbe,
} from './agent/adapter-view';
import { SETTINGS_SECTIONS, useAgentUi, type SettingsSection } from './agent/agent-store';
import { detectAgents } from './agent/feed';
import { errorText, quiet } from './agent/quiet';
import { adapterLabel, profileLabel, sessionStatus } from './agent/session-view';
import { StepConverterTool } from './StepConverter';

/** Agents, engineering tools, and appearance. One sheet, never a destination. */
export function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const set = useStore((s) => s.set);
  const section = useAgentUi((s) => s.settingsSection);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const choose = (next: SettingsSection) => useAgentUi.getState().setSettingsSection(next);
  return (
    <Dialog.Root open={open} onOpenChange={(v) => set({ settingsOpen: v })}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay motion-fade" />
        <Dialog.Content className="sheet motion-sheet" aria-describedby={undefined}>
          <header className="sheet-head">
            <Dialog.Title>Settings</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Close settings (esc)">
                <X size={15} />
              </IconButton>
            </Dialog.Close>
          </header>
          <div className="sheet-tabs" role="tablist" aria-label="Settings sections">
            {SETTINGS_SECTIONS.map((s, i) => (
              <button
                key={s.id}
                ref={(el) => {
                  tabs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`settings-tab-${s.id}`}
                aria-selected={section === s.id}
                aria-controls="settings-panel"
                tabIndex={section === s.id ? 0 : -1}
                onClick={() => choose(s.id)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                  e.preventDefault();
                  const n = SETTINGS_SECTIONS.length;
                  const next = (i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
                  choose(SETTINGS_SECTIONS[next]!.id);
                  tabs.current[next]?.focus();
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
          {open && (
            <div
              className="sheet-body"
              role="tabpanel"
              id="settings-panel"
              aria-labelledby={`settings-tab-${section}`}
            >
              {section === 'agents' && <AgentsSection />}
              {section === 'tools' && <ToolsSection />}
              {section === 'appearance' && <AppearanceSection />}
              <footer className="sheet-foot">
                <Mark size={14} />
                <span>Bureau · local by design. Your record lives in the project folder.</span>
              </footer>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ------------------------------------------------------------------ */
/* Agents                                                               */
/* ------------------------------------------------------------------ */

function AgentsSection() {
  const adapters = useStore((s) => s.adapters);
  const session = useStore((s) => s.session);
  const agentId = useStore((s) => s.agentId);
  const setAgent = useStore((s) => s.setAgent);
  const detection = useAgentUi((s) => s.detection);
  const chosen = preferredAdapter(adapters, agentId);
  const status = sessionStatus(session);
  const running = status.live || session?.state === 'starting' ? session : null;

  useEffect(() => {
    void detectAgents();
  }, []);

  return (
    <section className="sheet-section">
      <div className="sheet-section-head">
        <h3>Agents</h3>
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowClockwise size={13} />}
          busy={detection.status === 'detecting'}
          onClick={() => void detectAgents()}
        >
          Detect again
        </Button>
      </div>
      <p className="sheet-lede">
        Bring the agent CLI you already use. The chosen agent runs in the Agent tab in this
        project’s folder; its structured changes arrive as proposals for you to decide. The
        Conversation pane runs Codex CLI or Claude Code once per message; the Terminal pane runs any
        of them interactively. One agent works in a project at a time.
      </p>
      {detection.status === 'failed' && (
        <Notice tone="err" role="alert">
          Could not check for agent CLIs: {detection.error}
        </Notice>
      )}
      {!adapters.length && detection.status === 'detecting' && (
        <div className="adapter-list adapter-loading" role="status">
          <span className="row">
            <Spinner /> Looking for agent CLIs…
          </span>
          <Skeleton lines={3} />
        </div>
      )}
      {adapters.length > 0 && (
        <div className="adapter-list" role="radiogroup" aria-label="Agent">
          {adapters.map((a) => (
            <AdapterRow
              key={a.adapterId}
              adapter={a}
              checked={chosen?.adapterId === a.adapterId}
              onChoose={() => setAgent(a.adapterId)}
            />
          ))}
        </div>
      )}
      <ContinueSetting />
      {running && chosen && running.adapterId !== chosen.adapterId && (
        <RestartNote
          text={`${adapterLabel(adapters, running.adapterId)} is running now. ${chosen.label} starts the next time the agent starts.`}
          action={`Restart with ${chosen.label}`}
          disabled={!chosen.available}
          adapterId={chosen.adapterId}
        />
      )}
      <p className="sheet-note">
        <TerminalWindow size={13} />
        {session
          ? `${adapterLabel(adapters, session.adapterId)} · ${status.word}${
              profileLabel(session.profile, session.profileSource)
                ? ` · ${profileLabel(session.profile, session.profileSource)}`
                : ''
            }`
          : 'No agent session in this project'}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Unfinished work after a conversation response                        */
/* ------------------------------------------------------------------ */

/**
 * Whether Bureau continues unfinished work once by itself (`conversation.autoContinue`,
 * off unless set). The host reads it when a response ends.
 */
function ContinueSetting() {
  const toast = useStore((s) => s.toast);
  const [value, setValue] = useState<'offer' | 'once' | null>(null);
  useEffect(() => {
    let alive = true;
    void quiet<{ value: unknown }>('settings.get', { key: 'conversation.autoContinue' }).then(
      (r) => {
        if (alive) setValue(r.ok && r.result.value === true ? 'once' : 'offer');
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  const choose = async (next: 'offer' | 'once') => {
    const before = value;
    setValue(next);
    const r = await quiet('settings.set', {
      key: 'conversation.autoContinue',
      value: next === 'once',
    });
    if (!r.ok) {
      setValue(before);
      toast('error', errorText(r.error));
    }
  };
  return (
    <div className="setting-row">
      <div>
        <strong>Unfinished work after a response</strong>
        <small>
          When work_status reports blockers, the response offers Continue. Continue once also sends
          one continuation by itself per message you send, when a blocker is the agent's to resolve
          from the project record, labelled as sent by Bureau; it runs the agent again and spends
          model credits.
        </small>
      </div>
      {value === null ? (
        <Spinner />
      ) : (
        <Segmented
          label="Unfinished work after a response"
          value={value}
          onChange={(next) => void choose(next)}
          options={[
            { value: 'offer', label: 'Offer Continue' },
            { value: 'once', label: 'Continue once' },
          ]}
        />
      )}
    </div>
  );
}

function RestartNote({
  text,
  action,
  disabled,
  adapterId,
}: {
  text: string;
  action: string;
  disabled?: boolean;
  adapterId?: string;
}) {
  const start = useAgentUi((s) => s.start);
  const [error, setError] = useState<string | null>(null);
  const restart = async () => {
    setError(null);
    try {
      if (adapterId) await startAgent(adapterId);
      else await restartAgent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="sheet-note restart-note" role="status">
      <TerminalWindow size={13} />
      <span className="grow">{text}</span>
      <Button
        size="sm"
        disabled={disabled}
        busy={start.status === 'starting'}
        onClick={() => void restart()}
      >
        {action}
      </Button>
      {error && <span className="adapter-note tone-err">{error}</span>}
    </div>
  );
}

/** Select value for "another model id"; not a value any CLI accepts as a model. */
const OTHER_MODEL = '\u0000other';

function AdapterRow({
  adapter,
  checked,
  onChoose,
}: {
  adapter: AdapterStatus;
  checked: boolean;
  onChoose: () => void;
}) {
  const v = adapterRowView(adapter);
  const session = useStore((s) => s.session);
  const projectId = useStore((s) => s.projectId);
  const readOnly = useStore((s) => s.readOnly);
  const [open, setOpen] = useState(checked);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; steps: TestStep[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedChange, setSavedChange] = useState(false);
  const knowsProfiles = v.profile !== null;
  const listed = v.models.some((m) => m.id === v.model);
  const [model, setModel] = useState<string>(
    v.model === null ? '' : listed ? v.model : OTHER_MODEL,
  );
  const [customModel, setCustomModel] = useState(v.model !== null && !listed ? v.model : '');
  const [profile, setProfile] = useState<ProfileSetting>(v.profile ?? 'auto');
  const [path, setPath] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const custom = v.id === 'custom';

  const draftModel = model === OTHER_MODEL ? customModel.trim() || null : model || null;
  const parsedArgs = args.trim() ? parseArgs(args) : [];
  const parsedEnv = env.trim() ? parseEnv(env) : { env: {} };
  const invalid =
    parsedArgs === null
      ? 'An argument has an unclosed quote.'
      : 'error' in parsedEnv
        ? parsedEnv.error
        : custom && !path.trim() && !v.path
          ? 'A custom agent needs an executable path.'
          : null;
  const dirty =
    (knowsProfiles && (draftModel !== v.model || profile !== (v.profile ?? 'auto'))) ||
    !!path.trim() ||
    !!args.trim() ||
    !!env.trim();

  const save = async () => {
    if (invalid) return;
    setSaving(true);
    setSaveError(null);
    const r = await quiet('connection.configure', {
      adapterId: v.id,
      ...modelAndProfileInput(v, { model: draftModel, profile }),
      ...(path.trim() ? { executablePath: path.trim() } : {}),
      ...(args.trim() && parsedArgs ? { args: parsedArgs } : {}),
      ...(env.trim() && 'env' in parsedEnv ? { env: parsedEnv.env } : {}),
    });
    setSaving(false);
    if (!r.ok) {
      setSaveError(errorText(r.error));
      return;
    }
    setPath('');
    setArgs('');
    setEnv('');
    await detectAgents();
    setSavedChange(true);
  };

  const runTest = async () => {
    setTesting(true);
    const r = await quiet(
      'connection.test',
      { adapterId: v.id },
      { projectId: projectId ?? undefined },
    );
    setTest(
      r.ok
        ? testSteps(r.result)
        : {
            ok: false,
            steps: [{ label: 'Connection test', ok: false, detail: errorText(r.error) }],
          },
    );
    setTesting(false);
    void detectAgents();
  };

  const restart =
    savedChange &&
    needsRestart(session, v.id, { model: v.model, resolvedProfile: adapter.resolvedProfile });

  return (
    <div className={`adapter-row ${checked ? 'chosen' : ''}`}>
      <label className="adapter-main">
        <input
          type="radio"
          name="agent"
          checked={checked}
          onChange={onChoose}
          aria-label={`Use ${v.label}`}
        />
        <div className="grow">
          <strong>{v.label}</strong>
          <small>
            {v.available
              ? v.version
                ? `Version ${v.version}`
                : 'Detected on this machine'
              : (v.installHint ?? 'Not installed on this machine')}
          </small>
        </div>
        <State
          state={v.available ? 'current' : 'not_run'}
          tone={v.availability.tone}
          label={v.availability.word}
        />
      </label>
      <div className="adapter-facts">
        {v.verification && (
          <span className={`adapter-verified ${v.verification.verified ? 'yes' : ''}`}>
            {v.verification.word}
          </span>
        )}
        {knowsProfiles && (
          <span>
            {resolvedProfileText(adapter, { model: v.model, profile: v.profile ?? 'auto' })}
          </span>
        )}
        {v.lastTest && (
          <span className={v.lastTest.ok ? 'tone-ok' : 'tone-err'}>
            Last test {v.lastTest.ok ? 'passed' : 'failed'}
          </span>
        )}
        {v.docsUrl && <ExternalLink url={v.docsUrl}>Docs</ExternalLink>}
      </div>
      {v.path && <p className="adapter-path mono">{v.path}</p>}
      {v.versionUnrecognised && (
        <p className="adapter-note tone-warn">This version has not been tested with this build.</p>
      )}
      {v.lastError && (
        // For a CLI that is not installed this is what the search found, not a failure.
        <p className={`adapter-note ${v.available ? 'tone-err' : ''}`}>{v.lastError}</p>
      )}
      <Disclosure label="Configure" open={open} onToggle={() => setOpen((x) => !x)}>
        <div className="stack adapter-config">
          {knowsProfiles ? (
            <>
              <Field label="Model" hint="Passed to the CLI when a session starts.">
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">CLI default</option>
                  {v.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} · {m.tier}
                    </option>
                  ))}
                  <option value={OTHER_MODEL}>Another model id…</option>
                </select>
              </Field>
              {model === OTHER_MODEL && (
                <Field label="Model id" hint="Exactly as the CLI’s model flag expects it.">
                  <input
                    className="mono"
                    value={customModel}
                    spellCheck={false}
                    onChange={(e) => setCustomModel(e.target.value)}
                  />
                </Field>
              )}
              <fieldset className="profile-choice">
                <legend>Tool profile</legend>
                {PROFILE_CHOICES.map((c) => (
                  <label key={c.value} className="profile-option">
                    <input
                      type="radio"
                      name={`profile-${v.id}`}
                      checked={profile === c.value}
                      onChange={() => setProfile(c.value)}
                    />
                    <span>
                      <strong>{c.label}</strong>
                      <small>{c.explain}</small>
                    </span>
                  </label>
                ))}
                <p className="profile-resolved" role="status">
                  {resolvedProfileText(adapter, { model: draftModel, profile })}
                </p>
                <p className="profile-note">Verification rules are the same in every profile.</p>
              </fieldset>
            </>
          ) : (
            <p className="adapter-note">This host does not report models or tool profiles.</p>
          )}
          <Field
            label="Executable path"
            hint={v.path ? `Leave empty to keep ${v.path}.` : 'Where the CLI is installed.'}
          >
            <input
              className="mono"
              value={path}
              spellCheck={false}
              placeholder={v.path ?? '/usr/local/bin/agent'}
              onChange={(e) => setPath(e.target.value)}
            />
          </Field>
          <div className="row">
            <Button
              size="sm"
              variant="ghost"
              icon={<FolderOpen size={12} />}
              onClick={async () => {
                const picked = await window.bureau.pickFile({ title: `Locate ${v.label}` });
                if (picked) setPath(picked);
              }}
            >
              Browse…
            </Button>
          </div>
          {custom && (
            <>
              <Field label="Arguments" hint={argsHint(v)}>
                <input
                  className="mono"
                  value={args}
                  spellCheck={false}
                  placeholder={v.savedArgs || undefined}
                  onChange={(e) => setArgs(e.target.value)}
                />
              </Field>
              <Field
                label="Environment"
                hint="KEY=VALUE, one per line. Saved values are not shown again."
              >
                <textarea
                  className="mono"
                  rows={3}
                  value={env}
                  spellCheck={false}
                  onChange={(e) => setEnv(e.target.value)}
                />
              </Field>
            </>
          )}
          {invalid && dirty && <p className="adapter-note tone-err">{invalid}</p>}
          {saveError && <p className="adapter-note tone-err">{saveError}</p>}
          <div className="row">
            <Button
              size="sm"
              variant="primary"
              disabled={!dirty || !!invalid}
              busy={saving}
              onClick={() => void save()}
            >
              Save
            </Button>
            <Button
              size="sm"
              disabled={!v.available || !projectId || readOnly}
              busy={testing}
              onClick={() => void runTest()}
            >
              Test connection
            </Button>
            {(!projectId || readOnly) && (
              <span className="adapter-note">Open a writable project to test.</span>
            )}
          </div>
          {test && (
            <ol className="test-steps" aria-label="Connection test">
              {test.steps.map((step, i) => (
                <li key={i}>
                  <State
                    state={step.ok === null ? 'not_run' : step.ok ? 'passed' : 'failed'}
                    label={step.label}
                    tone={step.ok === null ? 'neutral' : step.ok ? 'ok' : 'err'}
                  />
                  {step.detail && <span className="test-detail">{step.detail}</span>}
                </li>
              ))}
            </ol>
          )}
          {restart && (
            <RestartNote
              text={`The running session started with the previous settings.`}
              action="Restart to apply"
            />
          )}
        </div>
      </Disclosure>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Engineering tools                                                    */
/* ------------------------------------------------------------------ */

function ToolsSection() {
  const toast = useStore((s) => s.toast);
  const [scadPath, setScadPath] = useState('');
  const [probe, setProbe] = useState<ToolProbe | null>(null);
  const [raw, setRaw] = useState<unknown>(null);
  const [checking, setChecking] = useState(true);
  const [rawOpen, setRawOpen] = useState(false);

  const check = async () => {
    setChecking(true);
    const r = await quiet<{ results: Record<string, unknown> }>('tool.doctor', {
      toolId: 'openscad',
    });
    setChecking(false);
    if (r.ok) {
      setRaw(r.result.results);
      setProbe(openscadProbe(r.result.results));
    } else setRaw({ error: errorText(r.error) });
  };

  useEffect(() => {
    void quiet<{ value: unknown }>('settings.get', { key: 'toolPaths.openscad' }).then((r) => {
      if (r.ok) setScadPath(typeof r.result.value === 'string' ? r.result.value : '');
    });
    void check();
  }, []);

  const save = async () => {
    const r = await quiet('settings.set', { key: 'toolPaths.openscad', value: scadPath.trim() });
    if (!r.ok) {
      toast('error', errorText(r.error));
      return;
    }
    await check();
  };

  return (
    <section className="sheet-section">
      <div className="sheet-section-head">
        <h3>Engineering tools</h3>
      </div>
      <div className="tool-row">
        <span className="tool-icon">
          <Cube size={18} />
        </span>
        <div className="grow">
          <strong>OpenSCAD</strong>
          <small>Parametric source and STL rendering. Not bundled; uses your installed copy.</small>
        </div>
        {checking ? (
          <Spinner />
        ) : probe ? (
          <State
            state={probe.available ? 'current' : 'failed'}
            tone={probe.available ? 'ok' : 'err'}
            label={probe.available ? 'Working' : 'Not working'}
          />
        ) : (
          <State state="not_run" tone="neutral" label="Not checked" />
        )}
      </div>
      {probe && !checking && (
        <p className="adapter-note">
          {probe.available
            ? `Rendered a test part${probe.version ? ` with version ${probe.version}` : ''}.`
            : (probe.error ?? 'The probe did not render a test part.')}
          {probe.path && <span className="adapter-path mono"> {probe.path}</span>}
        </p>
      )}
      <Field
        label="OpenSCAD executable"
        hint="Leave empty to use the detected copy. On macOS, choose the program inside the app."
      >
        <input
          className="mono"
          value={scadPath}
          spellCheck={false}
          onChange={(e) => setScadPath(e.target.value)}
          placeholder="/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"
        />
      </Field>
      <div className="row">
        <Button onClick={() => void save()} busy={checking}>
          Save and check
        </Button>
        <Button
          variant="ghost"
          icon={<FolderOpen size={13} />}
          onClick={async () => {
            const path = await window.bureau.pickFile({ title: 'Locate OpenSCAD' });
            if (path) setScadPath(path);
          }}
        >
          Browse…
        </Button>
      </div>
      {raw !== null && (
        <Disclosure
          label="Diagnostics as reported"
          open={rawOpen}
          onToggle={() => setRawOpen((v) => !v)}
        >
          <pre className="code-block">{JSON.stringify(raw, null, 2)}</pre>
        </Disclosure>
      )}
      <StepConverterTool />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Appearance                                                           */
/* ------------------------------------------------------------------ */

function AppearanceSection() {
  const theme = useStore((s) => s.theme);
  const set = useStore((s) => s.set);
  return (
    <section className="sheet-section">
      <div className="sheet-section-head">
        <h3>Appearance</h3>
      </div>
      <div className="setting-row">
        <div>
          <strong>Theme</strong>
          <small>Dark for long sessions, Light for bright rooms.</small>
        </div>
        <Segmented
          label="Theme"
          value={theme}
          onChange={(v) => set({ theme: v })}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
          ]}
        />
      </div>
      <div className="setting-row">
        <div>
          <strong>Introduction</strong>
          <small>The four acts and the setup steps that played on first launch.</small>
        </div>
        <Button
          size="sm"
          icon={<Play size={12} weight="fill" />}
          onClick={() => set({ settingsOpen: false, introOpen: true })}
        >
          Play again
        </Button>
      </div>
    </section>
  );
}
