/**
 * The introduction's setup steps. Each one does the real thing: detects the agent CLIs on this
 * machine and remembers the choice, probes OpenSCAD, switches the theme, lights the shortcuts
 * as they are pressed, and says where everything lives.
 */
import React, { useEffect, useState } from 'react';
import { ArrowClockwise, Check, Cube, FolderOpen, GearSix, HardDrive, Scales } from '../ui/icons';
import { preferredAdapter, useStore } from '../store';
import { Button, Kbd, Notice, Segmented, Spinner, State } from '../ui/kit';
import { ExternalLink } from '../ui/ExternalLink';
import { adapterRowView, openscadProbe, type ToolProbe } from '../shell/agent/adapter-view';
import { useAgentUi, type SettingsSection } from '../shell/agent/agent-store';
import { detectAgents } from '../shell/agent/feed';
import { errorText, quiet } from '../shell/agent/quiet';
import { PRIMER, engineInstallHint, settingsFolder, type Platform } from './model';

function openSettings(section: SettingsSection) {
  useAgentUi.getState().setSettingsSection(section);
  useStore.getState().set({ settingsOpen: true });
}

/* ------------------------------------------------------------------ */
/* Your agent                                                           */
/* ------------------------------------------------------------------ */

export function AgentStep() {
  const adapters = useStore((s) => s.adapters);
  const agentId = useStore((s) => s.agentId);
  const setAgent = useStore((s) => s.setAgent);
  const detection = useAgentUi((s) => s.detection);
  useEffect(() => {
    void detectAgents();
  }, []);
  const rows = adapters.map(adapterRowView);
  const chosen = preferredAdapter(adapters, agentId);
  const detecting = detection.status === 'detecting';
  const anyFound = rows.some((r) => r.available);

  const setPath = async (adapterId: string, label: string) => {
    const path = await window.bureau.pickFile({ title: `Locate ${label}` });
    if (!path) return;
    const r = await quiet('connection.configure', { adapterId, executablePath: path });
    if (r.ok) {
      setAgent(adapterId);
      await detectAgents();
    } else useStore.getState().toast('error', errorText(r.error));
  };

  return (
    <>
      <p className="intro-lede">
        Bureau runs the agent CLI you already use, in the project’s folder. The{' '}
        <strong>Conversation</strong> pane runs Codex CLI or Claude Code once per message; the{' '}
        <strong>Terminal</strong> pane runs any of them interactively. One agent works in a project
        at a time.
      </p>
      {detection.status === 'failed' && (
        <Notice tone="err" role="alert">
          Could not check for agent CLIs: {detection.error}
        </Notice>
      )}
      <ul
        className="intro-adapters"
        role="radiogroup"
        aria-label="The agent to run in your projects"
        aria-busy={detecting}
      >
        {rows.map((v) => {
          const on = v.available && chosen?.adapterId === v.id;
          return (
            <li key={v.id} className="intro-adapter" data-on={on ? '' : undefined}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                className="intro-adapter-pick"
                disabled={!v.available}
                onClick={() => setAgent(v.id)}
              >
                <i aria-hidden="true">{on && <Check size={11} weight="bold" />}</i>
                <span className="intro-adapter-copy">
                  <strong>{v.label}</strong>
                  {v.version && <span className="mono dim"> {v.version}</span>}
                </span>
                {detecting && !v.available ? (
                  <Spinner />
                ) : (
                  <State
                    state={v.available ? 'current' : 'not_run'}
                    tone={v.availability.tone}
                    label={v.availability.word}
                  />
                )}
                {v.verification?.verified && (
                  <span className="onboard-verified yes">{v.verification.word}</span>
                )}
              </button>
              {!v.available && !detecting && (
                <div className="intro-adapter-help">
                  {v.installHint && <span>{v.installHint}</span>}
                  {v.docsUrl && <ExternalLink url={v.docsUrl}>Install guide</ExternalLink>}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<FolderOpen size={12} />}
                    onClick={() => void setPath(v.id, v.label)}
                  >
                    Set path…
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="row intro-actions">
        <Button
          size="sm"
          icon={<ArrowClockwise size={12} />}
          busy={detecting}
          onClick={() => void detectAgents()}
        >
          Detect again
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<GearSix size={12} />}
          onClick={() => openSettings('agents')}
        >
          Agent settings
        </Button>
      </div>
      <p className="intro-note" role="status">
        {anyFound
          ? 'Your choice is remembered. Change it any time in Settings.'
          : 'Nothing found yet. You can continue: the Agent tab lists each CLI with its install guide whenever you are ready.'}
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Your engine                                                          */
/* ------------------------------------------------------------------ */

export function EngineStep({ platform }: { platform: Platform }) {
  const toast = useStore((s) => s.toast);
  const [probe, setProbe] = useState<ToolProbe | null>(null);
  const [checking, setChecking] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    // OpenSCAD only: first launch never waits on the optional STEP converter's cold import.
    const r = await quiet<{ results: Record<string, unknown> }>('tool.doctor', {
      toolId: 'openscad',
    });
    setChecking(false);
    if (r.ok) {
      setFailed(null);
      setProbe(openscadProbe(r.result.results));
    } else setFailed(errorText(r.error));
  };
  useEffect(() => {
    void check();
  }, []);

  const locate = async () => {
    const path = await window.bureau.pickFile({ title: 'Locate OpenSCAD' });
    if (!path) return;
    const r = await quiet('settings.set', { key: 'toolPaths.openscad', value: path });
    if (!r.ok) {
      toast('error', errorText(r.error));
      return;
    }
    await check();
  };

  const hint = engineInstallHint(platform);
  const words = checking
    ? 'Rendering a test part…'
    : probe?.available
      ? `Rendered a test part${probe.version ? ` with version ${probe.version}` : ''}.`
      : (probe?.error ?? failed ?? 'The probe did not render a test part.');

  return (
    <>
      <p className="intro-lede">
        OpenSCAD renders and checks parts: parametric source in, geometry and verification out. It
        is not bundled; everything else works without it.
      </p>
      <div className="tool-row intro-tool">
        <span className="tool-icon">
          <Cube size={18} />
        </span>
        <div className="grow">
          <strong>OpenSCAD</strong>
          <small>{words}</small>
          {probe?.path && <small className="adapter-path mono">{probe.path}</small>}
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
      {!checking && !probe?.available && (
        <Notice tone="neutral">
          {hint.command ? (
            <>
              Install it with <code className="intro-code">{hint.command}</code>. {hint.words}
            </>
          ) : (
            hint.words
          )}
          {platform === 'mac' && ' To point at a copy by hand, choose the program inside the app.'}
        </Notice>
      )}
      <div className="row intro-actions">
        <Button
          size="sm"
          icon={<ArrowClockwise size={12} />}
          busy={checking}
          onClick={() => void check()}
        >
          Check again
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<FolderOpen size={12} />}
          onClick={() => void locate()}
        >
          Locate OpenSCAD…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<GearSix size={12} />}
          onClick={() => openSettings('tools')}
        >
          Engine settings
        </Button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Your look                                                            */
/* ------------------------------------------------------------------ */

export function LookStep() {
  const theme = useStore((s) => s.theme);
  const set = useStore((s) => s.set);
  return (
    <>
      <p className="intro-lede">
        Dark for long sessions, Light for bright rooms. The whole workspace changes with it, this
        introduction included.
      </p>
      <div className="intro-look">
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
      <div className="intro-specimen" aria-label="How state is shown">
        <State state="approved" dimension="review" />
        <State state="stale" dimension="freshness" />
        <State state="failed" dimension="result" />
        <State state="covered" dimension="evidence" />
        <span className="dim">Colour always comes with a word.</span>
      </div>
      <p className="intro-note">
        One signal colour means alive or selected: a running agent, keyboard focus, the lit thread.
        Motion follows your system’s Reduce motion setting. Change the theme any time in Settings (
        <Kbd>⌘,</Kbd>).
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Your keys                                                            */
/* ------------------------------------------------------------------ */

export function KeysStep({ seen }: { seen: Set<string> }) {
  return (
    <>
      <p className="intro-lede">
        Press each one now. Here they only light up; in the workspace they move you.
      </p>
      <ol className="intro-keys">
        {PRIMER.map((k) => (
          <li key={k.id} data-seen={seen.has(k.id) ? '' : undefined}>
            <Kbd>{k.shortcut}</Kbd>
            <span>{k.label}</span>
            <i aria-hidden="true">{seen.has(k.id) && <Check size={12} weight="bold" />}</i>
            {seen.has(k.id) && <span className="sr-only">pressed</span>}
          </li>
        ))}
      </ol>
      <p className="intro-note" role="status">
        {seen.size} of {PRIMER.length} pressed.{' '}
        {seen.size === PRIMER.length
          ? 'That is the whole workspace.'
          : 'Press them in any order, or continue.'}
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Local by design                                                      */
/* ------------------------------------------------------------------ */

export function LocalStep({ platform }: { platform: Platform }) {
  return (
    <>
      <p className="intro-lede">
        Everything lives in the project folder: a schema 1 SQLite record, an object store of
        immutable files, and readable working files. No account, no cloud copy.
      </p>
      <ul className="intro-facts">
        <li>
          <HardDrive size={15} />
          <div>
            <strong>Your projects</strong>
            <small>
              Folders you choose, in a location you choose. Installing or removing the app never
              changes them. A project written by a newer build opens read-only.
            </small>
          </div>
        </li>
        <li>
          <GearSix size={15} />
          <div>
            <strong>The app’s own settings</strong>
            <small>
              Recent projects, the agent and engine choices:{' '}
              <span className="mono">{settingsFolder(platform)}</span>.
            </small>
          </div>
        </li>
        <li>
          <Scales size={15} />
          <div>
            <strong>Agents propose. People decide.</strong>
            <small>
              The agent runs on this machine with the CLI you already use. Nothing it writes becomes
              the baseline until you approve it, and approval never means validated.
            </small>
          </div>
        </li>
      </ul>
      <p className="intro-note">
        Next: <em>What are you building?</em> Describe it once and choose an empty folder; your
        agent drafts the first requirements for you to decide on.
      </p>
    </>
  );
}
