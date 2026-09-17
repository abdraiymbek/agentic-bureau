import { For, type JSXElement } from "solid-js";

import type { ResolvedTheme } from "../styles/theme";
import type { TabSet } from "../tabs/tabModel";
import { AgentPane } from "./AgentPane";
import type { AgentStore } from "./agentStore";
import type { AgentVisual } from "./visual";

export function AgentTabPanes(props: {
  tabs: () => TabSet;
  vaultId: () => string | null;
  store: AgentStore;
  resolvedTheme: () => ResolvedTheme;
  visual: () => AgentVisual;
  visualImage: () => string;
  onOpenFile: (path: string) => void;
  onClosed: (tabKey: string) => void;
}): JSXElement {
  const agentKeys = () =>
    props
      .tabs()
      .tabs.filter((t) => t.view.kind === "agent")
      .map((t) =>
        t.view.kind === "agent"
          ? { tabId: t.id, key: t.view.key }
          : { tabId: t.id, key: "" },
      );

  return (
    <For each={agentKeys()}>
      {(entry) => (
        <div
          style={{
            display:
              entry.tabId === props.tabs().activeId ? "contents" : "none",
          }}
        >
          <AgentPane
            tabKey={entry.key}
            vaultId={props.vaultId()!}
            store={props.store}
            resolvedTheme={props.resolvedTheme}
            visual={props.visual}
            visualImage={props.visualImage}
            onOpenFile={props.onOpenFile}
            onClosed={() => props.onClosed(entry.key)}
          />
        </div>
      )}
    </For>
  );
}
