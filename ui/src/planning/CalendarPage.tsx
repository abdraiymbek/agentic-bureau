import {
  createEffect,
  createMemo,
  createSignal,
  on,
  Show,
  type JSXElement,
} from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import IconButton from "@ds/components/forms/IconButton/IconButton";
import SegmentedControl from "@ds/components/forms/SegmentedControl/SegmentedControl";
import Icon from "@ds/components/graphics/Icon/Icon";

import type { CalendarEvent } from "../api/planning";
import { DayView } from "./DayView";
import {
  draftForEdit,
  draftForNew,
  EventModal,
  type EventDraft,
} from "./EventModal";
import {
  fmtMonthHeading,
  rangeFor,
  shiftFocus,
  todayIso,
  type CalendarView,
} from "./model";
import { MonthGrid, type MonthCellData } from "./MonthGrid";
import type { PlanningStore } from "./planningStore";
import { WeekGrid } from "./WeekGrid";

const VIEW_OPTIONS = [
  { value: "month", label: "Month" },
  { value: "week", label: "Week" },
  { value: "day", label: "Day" },
];

export function CalendarPage(props: {
  store: PlanningStore;
  onOpenProject: (path: string) => void;
}): JSXElement {
  const [view, setView] = createSignal<CalendarView>("month");
  const [focus, setFocus] = createSignal(todayIso());
  const [draft, setDraft] = createSignal<EventDraft | null>(null);

  const items = createMemo(() => {
    const resp = props.store.items(rangeFor(view(), focus()));
    const map = new Map<string, MonthCellData>();
    for (const ev of resp?.events ?? []) {
      const cell = map.get(ev.date) ?? { events: [], deadlines: [] };
      cell.events.push(ev);
      map.set(ev.date, cell);
    }
    for (const dl of resp?.deadlines ?? []) {
      const cell = map.get(dl.date) ?? { events: [], deadlines: [] };
      cell.deadlines.push(dl);
      map.set(dl.date, cell);
    }
    return map;
  });

  const findEvent = (path: string) =>
    [...items().values()]
      .flatMap((d) => d.events)
      .find((e) => e.path === path);

  createEffect(
    on(
      () => props.store.eventDraftRequest(),
      (date) => {
        if (date === null) return;
        setDraft(draftForNew(date));
        props.store.clearEventDraftRequest();
      },
    ),
  );

  const heading = () =>
    view() === "month"
      ? fmtMonthHeading(focus())
      : view() === "day"
        ? focus()
        : `${rangeFor("week", focus()).from} — ${rangeFor("week", focus()).to}`;

  const move = (ev: CalendarEvent, date: string) =>
    void props.store.patchEvent(ev.path, { date });

  const save = (d: EventDraft) => {
    setDraft(null);
    if (d.path === null) {
      void props.store.createEvent({
        title: d.title.trim(),
        date: d.date,
        start: d.start || undefined,
        end: d.end || undefined,
        project: d.project || undefined,
        notes: d.notes || undefined,
      });
      setFocus(d.date);
      return;
    }
    void props.store.patchEvent(d.path, {
      title: d.title.trim(),
      date: d.date,
      start: d.start || null,
      end: d.end || null,
      project: d.project || null,
    });
    setFocus(d.date);
  };

  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
    if (e.key === "ArrowLeft") setFocus((f) => shiftFocus(view(), f, -1));
    else if (e.key === "ArrowRight") setFocus((f) => shiftFocus(view(), f, 1));
    else if (e.key === "t") setFocus(todayIso());
    else if (e.key === "n") setDraft(draftForNew(focus()));
    else if (e.key === "1") setView("month");
    else if (e.key === "2") setView("week");
    else if (e.key === "3") setView("day");
    else return;
    e.preventDefault();
  };

  return (
    <div class="cal" tabIndex={0} onKeyDown={onKey}>
      <div class="cal__bar">
        <div class="cal__nav">
          <IconButton
            label="Previous"
            size="sm"
            onClick={() => setFocus((f) => shiftFocus(view(), f, -1))}
          >
            ‹
          </IconButton>
          <IconButton
            label="Next"
            size="sm"
            onClick={() => setFocus((f) => shiftFocus(view(), f, 1))}
          >
            ›
          </IconButton>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFocus(todayIso())}
          >
            Today
          </Button>
          <h2 class="cal__heading">{heading()}</h2>
        </div>
        <div class="cal__tools">
          <SegmentedControl
            ariaLabel="Calendar view"
            variant="pill"
            value={view()}
            options={VIEW_OPTIONS}
            onChange={(v) => setView(v as CalendarView)}
          />
          <IconButton
            label="New event"
            size="sm"
            onClick={() => setDraft(draftForNew(focus()))}
          >
            <Icon name="plus" />
          </IconButton>
        </div>
      </div>
      <Show when={view() === "month"}>
        <MonthGrid
          focus={focus()}
          items={items}
          findEvent={findEvent}
          onSelectDay={(d) => {
            setFocus(d);
            setView("day");
          }}
          onEditEvent={(ev) => setDraft(draftForEdit(ev))}
          onMoveEvent={move}
          onOpenProject={props.onOpenProject}
        />
      </Show>
      <Show when={view() === "week"}>
        <WeekGrid
          focus={focus()}
          items={items}
          findEvent={findEvent}
          onEditEvent={(ev) => setDraft(draftForEdit(ev))}
          onMoveEvent={move}
          onNewEvent={(d) => setDraft(draftForNew(d))}
          onOpenProject={props.onOpenProject}
        />
      </Show>
      <Show when={view() === "day"}>
        <DayView
          focus={focus()}
          items={items}
          onEditEvent={(ev) => setDraft(draftForEdit(ev))}
          onNewEvent={(d) => setDraft(draftForNew(d))}
          onOpenProject={props.onOpenProject}
        />
      </Show>
      <EventModal
        draft={draft}
        onDraft={setDraft}
        projects={props.store.projects}
        onClose={() => setDraft(null)}
        onSave={save}
        onDelete={(path) => {
          setDraft(null);
          void props.store.removeEvent(path);
        }}
      />
    </div>
  );
}
