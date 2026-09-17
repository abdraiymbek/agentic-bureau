import { Match, Switch, type JSXElement } from "solid-js";

import SegmentedControl from "@ds/components/forms/SegmentedControl/SegmentedControl";

import Backlinks from "../backlinks/Backlinks";
import UnlinkedMentions from "../backlinks/UnlinkedMentions";
import FeatureBoundary from "../core/FeatureBoundary";
import IntegrityPanel from "../integrity/IntegrityPanel";
import type { SettingsState } from "../settings/settingsState";

const RIGHT_SIDEBAR_TABS = [
  { value: "backlinks", label: "Backlinks" },
  { value: "unlinked_mentions", label: "Mentions" },
  { value: "integrity", label: "Integrity" },
];

export function RightSidebar(props: {
  settings: SettingsState;
  vaultId: string | null;
  selectedPath: string | null;
  refreshSignal: number;
  onNavigate: (path: string) => void;
  onRepaired: () => void;
}): JSXElement {
  const s = () => props.settings;
  return (
    <aside
      class="side side--right"
      classList={{ "side--collapsed": s().rightSidebarCollapsed() }}
    >
      <div class="side__body">
        <SegmentedControl
          class="rs-tabs"
          variant="pill"
          ariaLabel="Sidebar panels"
          value={s().rightSidebarPanel()}
          options={RIGHT_SIDEBAR_TABS}
          onChange={(v) => s().setRightSidebarPanelValue(v)}
        />
        <div class="rs-body">
          <FeatureBoundary feature="Sidebar panel">
            <Switch>
              <Match when={s().rightSidebarPanel() === "backlinks"}>
                <Backlinks
                  vaultId={props.vaultId}
                  path={props.selectedPath}
                  refreshSignal={props.refreshSignal}
                  onRowClick={props.onNavigate}
                />
              </Match>
              <Match when={s().rightSidebarPanel() === "unlinked_mentions"}>
                <UnlinkedMentions
                  vaultId={props.vaultId}
                  path={props.selectedPath}
                  refreshSignal={props.refreshSignal}
                  onRowClick={props.onNavigate}
                />
              </Match>
              <Match when={s().rightSidebarPanel() === "integrity"}>
                <IntegrityPanel
                  vaultId={props.vaultId}
                  refreshSignal={props.refreshSignal}
                  onRowClick={props.onNavigate}
                  onRepaired={props.onRepaired}
                />
              </Match>
            </Switch>
          </FeatureBoundary>
        </div>
      </div>
    </aside>
  );
}
