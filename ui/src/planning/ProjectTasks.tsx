import { createSignal, For, Show, type JSXElement } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import Checkbox from "@ds/components/forms/Checkbox/Checkbox";
import TextInput from "@ds/components/forms/TextInput/TextInput";
import Icon from "@ds/components/graphics/Icon/Icon";

import type { ProjectTask } from "../api/planning";

function TaskRow(props: {
  task: ProjectTask;
  onToggle: (task: ProjectTask) => void;
  onOpenFile: (path: string) => void;
}): JSXElement {
  const t = () => props.task;
  return (
    <li class="task-row" classList={{ "task-row--done": t().done }}>
      <Checkbox
        checked={t().done}
        label={t().text}
        onChange={() => props.onToggle(t())}
      />
      <span class="task-row__text">{t().text}</span>
      <Button
        variant="ghost"
        size="sm"
        class="task-row__file"
        onClick={() => props.onOpenFile(t().file)}
        title={t().file}
      >
        {t().file.split("/").pop()}
      </Button>
    </li>
  );
}

export function ProjectTasks(props: {
  tasks: ProjectTask[];
  onToggle: (task: ProjectTask, done: boolean) => void;
  onAdd: (text: string) => void;
  onOpenFile: (path: string) => void;
}): JSXElement {
  const [draft, setDraft] = createSignal("");
  const open = () => props.tasks.filter((t) => !t.done);
  const done = () => props.tasks.filter((t) => t.done);

  const add = () => {
    const text = draft().trim();
    if (text === "") return;
    setDraft("");
    props.onAdd(text);
  };

  return (
    <section class="proj__section">
      <h2 class="proj__h">
        <Icon name="list-checks" size={14} />
        Tasks
        <Show when={open().length > 0}>
          <span class="proj__count">{open().length}</span>
        </Show>
      </h2>
      <ul class="task-list">
        <For each={open()}>
          {(t) => (
            <TaskRow
              task={t}
              onToggle={(task) => props.onToggle(task, true)}
              onOpenFile={props.onOpenFile}
            />
          )}
        </For>
      </ul>
      <TextInput
        size="sm"
        placeholder="Add a task — Enter"
        value={draft()}
        onInput={setDraft}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
      />
      <Show when={done().length > 0}>
        <details class="task-done">
          <summary>{done().length} done</summary>
          <ul class="task-list">
            <For each={done()}>
              {(t) => (
                <TaskRow
                  task={t}
                  onToggle={(task) => props.onToggle(task, false)}
                  onOpenFile={props.onOpenFile}
                />
              )}
            </For>
          </ul>
        </details>
      </Show>
    </section>
  );
}
