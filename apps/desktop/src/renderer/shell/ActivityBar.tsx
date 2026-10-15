import React from 'react';
import { AppWindow, GearSix, GitBranch, Robot } from '@phosphor-icons/react';
import { useStore } from '../store';
import { needsYou } from '../lib/proposals';
import { LENSES } from '../project/lenses';
import { Kbd, Pulse, Tooltip } from '../ui/kit';
import { useAgentUi } from './agent/agent-store';
import { activitySignal, ARRIVING_MS, toolWords } from './agent/activity';
import { useRecent } from './agent/hooks';

interface Tab {
  id: string;
  /** Accessible name; the tooltip adds the shortcut. */
  label: string;
  shortcut?: string;
  icon: React.ReactNode;
  active: boolean;
  badge?: number;
  mark?: React.ReactNode;
  run: () => void;
}

/** What the Agent tab's icon says: live, working, or that the last recorded call failed. */
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
        <span className="activity-attention" aria-hidden="true">
          !
        </span>
      ),
      status: `last call failed: ${toolWords(lastFailed.tool)}${lastFailed.code ? ` (${lastFailed.code})` : ''}`,
    };
  if (live && arrivingNow) return { mark: <Pulse />, status: 'working' };
  if (live)
    return { mark: <span className="activity-live" aria-hidden="true" />, status: 'running' };
  return { mark: null, status: null };
}

/**
 * The vertical tab rail on the left edge of the workbench. The first tab is the agent — a full
 * terminal, not a panel. Below sit the project lenses and decisions; the bottom holds the
 * floating agent window toggle and Settings.
 */
export function ActivityBar() {
  const view = useStore((s) => s.view);
  const proposals = useStore((s) => s.proposals);
  const windowOpen = useStore((s) => s.agentWindowOpen);
  const { go, decide, set } = useStore.getState();
  const pending = needsYou(proposals).length;
  const onAgentTab = view.level === 'agent';
  const agent = useAgentMark();

  const tabs: Tab[] = [
    {
      id: 'agent',
      label: agent.status ? `Agent, ${agent.status}` : 'Agent',
      icon: <Robot size={22} />,
      active: onAgentTab,
      mark: agent.mark,
      run: () => go({ level: 'agent' }),
    },
    ...LENSES.map((l) => ({
      id: l.id,
      label: l.label,
      shortcut: `⌘${l.shortcut}`,
      icon: <l.icon size={22} />,
      active: view.level === 'project' && view.lens === l.id,
      run: () => go({ level: 'project', lens: l.id }),
    })),
    {
      id: 'decide',
      label: pending ? `Decisions, ${pending} to review` : 'Decisions',
      shortcut: '⌘⇧D',
      icon: <GitBranch size={22} />,
      active: view.level === 'decide',
      badge: pending,
      run: () => decide(null),
    },
  ];

  return (
    <nav className="activity-bar" aria-label="Views">
      {tabs.map((t) => (
        <Tooltip key={t.id} side="right" label={<TipLabel text={t.label} shortcut={t.shortcut} />}>
          <button
            type="button"
            className="activity-btn"
            aria-label={t.label}
            aria-keyshortcuts={t.shortcut?.replace('⌘', 'Meta+').replace('⇧', 'Shift+')}
            aria-current={t.active ? 'page' : undefined}
            onClick={t.run}
          >
            {t.icon}
            {t.mark}
            {t.badge ? (
              <span className="activity-badge" aria-hidden="true">
                {t.badge}
              </span>
            ) : null}
          </button>
        </Tooltip>
      ))}
      <div className="activity-bottom">
        {!onAgentTab && (
          <Tooltip side="right" label={<TipLabel text="Agent window" shortcut="⌘J" />}>
            <button
              type="button"
              className="activity-btn"
              aria-label="Agent window"
              aria-keyshortcuts="Meta+J"
              aria-pressed={windowOpen}
              data-agent-window-toggle=""
              onClick={() => set({ agentWindowOpen: !windowOpen })}
            >
              <AppWindow size={22} />
            </button>
          </Tooltip>
        )}
        <Tooltip side="right" label={<TipLabel text="Settings" shortcut="⌘," />}>
          <button
            type="button"
            className="activity-btn"
            aria-label="Settings"
            aria-keyshortcuts="Meta+,"
            onClick={() => set({ settingsOpen: true })}
          >
            <GearSix size={22} />
          </button>
        </Tooltip>
      </div>
    </nav>
  );
}

function TipLabel({ text, shortcut }: { text: string; shortcut?: string }) {
  return (
    <span className="tip-label">
      {text.charAt(0).toUpperCase() + text.slice(1)}
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </span>
  );
}
