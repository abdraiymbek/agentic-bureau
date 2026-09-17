import type { Command } from "../core/commands";
import type { NavSection } from "../settings/settingsState";
import { canOpenTab, openTab, type TabSet } from "../tabs/tabModel";
import type { AgentLaunch, AgentStore } from "./agentStore";

export interface AgentWiringDeps {
  vaultId: () => string | null;
  tabs: () => TabSet;
  setTabs: (updater: (s: TabSet) => TabSet) => void;
  selectSection: (section: NavSection) => void;
  store: AgentStore;
}

export interface AgentWiring {
  openAgents: () => void;
  launchAgent: (spec: AgentLaunch) => void;
  openSessionTab: (tabKey: string) => void;
  commands: Command[];
}

export function createAgentWiring(deps: AgentWiringDeps): AgentWiring {
  const go = (view: Parameters<typeof openTab>[1]) => {
    if (deps.vaultId() === null || !canOpenTab(deps.tabs(), view)) return;
    deps.setTabs((s) => openTab(s, view));
  };

  const openAgents = () => {
    deps.selectSection("agents");
    go({ kind: "agents" });
  };

  const openSessionTab = (tabKey: string) =>
    go({ kind: "agent", key: tabKey });

  const launchAgent = (spec: AgentLaunch) => {
    const tabKey = deps.store.prepareLaunch(spec);
    deps.selectSection("agents");
    go({ kind: "agent", key: tabKey });
  };

  return {
    openAgents,
    launchAgent,
    openSessionTab,
    commands: [
      {
        id: "nav.agents",
        title: "Go to Agents",
        when: () => deps.vaultId() !== null,
        run: openAgents,
      },
      {
        id: "agent.new",
        title: "Start agent session",
        when: () => deps.vaultId() !== null,
        run: openAgents,
      },
    ],
  };
}
