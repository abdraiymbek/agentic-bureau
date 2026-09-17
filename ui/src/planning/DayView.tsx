import { For, Show, type JSXElement } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import Link from "@ds/components/forms/Link/Link";
import Icon from "@ds/components/graphics/Icon/Icon";

import type { CalendarEvent } from "../api/planning";
import { fmtDayHeading, fmtTime, minutesOf, todayIso } from "./model";
import type { MonthCellData } from "./MonthGrid";

export function DayView(props: {
  focus: string;
  items: () => Map<string, MonthCellData>;
  onEditEvent: (ev: CalendarEvent) => void;
  onNewEvent: (date: string) => void;
  onOpenProject: (path: string) => void;
}): JSXElement {
  const today = todayIso();
  const data = () =>
    props.items().get(props.focus) ?? { events: [], deadlines: [] };
  const sorted = () =>
    [...data().events].sort((a, b) => {
      const ta = minutesOf(a.start);
      const tb = minutesOf(b.start);
      if (ta === null && tb === null) return a.title.localeCompare(b.title);
      if (ta === null) return 1;
      if (tb === null) return -1;
      return ta - tb;
    });

  return (
    <div class="cal-day">
      <h2 class="cal-day__heading">
        {fmtDayHeading(props.focus, today)}
        <span class="cal-day__iso">{props.focus}</span>
      </h2>
      <Show when={data().deadlines.length > 0}>
        <ul class="cal-day__deadlines">
          <For each={data().deadlines}>
            {(dl) => (
              <li>
                <Button
                  variant="ghost"
                  size="sm"
                  fullWidth
                  class="cal-chip cal-chip--deadline"
                  onClick={() => props.onOpenProject(dl.project_path)}
                >
                  <Icon name="flag" size={11} />
                  {dl.project} — deadline
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <ul class="cal-day__list">
        <For
          each={sorted()}
          fallback={
            <li class="cal-day__empty">
              Nothing scheduled.{" "}
              <Link onClick={() => props.onNewEvent(props.focus)}>
                Add an event
              </Link>
            </li>
          }
        >
          {(ev) => (
            <li>
              <Button
                variant="ghost"
                size="sm"
                fullWidth
                class="cal-day__event"
                onClick={() => props.onEditEvent(ev)}
              >
                <span class="cal-day__time">
                  {ev.start ? fmtTime(ev.start) : "—"}
                  <Show when={ev.end}> –{fmtTime(ev.end)}</Show>
                </span>
                <span class="cal-day__title">{ev.title}</span>
                <Show when={ev.project}>
                  <span class="cal-day__project">{ev.project}</span>
                </Show>
              </Button>
            </li>
          )}
        </For>
      </ul>
      <Button
        variant="secondary"
        size="sm"
        class="cal-day__add"
        onClick={() => props.onNewEvent(props.focus)}
      >
        <Icon name="plus" size={13} />
        New event
      </Button>
    </div>
  );
}
