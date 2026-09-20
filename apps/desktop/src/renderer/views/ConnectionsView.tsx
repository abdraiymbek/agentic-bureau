import React, { useEffect, useState } from 'react';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import { PageHeader, FormField, StatusBadge } from '../components/ui';
import {
  TerminalWindow,
  Cube,
  ArrowClockwise,
  Sun,
  Moon,
  PlugsConnected,
} from '@phosphor-icons/react';
import type { AdapterStatus } from '@omenflow/contracts';

/** Connections + diagnostics: adapters, their status, custom CLI config, tool paths. */
export function ConnectionsView() {
  const { adapters, refreshAdapters, toast, session, theme, density, set } = useStore();
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<
    Record<string, { ok: boolean; error?: string; detail?: string }>
  >({});
  const [custom, setCustom] = useState({ path: '', args: '', env: '' });
  const [scadPath, setScadPath] = useState('');
  const [doctor, setDoctor] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    void refreshAdapters();
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
      setTestResult((s) => ({ ...s, [adapterId]: r }));
      toast(r.ok ? 'ok' : 'error', r.ok ? 'Connection test passed' : (r.error ?? 'failed'));
    } catch (e) {
      toast('error', errMsg(e));
      setTestResult((s) => ({ ...s, [adapterId]: { ok: false, error: errMsg(e) } }));
    } finally {
      setTesting(null);
      void refreshAdapters();
    }
  };

  const configureCustom = async () => {
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
                .map((l) => l.split('=') as [string, string]),
            )
          : undefined,
      });
      toast('ok', 'Custom CLI configured');
      void refreshAdapters();
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  const saveScadPath = async () => {
    try {
      await cmd('settings.set', { key: 'toolPaths.openscad', value: scadPath });
      toast('ok', 'OpenSCAD path saved. It will be checked on the next render.');
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Connections"
        description="Choose your intelligence. Connect your engineering tools."
      >
        <button onClick={() => void refreshAdapters().catch((e) => toast('error', errMsg(e)))}>
          <ArrowClockwise size={14} />
          Refresh
        </button>
      </PageHeader>
      <div className="page-scroll settings-page">
        <section className="settings-section">
          <div className="section-heading">
            <h2>
              <TerminalWindow size={16} />
              AI agents
            </h2>
            <span className="faint">Bring your own tools</span>
          </div>
          <p>
            Run a local agent in your project. Structured proposals stay reviewable in Omen Flow.
          </p>
          <div className="adapter-list">
            {adapters.map((a) => (
              <AdapterCard
                key={a.adapterId}
                a={a}
                test={test}
                testing={testing === a.adapterId}
                result={testResult[a.adapterId]}
              />
            ))}
            {!adapters.length && (
              <p className="dim">No adapters detected. Refresh to check your installed tools.</p>
            )}
          </div>
          <details className="settings-disclosure">
            <summary>Configure a custom agent</summary>
            <div className="settings-form">
              <Field2 label="Executable path">
                <input
                  value={custom.path}
                  onChange={(e) => setCustom((s) => ({ ...s, path: e.target.value }))}
                  placeholder="/usr/local/bin/my-agent"
                />
              </Field2>
              <Field2 label="Arguments">
                <input
                  value={custom.args}
                  onChange={(e) => setCustom((s) => ({ ...s, args: e.target.value }))}
                  placeholder="--flag value"
                />
              </Field2>
              <Field2 label="Environment variables">
                <textarea
                  rows={3}
                  value={custom.env}
                  onChange={(e) => setCustom((s) => ({ ...s, env: e.target.value }))}
                  placeholder="KEY=VALUE, one per line"
                />
              </Field2>
              <button onClick={() => void configureCustom()} disabled={!custom.path.trim()}>
                Save custom agent
              </button>
            </div>
          </details>
        </section>
        <section className="settings-section">
          <div className="section-heading">
            <h2>
              <Cube size={16} />
              Engineering tools
            </h2>
          </div>
          <div className="engineering-tool">
            <span className="connection-symbol">
              <Cube size={23} weight="light" />
            </span>
            <div>
              <strong>OpenSCAD</strong>
              <p>Parametric modeling and STL rendering</p>
            </div>
          </div>
          <p>
            Use an installed copy of OpenSCAD to render your models. Set a custom path if it isn’t
            detected.
          </p>
          <div className="row">
            <FormField label="OpenSCAD executable">
              <input
                value={scadPath}
                onChange={(e) => setScadPath(e.target.value)}
                placeholder="/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"
              />
            </FormField>
          </div>
          <div className="row">
            <button onClick={() => void saveScadPath()} disabled={!scadPath.trim()}>
              Save path
            </button>
            <button
              className="ghost"
              onClick={async () => {
                const path = await window.omenflow.pickFile({ title: 'Locate OpenSCAD' });
                if (path) setScadPath(path);
              }}
            >
              Browse files
            </button>
          </div>
          {doctor && (
            <details className="settings-disclosure">
              <summary>Tool diagnostics</summary>
              <pre className="diagnostic-output">{JSON.stringify(doctor, null, 2)}</pre>
            </details>
          )}
        </section>
        <section className="settings-section">
          <div className="section-heading">
            <h2>Appearance</h2>
          </div>
          <div className="settings-row">
            <div>
              <strong>Color theme</strong>
              <p>A consistent theme across every workspace surface.</p>
            </div>
            <div className="segmented">
              <button aria-pressed={theme === 'dark'} onClick={() => set({ theme: 'dark' })}>
                <Moon size={14} />
                Dark
              </button>
              <button aria-pressed={theme === 'light'} onClick={() => set({ theme: 'light' })}>
                <Sun size={14} />
                Light
              </button>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <strong>Information density</strong>
              <p>Adjust spacing in engineering tables.</p>
            </div>
            <div className="segmented">
              <button
                aria-pressed={density === 'comfortable'}
                onClick={() => set({ density: 'comfortable' })}
              >
                Comfortable
              </button>
              <button
                aria-pressed={density === 'compact'}
                onClick={() => set({ density: 'compact' })}
              >
                Compact
              </button>
            </div>
          </div>
        </section>
        <section className="settings-section">
          <div className="section-heading">
            <h2>Current session</h2>
          </div>
          <div className="row">
            <PlugsConnected size={15} className="faint" />
            <span className="dim">
              {session ? `${session.adapterId}: ${session.state}` : 'No agent session running'}
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}

function AdapterCard(props: {
  a: AdapterStatus;
  test: (id: string) => void;
  testing: boolean;
  result?: { ok: boolean; error?: string; detail?: string };
}) {
  const a = props.a;
  return (
    <div className="adapter-row">
      <div className="adapter-main">
        <span className="connection-symbol">
          <TerminalWindow size={21} weight="light" />
        </span>
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
        <StatusBadge
          state={a.available ? 'current' : 'draft'}
          label={a.available ? 'Available' : 'Not detected'}
        />
        <button disabled={!a.available || props.testing} onClick={() => props.test(a.adapterId)}>
          {props.testing ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {a.recognizedVersion === false && a.available && (
        <p className="warn">This installed version hasn’t been tested.</p>
      )}
      {a.executablePath && <div className="adapter-path mono">{a.executablePath}</div>}
      {a.lastError && <p className="err">{a.lastError}</p>}
      {props.result && (
        <p className={props.result.ok ? 'ok' : 'err'}>
          {props.result.ok ? 'Connection test passed.' : props.result.error} {props.result.detail}
        </p>
      )}
    </div>
  );
}
function Field2(props: { label: string; children: React.ReactNode }) {
  return <FormField label={props.label}>{props.children as React.ReactElement}</FormField>;
}
