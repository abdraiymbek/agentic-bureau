import React, { useEffect, useState } from 'react';
import { cmd, errMsg } from '../api';
import { useStore } from '../store';
import type { AdapterStatus } from '@omenflow/contracts';

/** Connections + diagnostics: adapters, their status, custom CLI config, tool paths. */
export function ConnectionsView() {
  const { adapters, refreshAdapters, toast, session } = useStore();
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
      toast('ok', 'OpenSCAD path saved — doctor on next render');
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  return (
    <div style={{ padding: 16, overflowY: 'auto', height: '100%', maxWidth: 800 }}>
      <h3 style={{ margin: '0 0 12px' }}>Connections</h3>

      {adapters.map((a) => (
        <AdapterCard
          key={a.adapterId}
          a={a}
          test={test}
          testing={testing === a.adapterId}
          result={testResult[a.adapterId]}
        />
      ))}

      <Section title="Custom CLI">
        <Field2 label="Executable path">
          <input
            value={custom.path}
            onChange={(e) => setCustom((s) => ({ ...s, path: e.target.value }))}
            placeholder="/usr/local/bin/mytool"
            style={{ width: '100%' }}
          />
        </Field2>
        <Field2 label="Arguments">
          <input
            value={custom.args}
            onChange={(e) => setCustom((s) => ({ ...s, args: e.target.value }))}
            placeholder="--flag value"
            style={{ width: '100%' }}
          />
        </Field2>
        <Field2 label="Env (KEY=VALUE per line)">
          <textarea
            rows={2}
            value={custom.env}
            onChange={(e) => setCustom((s) => ({ ...s, env: e.target.value }))}
            style={{ width: '100%' }}
          />
        </Field2>
        <button onClick={configureCustom} style={{ height: 26, fontSize: 12 }}>
          Save custom adapter
        </button>
      </Section>

      <Section title="OpenSCAD">
        <div className="faint" style={{ fontSize: 12, marginBottom: 6 }}>
          OpenSCAD is a user-supplied prerequisite for CAD. Point Omen Flow at a nonstandard install
          if needed.
        </div>
        <div className="row">
          <input
            value={scadPath}
            onChange={(e) => setScadPath(e.target.value)}
            placeholder="/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"
            style={{ flex: 1 }}
          />
          <button style={{ height: 30 }} onClick={saveScadPath}>
            Save path
          </button>
          <button
            style={{ height: 30 }}
            onClick={async () => {
              const p = await window.omenflow.pickFile({ title: 'Locate OpenSCAD' });
              if (p) setScadPath(p);
            }}
          >
            Browse…
          </button>
        </div>
        {doctor && (
          <pre className="mono dim" style={{ fontSize: 11, marginTop: 8, whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(doctor, null, 2)}
          </pre>
        )}
      </Section>

      <Section title="Current session">
        <div className="dim" style={{ fontSize: 12 }}>
          {session
            ? `${session.adapterId} — ${session.state}${session.startedAt ? ` (started ${session.startedAt.slice(11, 19)})` : ''}`
            : 'No agent session running.'}
        </div>
      </Section>
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
    <div
      style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12, marginBottom: 10 }}
    >
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <span style={{ fontWeight: 600 }}>{a.label}</span>
          <span className={`pill ${a.available ? 'current' : 'missing'}`}>
            {a.available ? `v${a.version ?? '?'}` : 'not found'}
          </span>
          {a.recognizedVersion === false && <span className="pill stale">untested version</span>}
        </div>
        <button
          style={{ height: 24, fontSize: 12 }}
          disabled={!a.available || props.testing}
          onClick={() => props.test(a.adapterId)}
        >
          {props.testing ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {a.executablePath && (
        <div className="faint mono" style={{ fontSize: 11, marginTop: 4 }}>
          {a.executablePath}
        </div>
      )}
      {a.lastError && (
        <div className="err" style={{ fontSize: 12, marginTop: 4 }}>
          {a.lastError}
        </div>
      )}
      {props.result && (
        <div className={props.result.ok ? 'ok' : 'err'} style={{ fontSize: 12, marginTop: 4 }}>
          {props.result.ok ? 'OK' : props.result.error} {props.result.detail ?? ''}
        </div>
      )}
    </div>
  );
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 6, padding: 12 }}>
      <div className="dim" style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
        {props.title}
      </div>
      {props.children}
    </div>
  );
}
function Field2(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="col" style={{ gap: 4, marginBottom: 8 }}>
      <label className="dim" style={{ fontSize: 12 }}>
        {props.label}
      </label>
      {props.children}
    </div>
  );
}
