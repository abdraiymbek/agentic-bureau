import { For, type JSXElement } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import IconButton from "@ds/components/forms/IconButton/IconButton";
import Icon from "@ds/components/graphics/Icon/Icon";

import type { AgentStore } from "./agentStore";

export function AgentSessionsPanel(props: {
  store: AgentStore;
  onOpenSession: (tabKey: string) => void;
  onNew: () => void;
}): JSXElement {
  const sessions = () => [...props.store.sessions().values()];

  return (
    <div class="plan-panel">
      <div class="plan-panel__head">
        <span class="plan-panel__title">Agents</span>
        <IconButton label="Agents home" size="sm" onClick={props.onNew}>
          <Icon name="plus" />
        </IconButton>
      </div>
      <div class="plan-panel__list" role="list">
        <For
          each={sessions()}
          fallback={
            <p class="plan-panel__empty">
              No agent sessions. Agents run locally in this workspace.
            </p>
          }
        >
          {(s) => (
            <Button
              variant="ghost"
              block
              class="plan-row"
              onClick={() => props.onOpenSession(s.tabKey)}
            >
              <span class="plan-row__name">{s.provider}</span>
              <span class="plan-row__meta">
                <span
                  class="agents-session__status"
                  data-status={s.status}
                >
                  {s.status}
                </span>
                <span class="plan-row__deadline">
                  {s.prompt || s.cwd || "interactive"}
                </span>
              </span>
            </Button>
          )}
        </For>
      </div>
    </div>
  );
}
