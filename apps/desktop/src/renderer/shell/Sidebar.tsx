import React from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  AppWindow,
  Archive,
  CaretDown,
  Export,
  FolderOpen,
  FolderSimple,
  GearSix,
  GitBranch,
  Globe,
  MagnifyingGlass,
  Plus,
  Robot,
  SignOut,
} from '../ui/icons';
import { useStore } from '../store';
import { needsYou } from '../lib/proposals';
import { LENSES } from '../project/lenses';
import { flagsOf, FLAG } from '../project/flow/describe';
import { Kbd, Mark, Pulse, Tooltip, typeMeta, type Layer } from '../ui/kit';
import { closeProject, exportProject, openProjectAt } from '../lib/actions';
import { errMsg } from '../api';
import { useChat } from '../chat/chat-store';
import { conversationThreads } from '../chat/threads';
import { useAgentUi } from './agent/agent-store';
import { activitySignal, ARRIVING_MS, toolWords } from './agent/activity';
import { useRecent } from './agent/hooks';

function report(action: Promise<unknown>) {
  void action.catch((e) => useStore.getState().toast('error', errMsg(e)));
}

/** How many conversations the sidebar lists before the agent's own menu takes over. */
const THREADS_SHOWN = 6;

/** The layers in the order the record reads, cause to consequence. */
const CENSUS_ORDER: Layer[] = ['intent', 'parts', 'design', 'evidence'];

type CensusState = 'missing' | 'stale' | 'review' | 'unbaselined' | 'current';

const CENSUS_WORDS: Record<CensusState, string> = {
  missing: 'missing input',
  stale: 'out of date',
  review: 'in review',
  unbaselined: 'without a baseline',
  current: 'current',
};

/** One square per object, grouped by layer: the state of the whole record at a glance. */
function Census() {
  const artifacts = useStore((s) => s.artifacts);
  if (artifacts.length === 0) return null;
  const groups = CENSUS_ORDER.map((layer) =>
    artifacts
      .filter((v) => typeMeta(v.artifact.type).layer === layer)
      .map((v): CensusState => {
        const flags = flagsOf(v, false, false);
        if (flags & FLAG.missing) return 'missing';
        if (flags & FLAG.stale) return 'stale';
        if (flags & FLAG.review) return 'review';
        if (flags & FLAG.noBaseline) return 'unbaselined';
        return 'current';
      }),
  ).filter((group) => group.length > 0);
  const counts = new Map<CensusState, number>();
  for (const state of groups.flat()) counts.set(state, (counts.get(state) ?? 0) + 1);
  const summary = [...counts].map(([state, n]) => `${n} ${CENSUS_WORDS[state]}`).join(', ');
  return (
    <Tooltip side="right" label={`${artifacts.length} objects: ${summary}`}>
      <div
        className="census"
        role="img"
        aria-label={`${artifacts.length} objects: ${summary}`}
        tabIndex={0}
      >
        {groups.map((group, i) => (
          <span key={i} className="census-layer">
            {group.map((state, j) => (
              <i key={j} className={`census-${state}`} />
            ))}
          </span>
        ))}
      </div>
    </Tooltip>
  );
}

/** What the agent row says: live, working, or that the last recorded call failed. */
function useAgentMark(): { mark: React.ReactNode; status: string | null } {
  const session = useStore((s) => s.session);
  const calls = useAgentUi((s) => s.activity.calls);
  const lastArrival = useAgentUi((s) => s.activity.lastArrival);
  const arrivingNow = useRecent(lastArrival, ARRIVING_MS);
  const live = session?.state === 'running';
  const { lastFailed } = activitySignal(calls, session?.id ?? null, lastArrival, Date.now());
  if (lastFailed)
    return {
      mark: (
        <span className="nav-attention" aria-hidden="true">
          !
        </span>
      ),
      status: `last call failed: ${toolWords(lastFailed.tool)}${lastFailed.code ? ` (${lastFailed.code})` : ''}`,
    };
  if (live) return { mark: <Pulse />, status: arrivingNow ? 'working' : 'running' };
  return { mark: null, status: null };
}

function NavItem({
  label,
  icon,
  active,
  shortcut,
  trailing,
  onSelect,
  name,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  shortcut?: string;
  trailing?: React.ReactNode;
  onSelect: () => void;
  /** Accessible name when it says more than the label. */
  name?: string;
}) {
  const button = (
    <button
      type="button"
      className="nav-item"
      aria-current={active ? 'page' : undefined}
      aria-label={name}
      aria-keyshortcuts={shortcut?.replace('⌘', 'Meta+').replace('⇧', 'Shift+')}
      onClick={onSelect}
    >
      {icon}
      <span className="nav-label truncate">{label}</span>
      {trailing}
    </button>
  );
  // Every row names itself in a tooltip: in a narrow window the sidebar is icons only.
  return (
    <Tooltip side="right" label={label} shortcut={shortcut}>
      {button}
    </Tooltip>
  );
}

/** The project's conversations, newest first, so a person can return to one in a click. */
function Conversations() {
  const projectId = useStore((s) => s.projectId);
  const view = useStore((s) => s.view);
  const pane = useAgentUi((s) => s.pane);
  const state = useChat((s) => (projectId ? s.projects[projectId] : undefined));
  const threads = [...conversationThreads(state)].reverse();
  const open = (id: string | null) => {
    if (!projectId) return;
    const chat = useChat.getState();
    if (id === null) chat.newConversation(projectId);
    else chat.select(projectId, id);
    useAgentUi.getState().setPane('conversation');
    useStore.getState().go({ level: 'agent' });
  };
  const showing = view.level === 'agent' && pane === 'conversation';
  return (
    <section className="nav-group" aria-label="Conversations">
      <div className="nav-group-head">
        <span>Conversations</span>
        <Tooltip side="right" label="New conversation">
          <button
            type="button"
            className="nav-group-action"
            aria-label="New conversation"
            onClick={() => open(null)}
          >
            <Plus size={12} />
          </button>
        </Tooltip>
      </div>
      {threads.length === 0 && <p className="nav-empty">None yet</p>}
      {threads.slice(0, THREADS_SHOWN).map((t) => {
        const running = t.turns.some((turn) => turn.state === 'running');
        return (
          <button
            key={t.id}
            type="button"
            className="nav-thread"
            aria-current={showing && state?.activeId === t.id ? 'true' : undefined}
            onClick={() => open(t.id)}
          >
            <span className="truncate">{t.title}</span>
            {running && <Pulse />}
          </button>
        );
      })}
    </section>
  );
}

function ProjectMenu({ name, readOnly }: { name: string; readOnly: boolean }) {
  const projectPath = useStore((s) => s.projectPath);
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button type="button" className="project-switch" aria-label={`Project ${name}`}>
          <Mark size={16} />
          <span className="project-switch-name truncate">{name}</span>
          {readOnly && <span className="sidebar-tag">Read-only</span>}
          <CaretDown size={12} />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="menu"
          align="start"
          sideOffset={6}
          // Escape closes the menu and nothing else; the workspace does not also zoom out.
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          <div className="menu-label truncate">{projectPath}</div>
          {readOnly && (
            <div className="menu-label">Open read-only: changes and agent sessions are off.</div>
          )}
          <Menu.Item
            className="menu-item"
            disabled={!projectPath}
            onSelect={() => projectPath && report(window.bureau.revealPath(projectPath))}
          >
            <FolderSimple size={14} /> Reveal project folder
          </Menu.Item>
          <Menu.Item className="menu-item" onSelect={() => void exportProject('build')}>
            <Export size={14} /> Export build package…
          </Menu.Item>
          <Menu.Item className="menu-item" onSelect={() => void exportProject('archive')}>
            <Archive size={14} /> Export project archive…
          </Menu.Item>
          <Menu.Item className="menu-item" onSelect={() => report(window.bureau.toggleResearch())}>
            <Globe size={14} /> Research browser
          </Menu.Item>
          <Menu.Separator className="menu-sep" />
          <Menu.Item className="menu-item" onSelect={() => report(openProjectAt())}>
            <FolderOpen size={14} /> Open another project…
          </Menu.Item>
          <Menu.Item className="menu-item" onSelect={() => report(closeProject())}>
            <SignOut size={14} /> Close project
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * The sidebar: the project and its state, search, the agent and decisions, the lenses, and
 * the conversations a person returns to. It replaces the icon rail and the title bar's
 * project menu; the sheet beside it holds the work.
 */
export function Sidebar() {
  const project = useStore((s) => s.project);
  const readOnly = useStore((s) => s.readOnly);
  const view = useStore((s) => s.view);
  const proposals = useStore((s) => s.proposals);
  const windowOpen = useStore((s) => s.agentWindowOpen);
  const { go, decide, set } = useStore.getState();
  const pending = needsYou(proposals).length;
  const agent = useAgentMark();
  const onAgentTab = view.level === 'agent';

  return (
    <aside className="sidebar" aria-label="Bureau">
      <div className="sidebar-top" data-tauri-drag-region />
      {project && <ProjectMenu name={project.name} readOnly={readOnly} />}
      <Census />

      <button
        type="button"
        className="nav-item nav-search"
        aria-keyshortcuts="Meta+K"
        onClick={() => set({ omniOpen: true })}
      >
        <MagnifyingGlass size={16} />
        <span className="nav-label">Search or ask</span>
        <Kbd>⌘K</Kbd>
      </button>

      <nav className="nav-group" aria-label="Views">
        <NavItem
          label="Agent"
          name={agent.status ? `Agent, ${agent.status}` : 'Agent'}
          icon={<Robot size={16} />}
          active={onAgentTab}
          trailing={agent.mark}
          onSelect={() => go({ level: 'agent' })}
        />
        <NavItem
          label="Decisions"
          name={pending ? `Decisions, ${pending} to review` : 'Decisions'}
          shortcut="⌘⇧D"
          icon={<GitBranch size={16} />}
          active={view.level === 'decide'}
          trailing={pending ? <span className="nav-count">{pending}</span> : null}
          onSelect={() => decide(null)}
        />
        <div className="nav-group-head">
          <span>Lenses</span>
        </div>
        {LENSES.map((l) => (
          <NavItem
            key={l.id}
            label={l.label}
            shortcut={`⌘${l.shortcut}`}
            icon={<l.icon size={16} />}
            active={view.level === 'project' && view.lens === l.id}
            onSelect={() => go({ level: 'project', lens: l.id })}
          />
        ))}
      </nav>

      <Conversations />

      <div className="sidebar-foot">
        {!onAgentTab && (
          <Tooltip side="right" label="Agent window" shortcut="⌘J">
            <button
              type="button"
              className="nav-item"
              aria-pressed={windowOpen}
              aria-keyshortcuts="Meta+J"
              data-agent-window-toggle=""
              onClick={() => set({ agentWindowOpen: !windowOpen })}
            >
              <AppWindow size={16} />
              <span className="nav-label">Agent window</span>
            </button>
          </Tooltip>
        )}
        <NavItem
          label="Settings"
          shortcut="⌘,"
          icon={<GearSix size={16} />}
          active={false}
          onSelect={() => set({ settingsOpen: true })}
        />
      </div>
    </aside>
  );
}
