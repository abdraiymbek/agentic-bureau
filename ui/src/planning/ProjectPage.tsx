import { createSignal, For, Show, type JSXElement } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import DatePicker from "@ds/components/forms/DatePicker/DatePicker";
import Select from "@ds/components/forms/Select/Select";
import TextInput from "@ds/components/forms/TextInput/TextInput";
import Icon from "@ds/components/graphics/Icon/Icon";

import type { ProjectOverview } from "../api/planning";
import { fmtDayHeading, fmtTime, todayIso } from "./model";
import type { PlanningStore } from "./planningStore";
import { ProjectTasks } from "./ProjectTasks";

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "done", label: "Done" },
  { value: "archived", label: "Archived" },
];

export function ProjectPage(props: {
  store: PlanningStore;
  path: string;
  onOpenFile: (path: string) => void;
  onOpenAgent: (cwd: string) => void;
}): JSXElement {
  const [descDraft, setDescDraft] = createSignal<string | null>(null);
  const today = todayIso();

  const over = () => props.store.overview(props.path);

  const patch = (p: {
    status?: string | null;
    deadline?: string | null;
    description?: string | null;
  }) => void props.store.patchProject(props.path, p);

  const commitDesc = (o: ProjectOverview) => {
    const draft = descDraft();
    if (draft === null || draft === o.description) return;
    patch({ description: draft === "" ? null : draft });
    setDescDraft(null);
  };

  return (
    <Show
      when={over()}
      fallback={<div class="page-empty">Loading project…</div>}
      keyed
    >
      {(o: ProjectOverview) => (
        <div class="proj">
          <div class="proj__head">
            <h1 class="proj__name">{o.name}</h1>
            <div class="proj__controls">
              <Select
                ariaLabel="Project status"
                size="sm"
                options={STATUS_OPTIONS}
                value={o.status}
                onChange={(v) => patch({ status: v })}
              />
              <DatePicker
                ariaLabel="Deadline"
                size="sm"
                value={o.deadline ?? ""}
                onChange={(v) => patch({ deadline: v === "" ? null : v })}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => props.onOpenAgent(o.path)}
                title="Start an agent in this project's folder"
              >
                <Icon name="bot" size={14} />
                Agent
              </Button>
            </div>
          </div>

          <TextInput
            class="proj__desc"
            placeholder="What is this project?"
            value={descDraft() ?? o.description}
            onInput={setDescDraft}
            onBlur={() => commitDesc(o)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLElement).blur();
              if (e.key === "Escape") setDescDraft(null);
            }}
          />

          <ProjectTasks
            tasks={o.tasks}
            onToggle={(t, done) =>
              void props.store.setTask(t.file, t.offset, done)
            }
            onAdd={(text) => void props.store.addTask(props.path, text)}
            onOpenFile={props.onOpenFile}
          />

          <Show when={o.events.length > 0 || o.deadline !== null}>
            <section class="proj__section">
              <h2 class="proj__h">
                <Icon name="calendar" size={14} />
                Upcoming
              </h2>
              <ul class="proj__events">
                <Show when={o.deadline}>
                  {(d) => (
                    <li class="proj__event proj__event--deadline">
                      <Icon name="flag" size={13} />
                      <span class="proj__event-title">Deadline</span>
                      <span class="proj__event-when">
                        {fmtDayHeading(d(), today)}
                      </span>
                    </li>
                  )}
                </Show>
                <For each={o.events}>
                  {(ev) => (
                    <li>
                      <Button
                        variant="ghost"
                        size="sm"
                        fullWidth
                        class="proj__event"
                        onClick={() => props.onOpenFile(ev.path)}
                      >
                        <Icon name="calendar" size={13} />
                        <span class="proj__event-title">{ev.title}</span>
                        <span class="proj__event-when">
                          {fmtDayHeading(ev.date, today)}
                          {ev.start ? ` · ${fmtTime(ev.start)}` : ""}
                        </span>
                      </Button>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>

          <section class="proj__section">
            <h2 class="proj__h">
              <Icon name="file-text" size={14} />
              Files
              <span class="proj__count">{o.files.length}</span>
            </h2>
            <ul class="proj__files">
              <For
                each={[...o.files]
                  .sort((a, b) => b.mtime_unix - a.mtime_unix)
                  .slice(0, 30)}
              >
                {(f) => (
                  <li>
                    <Button
                      variant="ghost"
                      size="sm"
                      fullWidth
                      class={
                        f.path === o.project_file
                          ? "proj__file proj__file--doc"
                          : "proj__file"
                      }
                      onClick={() => props.onOpenFile(f.path)}
                    >
                      {f.path.slice(o.path.length + 1)}
                    </Button>
                  </li>
                )}
              </For>
            </ul>
            <Show when={o.project_file}>
              {(pf) => (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => props.onOpenFile(pf())}
                >
                  Open project.md
                </Button>
              )}
            </Show>
          </section>
        </div>
      )}
    </Show>
  );
}
