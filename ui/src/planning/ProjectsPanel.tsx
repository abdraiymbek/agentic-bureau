import { createEffect, createSignal, For, on, Show, type JSXElement } from "solid-js";

import Badge from "@ds/components/feedback/Badge/Badge";
import Button from "@ds/components/forms/Button/Button";
import IconButton from "@ds/components/forms/IconButton/IconButton";
import TextInput from "@ds/components/forms/TextInput/TextInput";
import Icon from "@ds/components/graphics/Icon/Icon";

import type { ProjectSummary } from "../api/planning";
import { deadlineTone, todayIso } from "./model";
import type { PlanningStore } from "./planningStore";

function statusTone(status: string): "neutral" | "success" | "warning" {
  if (status === "done" || status === "archived") return "success";
  if (status === "paused") return "warning";
  return "neutral";
}

export function ProjectsPanel(props: {
  store: PlanningStore;
  activePath: () => string | null;
  onOpen: (path: string) => void;
}): JSXElement {
  const [creating, setCreating] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  let input: HTMLInputElement | undefined;

  const today = todayIso();

  createEffect(
    on(
      () => props.store.projectCreateIntent(),
      (n) => {
        if (n === 0) return;
        setCreating(true);
        queueMicrotask(() => input?.focus());
      },
    ),
  );

  const commit = async () => {
    const name = draft().trim();
    if (name === "") return;
    const path = await props.store.createProject(name, "");
    setDraft("");
    setCreating(false);
    if (path !== null) props.onOpen(path);
  };

  const row = (p: ProjectSummary) => (
    <Button
      variant="ghost"
      block
      class={
        props.activePath() === p.path ? "plan-row plan-row--active" : "plan-row"
      }
      onClick={() => props.onOpen(p.path)}
      title={p.path}
    >
      <span class="plan-row__name">{p.name}</span>
      <span class="plan-row__meta">
        <Show when={p.deadline}>
          {(d) => (
            <span
              class="plan-row__deadline"
              data-tone={deadlineTone(d(), p.status, today)}
            >
              <Icon name="flag" size={12} />
              {d()}
            </span>
          )}
        </Show>
        <Show when={p.status !== "active"}>
          <Badge tone={statusTone(p.status)}>{p.status}</Badge>
        </Show>
      </span>
    </Button>
  );

  return (
    <div class="plan-panel">
      <div class="plan-panel__head">
        <span class="plan-panel__title">Projects</span>
        <IconButton
          label="New project"
          size="sm"
          onClick={() => {
            setCreating((v) => !v);
            queueMicrotask(() => input?.focus());
          }}
        >
          <Icon name="plus" />
        </IconButton>
      </div>
      <Show when={creating()}>
        <div class="plan-panel__new">
          <TextInput
            size="sm"
            placeholder="Project name"
            value={draft()}
            onInput={setDraft}
            ref={(el) => (input = el)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              } else if (e.key === "Escape") {
                setCreating(false);
                setDraft("");
              }
            }}
          />
        </div>
      </Show>
      <div class="plan-panel__list" role="list">
        <For
          each={props.store.projects()}
          fallback={
            <p class="plan-panel__empty">
              No projects yet. Create one to group notes, tasks and deadlines.
            </p>
          }
        >
          {row}
        </For>
      </div>
    </div>
  );
}
