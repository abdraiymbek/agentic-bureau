import React from 'react';
import {
  ClockCounterClockwise,
  Files,
  GearSix,
  GitBranch,
  Graph,
  Package,
  Robot,
} from '@phosphor-icons/react';
import { openProposals, useStore } from '../store';
import { Pulse } from '../ui/kit';

/**
 * The vertical tab rail on the left edge of the workbench. The first tab is the
 * agent — a full terminal, not a panel. Below sit the project lenses and
 * decisions; the bottom holds the floating agent window toggle and Settings.
 */
export function ActivityBar() {
  const view = useStore((s) => s.view);
  const session = useStore((s) => s.session);
  const proposals = useStore((s) => s.proposals);
  const windowOpen = useStore((s) => s.agentWindowOpen);
  const { go, decide, set } = useStore.getState();
  const live = session?.state === 'running';
  const pending = openProposals(proposals).length;
  const onAgentTab = view.level === 'agent';

  const tabs = [
    {
      id: 'agent',
      label: 'Agent',
      icon: <Robot size={22} />,
      active: onAgentTab,
      live,
      run: () => go({ level: 'agent' }),
    },
    {
      id: 'flow',
      label: 'Flow (⌘1)',
      icon: <Graph size={22} />,
      active: view.level === 'project' && view.lens === 'flow',
      run: () => go({ level: 'project', lens: 'flow' }),
    },
    {
      id: 'parts',
      label: 'Parts (⌘2)',
      icon: <Package size={22} />,
      active: view.level === 'project' && view.lens === 'parts',
      run: () => go({ level: 'project', lens: 'parts' }),
    },
    {
      id: 'timeline',
      label: 'Timeline (⌘3)',
      icon: <ClockCounterClockwise size={22} />,
      active: view.level === 'project' && view.lens === 'timeline',
      run: () => go({ level: 'project', lens: 'timeline' }),
    },
    {
      id: 'files',
      label: 'Files (⌘4)',
      icon: <Files size={22} />,
      active: view.level === 'project' && view.lens === 'files',
      run: () => go({ level: 'project', lens: 'files' }),
    },
    {
      id: 'decide',
      label: 'Decisions (⌘⇧D)',
      icon: <GitBranch size={22} />,
      active: view.level === 'decide',
      badge: pending,
      run: () => decide(null),
    },
  ];

  return (
    <nav className="activity-bar" aria-label="Views">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          className="activity-btn"
          aria-label={t.label}
          title={t.label}
          aria-current={t.active ? 'page' : undefined}
          onClick={t.run}
        >
          {t.icon}
          {t.live && <Pulse />}
          {t.badge ? <span className="activity-badge">{t.badge}</span> : null}
        </button>
      ))}
      <div className="activity-bottom">
        {!onAgentTab && (
          <button
            type="button"
            className="activity-btn"
            aria-label="Agent window (⌘J)"
            title="Agent window (⌘J)"
            aria-pressed={windowOpen}
            onClick={() => set({ agentWindowOpen: !windowOpen })}
          >
            <Robot size={22} />
            {live && <Pulse />}
          </button>
        )}
        <button
          type="button"
          className="activity-btn"
          aria-label="Settings (⌘,)"
          title="Settings (⌘,)"
          onClick={() => set({ settingsOpen: true })}
        >
          <GearSix size={22} />
        </button>
      </div>
    </nav>
  );
}
