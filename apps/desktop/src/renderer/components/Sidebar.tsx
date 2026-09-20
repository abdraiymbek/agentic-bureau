import React, { useState } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  Cube,
  FileText,
  Folder,
  GitBranch,
  ListChecks,
  ClockCounterClockwise,
  House,
  PlugsConnected,
  CaretUpDown,
  ArrowSquareOut,
  CheckSquare,
  SquaresFour,
  WarningCircle,
} from '@phosphor-icons/react';
import { useStore, type Nav } from '../store';
import { cmd, errMsg } from '../api';
import { ArtifactIcon, typeLabels } from './ui';

export const NAV_ITEMS: { id: Nav; label: string; icon: typeof Cube }[] = [
  { id: 'overview', label: 'Overview', icon: House },
  { id: 'requirements', label: 'Requirements', icon: ListChecks },
  { id: 'artifacts', label: 'Design files', icon: Cube },
  { id: 'components', label: 'Parts & materials', icon: CheckSquare },
  { id: 'reviews', label: 'Review queue', icon: GitBranch },
  { id: 'history', label: 'History & impact', icon: ClockCounterClockwise },
  { id: 'files', label: 'Files & exports', icon: Folder },
  { id: 'connections', label: 'Connections', icon: PlugsConnected },
  { id: 'design-system', label: 'Design system', icon: SquaresFour },
];

export function Sidebar() {
  const {
    nav,
    navigate,
    proposals,
    artifacts,
    openArtifact,
    selectedArtifactId,
    recentArtifactIds,
    project,
    projectId,
    set,
    toast,
  } = useStore();
  const [openProjects, setOpenProjects] = useState<{ id: string; name: string; root: string }[]>(
    [],
  );
  const pending = proposals.filter((p) => p.state === 'pending').length;
  // The working set: objects the engineer actually opened, newest first.
  const recent = recentArtifactIds
    .map((id) => artifacts.find((v) => v.artifact.id === id))
    .filter((v): v is NonNullable<typeof v> => !!v);
  const closeProject = async () => {
    try {
      await cmd('project.close', {}, { projectId: projectId ?? undefined });
      set({
        project: null,
        projectId: null,
        projectPath: null,
        artifacts: [],
        proposals: [],
        session: null,
        events: [],
        selectedArtifactId: null,
        nav: 'overview',
      });
      await window.omenflow.setActiveProject(null);
    } catch (error) {
      toast('error', errMsg(error));
    }
  };
  return (
    <aside className="sidebar" aria-label="Project navigation">
      <Menu.Root
        onOpenChange={(open) => {
          if (open)
            void cmd<{ projects: typeof openProjects }>('project.list_open')
              .then((r) => setOpenProjects(r.projects))
              .catch(() => {});
        }}
      >
        <Menu.Trigger asChild>
          <button className="project-switcher">
            <span className="project-avatar">{project?.name.slice(0, 1).toUpperCase() ?? 'O'}</span>
            <span className="project-switcher-copy">
              <strong>{project?.name ?? 'Workspace'}</strong>
              <small>Local project</small>
            </span>
            <CaretUpDown size={13} className="faint" />
          </button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content className="menu-content" sideOffset={4} align="start">
            <Menu.Label className="menu-label">Open projects</Menu.Label>
            {openProjects.map((p) => (
              <Menu.Item
                key={p.id}
                className="menu-item"
                onSelect={() => {
                  if (p.id === projectId) return;
                  void (async () => {
                    try {
                      const r = await cmd<{
                        project: NonNullable<typeof project>;
                        projectId: string;
                        readOnly?: boolean;
                      }>('project.open', { path: p.root });
                      set({
                        project: r.project,
                        projectId: r.projectId,
                        readOnly: !!r.readOnly,
                        projectPath: p.root,
                        selectedArtifactId: null,
                        nav: 'overview',
                        artifacts: [],
                        proposals: [],
                        events: [],
                        jobs: [],
                        session: null,
                      });
                      await window.omenflow.setActiveProject(p.id);
                      const s = useStore.getState();
                      await Promise.all([
                        s.refreshArtifacts(),
                        s.refreshProposals(),
                        s.refreshEvents(),
                        s.refreshSession(),
                        s.refreshJobs(),
                      ]);
                    } catch (error) {
                      toast('error', errMsg(error));
                    }
                  })();
                }}
              >
                <Folder size={14} />
                {p.name}
                {p.id === projectId && <span className="faint">Current</span>}
              </Menu.Item>
            ))}
            <Menu.Separator className="menu-separator" />
            <Menu.Item
              className="menu-item"
              onSelect={() =>
                set({ projectId: null, project: null, selectedArtifactId: null, nav: 'overview' })
              }
            >
              <ArrowSquareOut size={14} />
              Open another project
            </Menu.Item>
            <Menu.Item className="menu-item" onSelect={() => void closeProject()}>
              Close project
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <nav className="nav-group" aria-label="Workspace">
        {NAV_ITEMS.slice(0, 7).map((n) => (
          <button
            key={n.id}
            className={`nav-item ${nav === n.id ? 'active' : ''}`}
            aria-current={nav === n.id ? 'page' : undefined}
            onClick={() => navigate(n.id)}
          >
            <n.icon size={16} />
            <span>{n.label}</span>
            {n.id === 'reviews' && pending > 0 && <span className="warn count">{pending}</span>}
          </button>
        ))}
      </nav>
      {recent.length > 0 && (
        <div className="nav-group" aria-label="Recently opened objects">
          <div className="nav-label">Recent objects</div>
          {recent.map((v) => {
            const active =
              selectedArtifactId === v.artifact.id &&
              (nav === 'artifacts' || nav === 'requirements');
            return (
              <button
                key={v.artifact.id}
                className={`nav-item ${active ? 'active' : ''}`}
                title={`${v.artifact.title} · ${typeLabels[v.artifact.type] ?? v.artifact.type}`}
                onClick={() => openArtifact(v.artifact.id, v.artifact.type)}
              >
                <ArtifactIcon type={v.artifact.type} size={14} />
                <span>{v.artifact.title}</span>
                {v.freshness !== 'current' && (
                  <WarningCircle size={13} className="warn" aria-label="Out of date" />
                )}
              </button>
            );
          })}
        </div>
      )}
      <div className="sidebar-bottom">
        <button
          className={`nav-item ${nav === 'connections' ? 'active' : ''}`}
          onClick={() => navigate('connections')}
        >
          <PlugsConnected size={16} />
          Connections
        </button>
        <button
          className={`nav-item ${nav === 'design-system' ? 'active' : ''}`}
          onClick={() => navigate('design-system')}
        >
          <FileText size={16} />
          Design system
        </button>
      </div>
    </aside>
  );
}
