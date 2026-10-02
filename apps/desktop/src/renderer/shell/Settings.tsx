import React, { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowClockwise, X, Cube, TerminalWindow } from '@phosphor-icons/react';
import type { AdapterStatus } from '@omenflow/contracts';
import { cmd, errMsg } from '../api';
import { preferredAdapter, useStore } from '../store';
import { startAgent } from '../lib/actions';
import { Button, Disclosure, Field, IconButton, Mark, Segmented, State } from '../ui/kit';

/** Agents, engineering tools, and appearance. One sheet, never a destination. */
export function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const set = useStore((s) => s.set);
  return (
    <Dialog.Root open={open} onOpenChange={(v) => set({ settingsOpen: v })}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="sheet" aria-describedby={undefined}>
          <header className="sheet-head">
            <Dialog.Title>Settings</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Close settings">
                <X size={15} />
              </IconButton>
            </Dialog.Close>
          </header>
          {open && <SettingsBody />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SettingsBody() {
  const adapters = useStore((s) => s.adapters);
  const session = useStore((s) => s.session);
  const theme = useStore((s) => s.theme);
  const agentId = useStore((s) => s.agentId);
  const projectId = useStore((s) => s.projectId);
  const { set, setAgent, toast, refreshAdapters } = useStore.getState();
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<
    Record<string, { ok: boolean; error?: string; detail?: string }>
  >({});
  const [custom, setCustom] = useState({ path: '', args: '', env: '' });
  const [customOpen, setCustomOpen] = useState(false);
  const [scadPath, setScadPath] = useState('');
  const [doctor, setDoctor] = useState<Record<string, unknown> | null>(null);
  const [doctorOpen, setDoctorOpen] = useState(false);

  useEffect(() => {
    void cmd<{ value: unknown }>('settings.get', { key: 'toolPaths.openscad' })
      .then((r) => setScadPath(typeof r.value === 'string' ? r.value : ''))
      .catch(() => {});
    void refreshAdapters().catch(() => {});
    void cmd<{ results: Record<string, unknown> }>('tool.doctor', {})
      .then((r) => setDoctor(r.results))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const test = async (adapterId: string) => {
    setTesting(adapterId);
    try {
      const r = await cmd<{ ok: boolean; error?: string; detail?: string }>('connection.test', {
        adapterId,
      });
      setResults((s) => ({ ...s, [adapterId]: r }));
    } catch (e) {
      setResults((s) => ({ ...s, [adapterId]: { ok: false, error: errMsg(e) } }));
    } finally {
      setTesting(null);
      void refreshAdapters().catch(() => {});
    }
  };

  const saveCustom = async () => {
    try {
      await cmd('connection.configure', {
        adapterId: 'custom',
        executablePath: custom.path,
        args: custom.args ? custom.args.split(' ').filter(Boolean) : undefined,
        env: custom.env
          ? Object.fromEntries(
              custom.env
                .split('\n')
                .filter((l) => l.includes('='))
                .map((l) => {
                  const at = l.indexOf('=');
                  return [l.slice(0, at).trim(), l.slice(at + 1)] as [string, string];
                }),
            )
          : undefined,
      });
      toast('ok', 'Custom agent saved');
      void refreshAdapters();
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  const saveScad = async () => {
    try {
      await cmd('settings.set', { key: 'toolPaths.openscad', value: scadPath.trim() });
      toast('ok', 'OpenSCAD path saved. It is checked on the next render.');
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  const chosen = preferredAdapter(adapters, agentId);
  const runningAdapter =
    session && (session.state === 'running' || session.state === 'starting')
      ? session.adapterId
      : null;
  const runningLabel =
    adapters.find((a) => a.adapterId === runningAdapter)?.label ?? runningAdapter;
  const restartWith = async (adapterId: string) => {
    try {
      await startAgent(adapterId);
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  return (
    <div className="sheet-body">
      <section className="sheet-section">
        <div className="sheet-section-head">
          <h3>Agents</h3>
          <Button
            size="sm"
            variant="ghost"
            icon={<ArrowClockwise size={13} />}
            onClick={() => void refreshAdapters().catch((e) => toast('error', errMsg(e)))}
          >
            Detect again
          </Button>
        </div>
        <p className="sheet-lede">
          Bring the agent CLI you already use. The chosen agent runs in the Agent tab in this
          project’s folder; its structured changes arrive as proposals for you to decide.
        </p>
        <div className="adapter-list" role="radiogroup" aria-label="Agent">
          {adapters.map((a) => (
            <AdapterRow
              key={a.adapterId}
              a={a}
              checked={chosen?.adapterId === a.adapterId}
              onChoose={() => setAgent(a.adapterId)}
              testing={testing === a.adapterId}
              result={results[a.adapterId]}
              testDisabled={!projectId || useStore.getState().readOnly}
              onTest={() => void test(a.adapterId)}
            />
          ))}
          {!adapters.length && <p className="dim">Detecting installed agents…</p>}
        </div>
        {runningAdapter && chosen && runningAdapter !== chosen.adapterId && (
          <p className="sheet-note">
            <TerminalWindow size={13} />
            <span className="grow">
              {runningLabel} is running now. {chosen.label} starts the next time the agent starts.
            </span>
            <Button
              size="sm"
              disabled={!chosen.available}
              onClick={() => void restartWith(chosen.adapterId)}
            >
              Restart with {chosen.label}
            </Button>
          </p>
        )}
        <Disclosure
          label="Custom agent"
          open={customOpen}
          onToggle={() => setCustomOpen((v) => !v)}
        >
          <div className="stack">
            <Field label="Executable path">
              <input
                value={custom.path}
                onChange={(e) => setCustom((s) => ({ ...s, path: e.target.value }))}
                placeholder="/usr/local/bin/my-agent"
              />
            </Field>
            <Field label="Arguments">
              <input
                value={custom.args}
                onChange={(e) => setCustom((s) => ({ ...s, args: e.target.value }))}
                placeholder="--flag value"
              />
            </Field>
            <Field label="Environment" hint="KEY=VALUE, one per line.">
              <textarea
                rows={3}
                value={custom.env}
                onChange={(e) => setCustom((s) => ({ ...s, env: e.target.value }))}
              />
            </Field>
            <div>
              <Button onClick={() => void saveCustom()} disabled={!custom.path.trim()}>
                Save custom agent
              </Button>
            </div>
          </div>
        </Disclosure>
        <p className="sheet-note">
          <TerminalWindow size={13} />
          {session
            ? `${session.adapterId} session: ${session.state}`
            : 'No agent session in this project'}
        </p>
      </section>

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
            <small>
              Parametric source and STL rendering. Not bundled; uses your installed copy.
            </small>
          </div>
        </div>
        <Field label="OpenSCAD executable" hint="Leave empty to use the detected copy.">
          <input
            value={scadPath}
            onChange={(e) => setScadPath(e.target.value)}
            placeholder="/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"
          />
        </Field>
        <div className="row">
          <Button onClick={() => void saveScad()}>Save path</Button>
          <Button
            variant="ghost"
            onClick={async () => {
              const path = await window.omenflow.pickFile({ title: 'Locate OpenSCAD' });
              if (path) setScadPath(path);
            }}
          >
            Browse…
          </Button>
        </div>
        {doctor && (
          <Disclosure
            label="Diagnostics"
            open={doctorOpen}
            onToggle={() => setDoctorOpen((v) => !v)}
          >
            <pre className="code-block">{JSON.stringify(doctor, null, 2)}</pre>
          </Disclosure>
        )}
      </section>

      <section className="sheet-section">
        <div className="sheet-section-head">
          <h3>Appearance</h3>
        </div>
        <div className="setting-row">
          <div>
            <strong>Theme</strong>
            <small>Graphite for long sessions, Paper for bright rooms.</small>
          </div>
          <Segmented
            label="Theme"
            value={theme}
            onChange={(v) => set({ theme: v })}
            options={[
              { value: 'dark', label: 'Graphite' },
              { value: 'light', label: 'Paper' },
            ]}
          />
        </div>
      </section>

      <footer className="sheet-foot">
        <Mark size={14} />
        <span>Omen Flow · local by design. Your record lives in the project folder.</span>
      </footer>
    </div>
  );
}

function AdapterRow(props: {
  a: AdapterStatus;
  checked: boolean;
  onChoose: () => void;
  testing: boolean;
  result?: { ok: boolean; error?: string; detail?: string };
  testDisabled: boolean;
  onTest: () => void;
}) {
  const { a, result } = props;
  const state = result ? (result.ok ? 'working' : 'failed') : a.available ? 'detected' : 'missing';
  return (
    <label className="adapter-row">
      <div className="adapter-main">
        <input
          type="radio"
          name="agent"
          checked={props.checked}
          onChange={props.onChoose}
          aria-label={`Use ${a.label}`}
        />
        <div className="grow">
          <strong>{a.label}</strong>
          <small>
            {a.available
              ? a.version
                ? `Version ${a.version}`
                : 'Detected on this device'
              : (a.installHint ?? 'Not installed on this device')}
          </small>
        </div>
        <State
          state={state}
          tone={state === 'working' ? 'ok' : state === 'failed' ? 'err' : 'neutral'}
          label={
            state === 'working'
              ? 'Working'
              : state === 'failed'
                ? 'Test failed'
                : state === 'detected'
                  ? 'Detected'
                  : 'Not detected'
          }
        />
        <Button
          size="sm"
          disabled={!a.available || props.testing || props.testDisabled}
          title={props.testDisabled ? 'Open a writable project to test the bridge' : undefined}
          onClick={props.onTest}
        >
          {props.testing ? 'Testing…' : 'Test'}
        </Button>
      </div>
      {a.available && a.recognizedVersion === false && (
        <p className="adapter-note tone-warn">This version hasn’t been tested with Omen Flow.</p>
      )}
      {a.executablePath && <p className="adapter-path mono">{a.executablePath}</p>}
      {a.lastError && <p className="adapter-note tone-err">{a.lastError}</p>}
      {result && !result.ok && (
        <p className="adapter-note tone-err">
          {result.error} {result.detail}
        </p>
      )}
      {result?.ok && result.detail && <p className="adapter-note">{result.detail}</p>}
    </label>
  );
}
