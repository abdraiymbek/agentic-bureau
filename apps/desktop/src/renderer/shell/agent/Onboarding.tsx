import React, { useState } from 'react';
import { ArrowClockwise, ChatCircle, FolderOpen, GearSix, Play, Square } from '../../ui/icons';
import type { AdapterStatus } from '@bureau/contracts';
import { useStore } from '../../store';
import { useChat } from '../../chat/chat-store';
import { flushAsks, startAgentFromSurface as startAdapter } from '../../lib/actions';
import { ExternalLink } from '../../ui/ExternalLink';
import { Button, Spinner, State } from '../../ui/kit';
import { adapterRowView } from './adapter-view';
import { useAgentUi } from './agent-store';
import { detectAgents } from './feed';
import { errorText, quiet } from './quiet';
import type { Phase } from './phase';
import { adapterLabel, sessionStatus } from './session-view';

function openSettings() {
  useAgentUi.getState().setSettingsSection('agents');
  useStore.getState().set({ settingsOpen: true });
}

/** Point an adapter at an executable the person picks, then detect again. */
async function setPath(adapterId: string, label: string) {
  const path = await window.bureau.pickFile({ title: `Locate ${label}` });
  if (!path) return;
  const r = await quiet('connection.configure', { adapterId, executablePath: path });
  if (r.ok) await detectAgents();
  else useStore.getState().toast('error', errorText(r.error));
}

function DetectAgain({ variant = 'secondary' }: { variant?: 'secondary' | 'ghost' }) {
  const detecting = useAgentUi((s) => s.detection.status === 'detecting');
  return (
    <Button
      size="sm"
      variant={variant}
      icon={<ArrowClockwise size={12} />}
      busy={detecting}
      onClick={() => void detectAgents()}
    >
      Detect again
    </Button>
  );
}

function AdapterHelp({ adapter }: { adapter: AdapterStatus }) {
  const v = adapterRowView(adapter);
  return (
    <li className="onboard-adapter">
      <div className="onboard-adapter-head">
        <strong>{v.label}</strong>
        <State
          state={v.available ? 'current' : 'not_run'}
          tone={v.availability.tone}
          label={v.availability.word}
        />
        {v.verification && (
          <span className={`onboard-verified ${v.verification.verified ? 'yes' : ''}`}>
            {v.verification.word}
          </span>
        )}
      </div>
      {v.lastError && <p className="onboard-searched mono">{v.lastError}</p>}
      {v.installHint && <p>{v.installHint}</p>}
      <div className="row">
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
    </li>
  );
}

/** A conversation response is running, so the terminal waits: one agent works at a time. */
function ConversationBusy({ bar = false }: { bar?: boolean }) {
  const projectId = useStore((s) => s.projectId);
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    const state = projectId ? useChat.getState().projects[projectId] : undefined;
    const owner = state?.record.conversations.find((c) =>
      c.turns.some((t) => t.state === 'running'),
    );
    if (!projectId || !owner) return;
    setStopping(true);
    await useChat.getState().cancel(projectId, owner.id);
    setStopping(false);
  };
  const actions = (
    <>
      <Button
        size="sm"
        variant="ghost"
        icon={<ChatCircle size={12} />}
        onClick={() => useAgentUi.getState().setPane('conversation')}
      >
        Switch to Conversation
      </Button>
      <Button
        size="sm"
        busy={stopping}
        icon={<Square size={11} weight="fill" />}
        onClick={() => void stop()}
      >
        Stop response
      </Button>
    </>
  );
  const words = 'A conversation response is running. One agent works in a project at a time.';
  return bar ? (
    <div className="agent-ended" role="status">
      <span className="truncate">{words}</span>
      {actions}
    </div>
  ) : (
    <div className="agent-empty" role="status">
      <p>{words}</p>
      <div className="row">{actions}</div>
    </div>
  );
}

/** What fills the terminal area while there is no session to show. */
export function SurfacePanel({ phase }: { phase: Phase }) {
  const adapters = useStore((s) => s.adapters);
  const setAgent = useStore((s) => s.setAgent);
  const pending = useAgentUi((s) => s.pending.length);
  const waiting = pending > 0 && (
    <p className="onboard-pending">
      {pending === 1 ? 'Your request is' : `${pending} requests are`} waiting and will be typed into
      the terminal once an agent is running.
    </p>
  );
  switch (phase.kind) {
    case 'conversation-running':
      return <ConversationBusy />;
    case 'read-only':
      return (
        <div className="agent-empty" role="status">
          <p>This project is open read-only, so agent sessions are off.</p>
        </div>
      );
    case 'detecting':
      return (
        <div className="agent-empty" role="status">
          <p className="row">
            <Spinner /> Looking for agent CLIs…
          </p>
          {waiting}
        </div>
      );
    case 'detect-failed':
      return (
        <div className="agent-empty" role="alert">
          <p>Could not check for agent CLIs.</p>
          <p className="agent-error">{phase.error}</p>
          <DetectAgain />
        </div>
      );
    case 'none-found':
      return (
        <div className="agent-empty agent-onboard">
          <div className="onboard">
            <h2>Connect an agent CLI</h2>
            <p className="onboard-lede">
              Bureau runs the agent CLI you already use, in this project’s folder. None of these was
              found on this machine.
            </p>
            <ul className="onboard-list">
              {phase.adapters.map((a) => (
                <AdapterHelp key={a.adapterId} adapter={a} />
              ))}
            </ul>
            <div className="row">
              <DetectAgain />
              <Button size="sm" variant="ghost" icon={<GearSix size={12} />} onClick={openSettings}>
                Agent settings
              </Button>
            </div>
            {waiting}
          </div>
        </div>
      );
    case 'choose':
      return (
        <div className="agent-empty">
          <p>
            {phase.missing
              ? `${phase.missing.label} was not found on this machine. Start another agent instead:`
              : 'Several agent CLIs are installed. Which one should run in this project?'}
          </p>
          <div className="onboard-choices">
            {phase.options.map((a) => (
              <Button
                key={a.adapterId}
                icon={<Play size={12} weight="fill" />}
                onClick={() => {
                  setAgent(a.adapterId);
                  startAdapter(a.adapterId);
                }}
              >
                {a.label}
                {a.version ? <span className="onboard-version mono"> {a.version}</span> : null}
              </Button>
            ))}
          </div>
          <p className="onboard-hint">Your choice is remembered. Change it in Settings.</p>
          {waiting}
        </div>
      );
    case 'ready':
      return (
        <div className="agent-empty" role="status">
          <p>Ready to start {phase.adapter.label}.</p>
          <Button
            size="sm"
            icon={<Play size={12} weight="fill" />}
            onClick={() => startAdapter(phase.adapter.adapterId)}
          >
            Start agent
          </Button>
          {waiting}
        </div>
      );
    case 'starting':
      return (
        <div className="agent-empty" role="status">
          <p className="row">
            <Spinner /> Starting {adapterLabel(adapters, phase.adapterId)}…
          </p>
          {waiting}
        </div>
      );
    case 'start-failed':
      return (
        <div className="agent-empty" role="alert">
          <p>{adapterLabel(adapters, phase.adapterId)} did not start.</p>
          <p className="agent-error">{phase.error}</p>
          <div className="row">
            <Button
              size="sm"
              icon={<ArrowClockwise size={12} />}
              onClick={() => startAdapter(phase.adapterId)}
            >
              Try again
            </Button>
            <Button size="sm" variant="ghost" icon={<GearSix size={12} />} onClick={openSettings}>
              Agent settings
            </Button>
          </div>
          {waiting}
        </div>
      );
    default:
      return null;
  }
}

/** Over an ended (or failed-to-restart) transcript: the outcome and the way back, nothing automatic. */
export function EndedBar({ phase, startId }: { phase: Phase; startId: string | null }) {
  const session = useStore((s) => s.session);
  const adapters = useStore((s) => s.adapters);
  if (session && phase.kind === 'conversation-running') return <ConversationBusy bar />;
  if (
    !session ||
    (phase.kind !== 'ended' && phase.kind !== 'start-failed' && phase.kind !== 'starting')
  )
    return null;
  const status = sessionStatus(session);
  const label = adapterLabel(adapters, session.adapterId);
  if (phase.kind === 'starting')
    return (
      <div className="agent-ended" role="status">
        <Spinner /> Starting {adapterLabel(adapters, phase.adapterId)}…
      </div>
    );
  return (
    <div
      className={`agent-ended ${phase.kind === 'start-failed' ? 'failed' : ''}`}
      role={phase.kind === 'start-failed' ? 'alert' : 'status'}
    >
      {phase.kind === 'start-failed' ? (
        <span className="agent-error truncate">
          {adapterLabel(adapters, phase.adapterId)} did not start: {phase.error}
        </span>
      ) : (
        <State
          state={session.state}
          tone={status.tone}
          label={`${label} · ${status.word}${status.exit ? ` · ${status.exit}` : ''}`}
        />
      )}
      {session.lastError && phase.kind === 'ended' && (
        <span className="agent-error truncate">{session.lastError}</span>
      )}
      {startId && (
        <Button
          size="sm"
          icon={<Play size={12} weight="fill" />}
          onClick={() => startAdapter(startId)}
        >
          {phase.kind === 'start-failed' ? 'Try again' : 'Start again'}
        </Button>
      )}
    </div>
  );
}

/** Requests asked of the agent that have not been typed into the terminal yet. */
export function PendingBar({ live }: { live: boolean }) {
  const pending = useAgentUi((s) => s.pending);
  const [failed, setFailed] = useState(false);
  if (!pending.length) return null;
  const first = pending[0]!;
  return (
    <div className="agent-pending" role="status">
      <span className="agent-pending-label">
        {pending.length === 1 ? 'Waiting to type' : `${pending.length} requests waiting to type`}
      </span>
      <span className="agent-pending-text truncate">{first.text}</span>
      {failed && <span className="agent-error">The terminal is not taking input.</span>}
      <Button size="sm" disabled={!live} onClick={() => setFailed(!flushAsks(true))}>
        Paste now
      </Button>
      <Button size="sm" variant="ghost" onClick={() => useAgentUi.getState().discardPending()}>
        Discard
      </Button>
    </div>
  );
}
