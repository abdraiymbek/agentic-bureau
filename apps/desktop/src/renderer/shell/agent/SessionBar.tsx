import React, { useState } from 'react';
import {
  ArrowClockwise,
  ArrowLineRight,
  ArrowsOut,
  BookOpen,
  Broom,
  CaretDown,
  CaretUp,
  ChatCircle,
  CopySimple,
  DotsThree,
  GearSix,
  HandPalm,
  MagnifyingGlass,
  Minus,
  PictureInPicture,
  Play,
  Plus,
  SidebarSimple,
  Square,
  StopCircle,
  TerminalWindow,
} from '../../ui/icons';
import { useStore } from '../../store';
import { errMsg } from '../../api';
import { interruptAgent, restartAgent, stopAgent } from '../../lib/actions';
import { Button, ConfirmButton, IconButton, Menu, Pulse, Segmented } from '../../ui/kit';
import type { MenuItem } from '../../ui/kit';
import { useChat } from '../../chat/chat-store';
import { conversationThreads } from '../../chat/threads';
import { useAgentUi, type AgentPane } from './agent-store';
import { sessionCounts } from './activity';
import { useRailContent } from './useRailContent';
import { copyText } from './clipboard';
import { useNow, useRecent } from './hooks';
import { adapterLabel, elapsedLabel, sessionFacts, sessionStatus } from './session-view';
import type { TerminalEngine } from './terminal';

function useSessionView() {
  const session = useStore((s) => s.session);
  const adapters = useStore((s) => s.adapters);
  const chosen = useStore((s) => s.adapters.find((a) => a.adapterId === s.agentId)?.label ?? null);
  const activity = useAgentUi((s) => s.activity);
  const status = sessionStatus(session);
  const counts = session
    ? sessionCounts(session.id, activity.calls, activity.sessions, activity.summarySeq)
    : null;
  return {
    session,
    status,
    name: session ? adapterLabel(adapters, session.adapterId) : chosen,
    facts: session ? sessionFacts(session, counts) : [],
  };
}

function report(action: Promise<unknown>) {
  void action.catch((e) => useStore.getState().toast('error', errMsg(e)));
}

/** The conversation pane's record: its threads, the one shown, and whether a response runs. */
function useConversationView() {
  const projectId = useStore((s) => s.projectId);
  const state = useChat((s) => (projectId ? s.projects[projectId] : undefined));
  const threads = conversationThreads(state);
  const active = threads.find((t) => t.id === state?.activeId);
  const running = threads.find((t) => t.turns.some((turn) => turn.state === 'running'));
  return {
    projectId,
    threads,
    title: active?.title ?? 'New conversation',
    activeRunning: !!active && running?.id === active.id,
    running,
  };
}

/** Show a conversation, or start a new one when `id` is null. Drafts stay with their thread. */
function pickConversation(projectId: string | null, id: string | null) {
  if (!projectId) return;
  if (id === null) useChat.getState().newConversation(projectId);
  else useChat.getState().select(projectId, id);
  useAgentUi.getState().setRecordOpen(false);
}

function conversationItems(view: ReturnType<typeof useConversationView>): MenuItem[] {
  return [
    {
      label: 'New conversation',
      icon: <Plus size={14} />,
      onSelect: () => pickConversation(view.projectId, null),
    },
    ...[...view.threads].reverse().map((t) => ({
      label: `${t.title}${t.turns.some((turn) => turn.state === 'running') ? ' · running' : ''}`,
      icon: <ChatCircle size={14} />,
      onSelect: () => pickConversation(view.projectId, t.id),
    })),
  ];
}

function stopResponse(projectId: string | null, conversationId: string | undefined) {
  if (projectId && conversationId) report(useChat.getState().cancel(projectId, conversationId));
}

const PANES: { value: AgentPane; label: string }[] = [
  { value: 'conversation', label: 'Conversation' },
  { value: 'terminal', label: 'Terminal' },
];

/** The conversation's side of the session bar: which thread, and whether it is responding. */
function ConversationMain() {
  const view = useConversationView();
  return (
    <div className="session-main">
      <span className={`session-status tone-${view.running ? 'signal' : 'neutral'}`}>
        {view.running ? <Pulse /> : <span className="state-dot" aria-hidden="true" />}
        {view.running ? 'Responding' : 'Ready'}
      </span>
      <Menu
        items={conversationItems(view)}
        trigger={
          <button type="button" className="session-thread" aria-label="Conversations">
            <strong className="truncate">{view.title}</strong>
            <CaretDown size={11} />
          </button>
        }
      />
    </div>
  );
}

function ConversationControls() {
  const view = useConversationView();
  const recordOpen = useAgentUi((s) => s.recordOpen);
  return (
    <>
      {view.running && (
        <Button
          size="sm"
          icon={<Square size={11} weight="fill" />}
          onClick={() => stopResponse(view.projectId, view.running?.id)}
        >
          Stop response
        </Button>
      )}
      <IconButton
        size="sm"
        label="Project record"
        aria-pressed={recordOpen}
        onClick={() => useAgentUi.getState().setRecordOpen(!recordOpen)}
      >
        <BookOpen size={14} />
      </IconButton>
    </>
  );
}

function Elapsed({
  startedAt,
  endedAt,
  live,
}: {
  startedAt: string | null;
  endedAt: string | null;
  live: boolean;
}) {
  const now = useNow(1000, live);
  const text = elapsedLabel(startedAt, endedAt, now);
  return text ? (
    <span className="session-fact" data-key="elapsed">
      <span className="sr-only">{live ? 'Running for ' : 'Lasted '}</span>
      <span className="mono">{text}</span>
    </span>
  ) : null;
}

function CopyTranscript({ engine }: { engine: TerminalEngine | null }) {
  const copied = useAgentUi((s) => s.copied);
  const recent = useRecent(copied?.at ?? null, 1800);
  return (
    <>
      <IconButton
        size="sm"
        label="Copy transcript"
        disabled={!engine}
        onClick={() => {
          if (!engine) return;
          void copyText(engine.transcript()).then((ok) =>
            ok
              ? useAgentUi.getState().noteCopied('transcript')
              : useStore.getState().toast('error', 'The clipboard did not accept the transcript.'),
          );
        }}
      >
        <CopySimple size={14} />
      </IconButton>
      <span className="session-copied" role="status">
        {recent && copied
          ? copied.what === 'transcript'
            ? 'Transcript copied'
            : 'Selection copied'
          : ''}
      </span>
    </>
  );
}

/**
 * The slim bar above the agent on the Agent tab: which pane shows, then that pane's state and
 * controls. Every value comes from the session or conversation record.
 */
export function SessionBar({
  engine,
  onSearch,
}: {
  engine: TerminalEngine | null;
  onSearch: () => void;
}) {
  const { session, status, name, facts } = useSessionView();
  const railOpen = useAgentUi((s) => s.railOpen);
  const pane = useAgentUi((s) => s.pane);
  const railIdle = useRailContent().idle;
  const set = useStore((s) => s.set);
  // A CLI that ignores the polite stop is ended a few seconds later; until then the press shows.
  const [pending, setPending] = useState<'stop' | 'restart' | null>(null);
  const run = (which: 'stop' | 'restart', action: () => Promise<unknown>) => {
    setPending(which);
    report(action().finally(() => setPending(null)));
  };
  const terminal = pane === 'terminal';
  return (
    <header className="session-bar" aria-label="Agent session">
      <Segmented
        label="Agent pane"
        value={pane}
        options={PANES}
        onChange={(next) => useAgentUi.getState().setPane(next)}
      />
      {terminal ? (
        <div className="session-main">
          <span className={`session-status tone-${status.tone}`}>
            {status.live ? <Pulse /> : <span className="state-dot" aria-hidden="true" />}
            {status.word}
            {status.over && status.exit && <span className="session-exit"> · {status.exit}</span>}
          </span>
          {name && <strong className="session-name truncate">{name}</strong>}
          {facts.map((f) => (
            <span
              key={f.key}
              data-key={f.key}
              className={`session-fact ${f.tone ? `tone-${f.tone}` : ''}`}
            >
              <span className="sr-only">{f.label}: </span>
              {f.key === 'model' ? <span className="mono">{f.value}</span> : f.value}
            </span>
          ))}
          {session && (
            <Elapsed startedAt={session.startedAt} endedAt={session.endedAt} live={status.live} />
          )}
        </div>
      ) : (
        <ConversationMain />
      )}
      <div className="session-controls">
        {!terminal && <ConversationControls />}
        {terminal && status.live && (
          <>
            <IconButton
              size="sm"
              label="Interrupt (sends Ctrl-C)"
              disabled={pending !== null}
              onClick={() => report(interruptAgent())}
            >
              <HandPalm size={14} />
            </IconButton>
            <ConfirmButton
              size="sm"
              tone="neutral"
              icon={<ArrowClockwise size={13} />}
              label="Restart"
              confirmLabel="Restart session?"
              busy={pending === 'restart'}
              disabled={pending === 'stop'}
              onConfirm={() => run('restart', restartAgent)}
            />
            <ConfirmButton
              size="sm"
              icon={<StopCircle size={13} />}
              label="Stop"
              confirmLabel="Stop session?"
              busy={pending === 'stop'}
              disabled={pending === 'restart'}
              onConfirm={() => run('stop', stopAgent)}
            />
          </>
        )}
        {terminal && session && (
          <>
            <span className="session-sep" aria-hidden="true" />
            <IconButton size="sm" label="Search scrollback (⌘F)" onClick={onSearch}>
              <MagnifyingGlass size={14} />
            </IconButton>
            <CopyTranscript engine={engine} />
            <IconButton
              size="sm"
              label="Clear screen (the session keeps running)"
              onClick={() => engine?.clear()}
            >
              <Broom size={14} />
            </IconButton>
          </>
        )}
        <span className="session-sep" aria-hidden="true" />
        <IconButton
          size="sm"
          label={
            railIdle
              ? 'Activity is not available from this host'
              : railOpen
                ? 'Hide activity'
                : 'Show activity'
          }
          aria-pressed={railIdle ? undefined : railOpen}
          aria-disabled={railIdle || undefined}
          onClick={() => !railIdle && useAgentUi.getState().setRailOpen(!railOpen)}
        >
          <SidebarSimple size={14} mirrored />
        </IconButton>
        <IconButton
          size="sm"
          label="Agent settings (⌘,)"
          onClick={() => {
            useAgentUi.getState().setSettingsSection('agents');
            set({ settingsOpen: true });
          }}
        >
          <GearSix size={14} />
        </IconButton>
      </div>
    </header>
  );
}

/**
 * The floating window's header: the same session in fewer words, the window's own controls, and
 * the session controls behind one menu. Stopping or restarting asks once more below the header.
 */
export function WindowHeader({
  engine,
  onSearch,
  docked,
  collapsed,
  onDock,
  onCollapse,
  onClose,
  onPointerDown,
  startLabel,
  onStart,
}: {
  engine: TerminalEngine | null;
  onSearch: () => void;
  docked: boolean;
  collapsed: boolean;
  onDock: () => void;
  onCollapse: () => void;
  onClose: () => void;
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
  startLabel: string | null;
  onStart: () => void;
}) {
  const { session, status, name, facts } = useSessionView();
  const conversation = useConversationView();
  const pane = useAgentUi((s) => s.pane);
  const go = useStore((s) => s.go);
  const set = useStore((s) => s.set);
  const [confirm, setConfirm] = useState<'stop' | 'restart' | null>(null);
  const model = facts.find((f) => f.key === 'model');
  const terminal = pane === 'terminal';
  const recordOpen = useAgentUi((s) => s.recordOpen);
  const paneItem: MenuItem = terminal
    ? {
        label: 'Show the conversation',
        icon: <ChatCircle size={14} />,
        onSelect: () => useAgentUi.getState().setPane('conversation'),
      }
    : {
        label: 'Show the terminal',
        icon: <TerminalWindow size={14} />,
        onSelect: () => useAgentUi.getState().setPane('terminal'),
      };
  const conversationMenu: MenuItem[] = [
    ...(conversation.running
      ? [
          {
            label: 'Stop response',
            icon: <Square size={14} />,
            onSelect: () => stopResponse(conversation.projectId, conversation.running?.id),
          },
        ]
      : []),
    {
      label: recordOpen ? 'Close the project record' : 'Project record',
      icon: <BookOpen size={14} />,
      onSelect: () => useAgentUi.getState().setRecordOpen(!recordOpen),
    },
    ...conversationItems(conversation),
  ];
  const terminalMenu: MenuItem[] = [
    ...(status.live
      ? [
          {
            label: 'Interrupt (Ctrl-C)',
            icon: <HandPalm size={14} />,
            onSelect: () => report(interruptAgent()),
          },
          {
            label: 'Restart session…',
            icon: <ArrowClockwise size={14} />,
            onSelect: () => setConfirm('restart'),
          },
          {
            label: 'Stop session…',
            icon: <StopCircle size={14} />,
            tone: 'err' as const,
            onSelect: () => setConfirm('stop'),
          },
        ]
      : session && startLabel
        ? [{ label: `Start ${startLabel} again`, icon: <Play size={14} />, onSelect: onStart }]
        : []),
    ...(session
      ? [
          {
            label: 'Search scrollback',
            icon: <MagnifyingGlass size={14} />,
            shortcut: '⌘F',
            onSelect: onSearch,
          },
          {
            label: 'Copy transcript',
            icon: <CopySimple size={14} />,
            onSelect: () => {
              if (engine)
                void copyText(engine.transcript()).then(
                  (ok) => ok && useAgentUi.getState().noteCopied('transcript'),
                );
            },
          },
          { label: 'Clear screen', icon: <Broom size={14} />, onSelect: () => engine?.clear() },
        ]
      : []),
  ];
  const items: MenuItem[] = [
    paneItem,
    ...(terminal ? terminalMenu : conversationMenu),
    {
      label: 'Agent settings',
      icon: <GearSix size={14} />,
      shortcut: '⌘,',
      onSelect: () => {
        useAgentUi.getState().setSettingsSection('agents');
        set({ settingsOpen: true });
      },
    },
  ];
  return (
    <>
      <header className="agent-head" onPointerDown={onPointerDown}>
        {terminal ? (
          <>
            <span
              className={`agent-light ${status.live ? 'live' : session ? 'ready' : 'off'}`}
              aria-hidden="true"
            />
            <span className="agent-name truncate">{name ?? 'Agent'}</span>
            <span className={`agent-status tone-${status.tone}`}>
              {status.word}
              {status.over && status.exit ? ` · ${status.exit}` : ''}
            </span>
            {model && <span className="agent-model mono truncate">{model.value}</span>}
          </>
        ) : (
          <>
            <span
              className={`agent-light ${conversation.running ? 'live' : 'ready'}`}
              aria-hidden="true"
            />
            <span className="agent-name truncate">{conversation.title}</span>
            <span className={`agent-status tone-${conversation.running ? 'signal' : 'neutral'}`}>
              {conversation.running ? 'Responding' : 'Conversation'}
            </span>
          </>
        )}
        <span className="grow" />
        <Menu
          align="end"
          items={items}
          trigger={
            <IconButton size="sm" label={terminal ? 'Session actions' : 'Conversation actions'}>
              <DotsThree size={15} weight="bold" />
            </IconButton>
          }
        />
        <IconButton
          size="sm"
          label={docked ? 'Float over the stage' : 'Dock to the right'}
          onClick={onDock}
        >
          {docked ? <PictureInPicture size={13} /> : <ArrowLineRight size={13} />}
        </IconButton>
        {!docked && (
          <IconButton
            size="sm"
            label={collapsed ? 'Expand' : 'Collapse to header'}
            onClick={onCollapse}
          >
            {collapsed ? <CaretUp size={13} /> : <CaretDown size={13} />}
          </IconButton>
        )}
        <IconButton size="sm" label="Open the Agent tab" onClick={() => go({ level: 'agent' })}>
          <ArrowsOut size={13} />
        </IconButton>
        <IconButton size="sm" label="Close agent window (⌘J)" onClick={onClose}>
          <Minus size={13} />
        </IconButton>
      </header>
      {confirm && (
        <div
          className="agent-confirm"
          role="alertdialog"
          aria-label={confirm === 'stop' ? 'Stop session' : 'Restart session'}
        >
          <span className="grow">
            {confirm === 'stop'
              ? 'Stop the session? The CLI exits; the record keeps everything it saved.'
              : 'Restart the session? The CLI starts a new conversation.'}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={confirm === 'stop' ? 'danger' : 'secondary'}
            autoFocus
            onClick={() => {
              setConfirm(null);
              report(confirm === 'stop' ? stopAgent() : restartAgent());
            }}
          >
            {confirm === 'stop' ? 'Stop session' : 'Restart session'}
          </Button>
        </div>
      )}
    </>
  );
}
