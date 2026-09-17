import type { Command } from "../core/commands";
import type { NavSection } from "../settings/settingsState";
import { canOpenTab, openTab, type TabSet, type TabView } from "../tabs/tabModel";
import { todayIso } from "./model";
import type { PlanningStore } from "./planningStore";

export interface PlanningWiringDeps {
  vaultId: () => string | null;
  tabs: () => TabSet;
  setTabs: (updater: (s: TabSet) => TabSet) => void;
  flushAutosave: () => Promise<void>;
  selectSection: (section: NavSection) => void;
  store: PlanningStore;
}

export interface PlanningWiring {
  openProject: (path: string) => void;
  openCalendar: () => void;
  activeProjectPath: () => string | null;
  selectNotes: () => void;
  selectProjects: () => void;
  selectCalendar: () => void;
  newProject: () => void;
  commands: Command[];
}

export function createPlanningWiring(deps: PlanningWiringDeps): PlanningWiring {
  const go = (view: TabView) => {
    if (deps.vaultId() === null || !canOpenTab(deps.tabs(), view)) return;
    void (async () => {
      await deps.flushAutosave();
      deps.setTabs((s) => openTab(s, view));
    })();
  };

  const openProject = (path: string) => go({ kind: "project", path });
  const openCalendar = () => {
    deps.selectSection("calendar");
    go({ kind: "calendar" });
  };

  const selectNotes = () => deps.selectSection("notes");
  const selectProjects = () => deps.selectSection("projects");
  const selectCalendar = () => openCalendar();

  const activeProjectPath = (): string | null => {
    const t = deps.tabs().tabs.find((x) => x.id === deps.tabs().activeId);
    return t !== undefined && t.view.kind === "project" ? t.view.path : null;
  };

  const newProject = () => {
    deps.selectSection("projects");
    deps.store.requestProjectCreate();
  };

  return {
    openProject,
    openCalendar,
    activeProjectPath,
    selectNotes,
    selectProjects,
    selectCalendar,
    newProject,
    commands: [
      {
        id: "nav.notes",
        title: "Go to Notes",
        when: () => deps.vaultId() !== null,
        run: selectNotes,
      },
      {
        id: "nav.projects",
        title: "Go to Projects",
        when: () => deps.vaultId() !== null,
        run: selectProjects,
      },
      {
        id: "nav.calendar",
        title: "Go to Calendar",
        when: () => deps.vaultId() !== null,
        run: selectCalendar,
      },
      {
        id: "project.new",
        title: "New project",
        when: () => deps.vaultId() !== null,
        run: newProject,
      },
      {
        id: "calendar.new",
        title: "New event",
        when: () => deps.vaultId() !== null,
        run: () => {
          selectCalendar();
          deps.store.requestEventDraft(todayIso());
        },
      },
    ],
  };
}
