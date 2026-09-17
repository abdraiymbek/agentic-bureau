import { Show, type JSXElement } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import DatePicker from "@ds/components/forms/DatePicker/DatePicker";
import Select from "@ds/components/forms/Select/Select";
import TextInput from "@ds/components/forms/TextInput/TextInput";
import Modal from "@ds/components/overlay/Modal/Modal";

import type { CalendarEvent, ProjectSummary } from "../api/planning";

export interface EventDraft {
  path: string | null;
  title: string;
  date: string;
  start: string;
  end: string;
  project: string;
  notes: string;
}

export function draftForNew(date: string): EventDraft {
  return {
    path: null,
    title: "",
    date,
    start: "",
    end: "",
    project: "",
    notes: "",
  };
}

export function draftForEdit(ev: CalendarEvent): EventDraft {
  return {
    path: ev.path,
    title: ev.title,
    date: ev.date,
    start: ev.start ?? "",
    end: ev.end ?? "",
    project: ev.project ?? "",
    notes: "",
  };
}

export function EventModal(props: {
  draft: () => EventDraft | null;
  onDraft: (d: EventDraft) => void;
  projects: () => ProjectSummary[];
  onClose: () => void;
  onSave: (draft: EventDraft) => void;
  onDelete: (path: string) => void;
}): JSXElement {
  const set = (patch: Partial<EventDraft>) => {
    const cur = props.draft();
    if (cur !== null) props.onDraft({ ...cur, ...patch });
  };

  const field = (key: keyof EventDraft): string => props.draft()?.[key] ?? "";

  const save = () => {
    const cur = props.draft();
    if (cur === null || cur.title.trim() === "" || cur.date === "") return;
    props.onSave(cur);
  };

  const projectOptions = () => [
    { value: "", label: "No project" },
    ...props.projects().map((p) => ({ value: p.name, label: p.name })),
  ];

  return (
    <Modal
      open={props.draft() !== null}
      onClose={props.onClose}
      title={props.draft()?.path == null ? "New event" : "Edit event"}
      size="sm"
    >
      <div class="event-form">
        <TextInput
          autofocus
          placeholder="Title"
          value={field("title")}
          onInput={(v) => set({ title: v })}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          ariaLabel="Event title"
        />
        <div class="event-form__row">
          <DatePicker
            ariaLabel="Date"
            value={field("date")}
            onChange={(v) => set({ date: v })}
          />
          <TextInput
            type="time"
            ariaLabel="Start"
            value={field("start")}
            onChange={(v) => set({ start: v })}
          />
          <TextInput
            type="time"
            ariaLabel="End"
            value={field("end")}
            onChange={(v) => set({ end: v })}
          />
        </div>
        <Select
          ariaLabel="Project"
          options={projectOptions()}
          value={field("project")}
          onChange={(v) => set({ project: v })}
          fullWidth
        />
        <Show when={props.draft()?.path == null}>
          <TextInput
            placeholder="Notes (optional)"
            value={field("notes")}
            onInput={(v) => set({ notes: v })}
            ariaLabel="Event notes"
          />
        </Show>
        <div class="event-form__actions">
          <Show when={props.draft()?.path}>
            {(path) => (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => props.onDelete(path())}
              >
                Delete
              </Button>
            )}
          </Show>
          <span class="event-form__spacer" />
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            disabled={field("title").trim() === "" || field("date") === ""}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
