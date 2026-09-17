import { createMemo, createSignal, For, Show, type JSXElement } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import Icon from "@ds/components/graphics/Icon/Icon";

import type { CalendarEvent } from "../api/planning";
import {
  draftForNew,
  EventModal,
  type EventDraft,
} from "./EventModal";
import {
  agendaRange,
  fmtDayHeading,
  fmtTime,
  todayIso,
} from "./model";
import type { PlanningStore } from "./planningStore";

const AGENDA_DAYS = 14;

export function AgendaPanel(props: {
  store: PlanningStore;
  onOpenProject: (path: string) => void;
  onOpenCalendar: () => void;
  onOpenFile: (path: string) => void;
}): JSXElement {
  const [draft, setDraft] = createSignal<EventDraft | null>(null);
  const today = todayIso();

  const days = createMemo(() => {
    const resp = props.store.items(agendaRange(today, AGENDA_DAYS));
    const out: {
      date: string;
      events: CalendarEvent[];
      deadlines: { project: string; path: string }[];
    }[] = [];
    if (!resp) return out;
    const byDate = new Map<string, (typeof out)[number]>();
    const slot = (date: string) => {
      let row = byDate.get(date);
      if (!row) {
        row = { date, events: [], deadlines: [] };
        byDate.set(date, row);
        out.push(row);
      }
      return row;
    };
    for (const ev of resp.events) slot(ev.date).events.push(ev);
    for (const dl of resp.deadlines)
      slot(dl.date).deadlines.push({
        project: dl.project,
        path: dl.project_path,
      });
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  });

  return (
    <div class="plan-panel">
      <div class="plan-panel__head">
        <span class="plan-panel__title">Upcoming</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={props.onOpenCalendar}
        >
          Calendar
        </Button>
      </div>
      <div class="plan-panel__list" role="list">
        <For
          each={days()}
          fallback={
            <p class="plan-panel__empty">
              Nothing scheduled for the next {AGENDA_DAYS} days.
            </p>
          }
        >
          {(day) => (
            <div class="agenda-day">
              <div class="agenda-day__date">
                {fmtDayHeading(day.date, today)}
              </div>
              <For each={day.deadlines}>
                {(dl) => (
                  <Button
                    variant="ghost"
                    size="sm"
                    fullWidth
                    class="agenda-item agenda-item--deadline"
                    onClick={() => props.onOpenProject(dl.path)}
                  >
                    <Icon name="flag" size={12} />
                    <span class="agenda-item__title">{dl.project}</span>
                    <span class="agenda-item__time">deadline</span>
                  </Button>
                )}
              </For>
              <For each={day.events}>
                {(ev) => (
                  <Button
                    variant="ghost"
                    size="sm"
                    fullWidth
                    class="agenda-item"
                    onClick={() => props.onOpenFile(ev.path)}
                  >
                    <span class="agenda-item__title">{ev.title}</span>
                    <span class="agenda-item__time">
                      {ev.start ? fmtTime(ev.start) : "all day"}
                      <Show when={ev.project}> · {ev.project}</Show>
                    </span>
                  </Button>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
      <div class="plan-panel__foot">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setDraft(draftForNew(today))}
        >
          <Icon name="plus" size={13} />
          New event
        </Button>
      </div>
      <EventModal
        draft={draft}
        onDraft={setDraft}
        projects={props.store.projects}
        onClose={() => setDraft(null)}
        onSave={(d) => {
          setDraft(null);
          void props.store.createEvent({
            title: d.title.trim(),
            date: d.date,
            start: d.start || undefined,
            end: d.end || undefined,
            project: d.project || undefined,
            notes: d.notes || undefined,
          });
        }}
        onDelete={(path) => {
          setDraft(null);
          void props.store.removeEvent(path);
        }}
      />
    </div>
  );
}
