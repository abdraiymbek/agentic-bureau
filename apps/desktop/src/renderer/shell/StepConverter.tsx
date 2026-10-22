import React, { useEffect, useState } from 'react';
import { Export, FolderOpen } from '@phosphor-icons/react';
import { useStore } from '../store';
import { Button, Field, Spinner, State } from '../ui/kit';
import { pythonProbe } from './agent/adapter-view';
import { errorText, quiet } from './agent/quiet';

/** How to set the converter up, pinned to the OCP release CADGenBench's own checks use. */
export const STEP_CONVERTER_SETUP =
  'Needs Python 3.11–3.14: python3.12 -m venv ~/.omenflow-step, then ~/.omenflow-step/bin/python -m pip install cadquery-ocp-novtk==7.9.3.1.1 (with uv: uv venv --python 3.12 ~/.omenflow-step, then uv pip install --python ~/.omenflow-step/bin/python cadquery-ocp-novtk==7.9.3.1.1).';

/**
 * Settings → Engineering tools: the optional STEP converter, a Python that imports OCP
 * (OpenCASCADE). Checked on its own, so the OpenSCAD row never waits on a cold `import OCP`.
 */
export function StepConverterTool() {
  const toast = useStore((s) => s.toast);
  const [path, setPath] = useState('');
  const [saved, setSaved] = useState('');
  const [probe, setProbe] = useState<ReturnType<typeof pythonProbe>>(null);
  const [checking, setChecking] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    const r = await quiet<{ results: Record<string, unknown> }>('tool.doctor', {
      toolId: 'python',
    });
    setChecking(false);
    if (r.ok) {
      setFailed(null);
      setProbe(pythonProbe(r.result.results));
    } else setFailed(errorText(r.error));
  };

  useEffect(() => {
    void quiet<{ value: unknown }>('settings.get', { key: 'toolPaths.python' }).then((r) => {
      if (!r.ok) return;
      const value = typeof r.result.value === 'string' ? r.result.value : '';
      setPath(value);
      setSaved(value);
    });
    void check();
  }, []);

  const save = async () => {
    const value = path.trim();
    const r = await quiet('settings.set', { key: 'toolPaths.python', value });
    if (!r.ok) {
      toast('error', errorText(r.error));
      return;
    }
    setSaved(value);
    await check();
  };

  const state = probe?.available
    ? { state: 'current', tone: 'ok' as const, label: 'Working' }
    : probe && saved.trim()
      ? { state: 'failed', tone: 'err' as const, label: 'Not working' }
      : { state: 'not_run', tone: 'neutral' as const, label: 'Not set up' };

  return (
    <>
      <div className="tool-row">
        <span className="tool-icon">
          <Export size={18} />
        </span>
        <div className="grow">
          <strong>STEP converter (optional)</strong>
          <small>
            Python with OCP (OpenCASCADE) for exact STEP surfaces. Not bundled; without it STEP
            exports are faceted.
          </small>
        </div>
        {checking ? (
          <Spinner />
        ) : failed ? (
          <State state="not_run" tone="neutral" label="Not checked" />
        ) : (
          <State state={state.state} tone={state.tone} label={state.label} />
        )}
      </div>
      {!checking && (failed || probe) && (
        <p className="adapter-note">
          {failed
            ? `The check did not run: ${failed}`
            : probe?.available
              ? `OCP ${probe.ocp ?? 'of unknown version'} on Python ${probe.version ?? 'of unknown version'}.`
              : (probe?.error ?? 'No Python with OCP was found.')}
          {probe?.note && ` ${probe.note}`}
          {probe?.path && <span className="adapter-path mono"> {probe.path}</span>}
        </p>
      )}
      <Field label="Python with OCP" hint={`Leave empty to look for one. ${STEP_CONVERTER_SETUP}`}>
        <input
          className="mono"
          value={path}
          spellCheck={false}
          onChange={(e) => setPath(e.target.value)}
          placeholder="~/.omenflow-step/bin/python3"
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
            const picked = await window.omenflow.pickFile({ title: 'Locate Python' });
            if (picked) setPath(picked);
          }}
        >
          Browse…
        </Button>
      </div>
    </>
  );
}
