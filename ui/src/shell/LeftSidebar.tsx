import { Show, Switch, Match, type JSXElement } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import IconButton from "@ds/components/forms/IconButton/IconButton";
import Icon from "@ds/components/graphics/Icon/Icon";

import { AgentSessionsPanel } from "../agents/AgentSessionsPanel";
import type { AgentStore } from "../agents/agentStore";
import type { FileEntry, RecentVault } from "../api/ipc";
import type { FileActions } from "../explorer/fileActions";
import { AgendaPanel } from "../planning/AgendaPanel";
import type { PlanningStore } from "../planning/planningStore";
import { ProjectsPanel } from "../planning/ProjectsPanel";
import type {
  LeftSidebarMode,
  NavSection,
} from "../settings/settingsState";
import { VaultSwitcher } from "../vaultSwitcher/VaultSwitcher";
import { ExplorerPanel } from "./composed";
import { SectionNav } from "./SectionNav";

export interface LeftSidebarProps {
  collapsed: boolean;
  section: () => NavSection;
  onSelectSection: (s: NavSection) => void;
  explorer: {
    files: FileEntry[];
    folders: string[];
    vaultId: string | null;
    selectedPath: string | null;
    mode: LeftSidebarMode;
    refreshSignal: number;
    actions: FileActions;
    onModeChange: (mode: string) => void;
    onRefresh: () => void;
    onNavigate: (path: string) => void;
    onSelectFile: (entry: FileEntry) => void;
    onRenameCommit: (from: string, target: string, isFolder: boolean) => void;
  };
  planning: PlanningStore;
  agents: AgentStore;
  activeProjectPath: () => string | null;
  onOpenProject: (path: string) => void;
  onOpenCalendar: () => void;
  onOpenFile: (path: string) => void;
  onOpenSession: (tabKey: string) => void;
  onNewAgent: () => void;
  footer: {
    vaultPath: string | null;
    recentVaults: RecentVault[];
    busy: boolean;
    switcherOpen: boolean;
    setSwitcherOpen: (open: boolean) => void;
    onSwitch: (path: string) => void;
    onRemove: (path: string) => void;
    onOpenFolder: () => void;
    onSettings: () => void;
  };
}

export function LeftSidebar(props: LeftSidebarProps): JSXElement {
  return (
    <aside
      class="side side--left"
      classList={{ "side--collapsed": props.collapsed }}
    >
      <div class="side__body">
        <SectionNav section={props.section} onSelect={props.onSelectSection} />
        <div class="side__section">
          <Switch
            fallback={
              <ExplorerPanel
                files={props.explorer.files}
                folders={props.explorer.folders}
                vaultId={props.explorer.vaultId}
                selectedPath={props.explorer.selectedPath}
                mode={props.explorer.mode}
                refreshSignal={props.explorer.refreshSignal}
                actions={props.explorer.actions}
                onModeChange={props.explorer.onModeChange}
                onRefresh={props.explorer.onRefresh}
                onNavigate={props.explorer.onNavigate}
                onSelectFile={props.explorer.onSelectFile}
                onRenameCommit={props.explorer.onRenameCommit}
              />
            }
          >
            <Match when={props.section() === "projects"}>
              <ProjectsPanel
                store={props.planning}
                activePath={props.activeProjectPath}
                onOpen={props.onOpenProject}
              />
            </Match>
            <Match when={props.section() === "calendar"}>
              <AgendaPanel
                store={props.planning}
                onOpenProject={props.onOpenProject}
                onOpenCalendar={props.onOpenCalendar}
                onOpenFile={props.onOpenFile}
              />
            </Match>
            <Match when={props.section() === "agents"}>
              <AgentSessionsPanel
                store={props.agents}
                onOpenSession={props.onOpenSession}
                onNew={props.onNewAgent}
              />
            </Match>
          </Switch>
        </div>
        <div class="side__footer">
          <div class="vault-switcher-anchor">
            <Button
              class="vault-btn"
              variant="ghost"
              onClick={() =>
                props.footer.setSwitcherOpen(!props.footer.switcherOpen)
              }
              disabled={props.footer.busy}
              ariaHaspopup="dialog"
              ariaExpanded={props.footer.switcherOpen}
              title="Switch vault"
            >
              <span class="vault-btn__name">
                {props.footer.vaultPath?.split("/").filter(Boolean).pop() ??
                  "vault"}
              </span>
              <span class="vault-btn__caret">
                <Icon name="chevron-down" size={14} />
              </span>
            </Button>
            <Show when={props.footer.switcherOpen}>
              <VaultSwitcher
                currentPath={props.footer.vaultPath}
                recentVaults={props.footer.recentVaults.filter(
                  (v) => v.path !== props.footer.vaultPath,
                )}
                onSwitch={props.footer.onSwitch}
                onRemove={props.footer.onRemove}
                onOpenFolder={props.footer.onOpenFolder}
                onDismiss={() => props.footer.setSwitcherOpen(false)}
              />
            </Show>
          </div>
          <IconButton label="Settings" onClick={props.footer.onSettings}>
            <Icon name="settings" />
          </IconButton>
        </div>
      </div>
    </aside>
  );
}
