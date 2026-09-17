import { For, type JSXElement } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import Icon from "@ds/components/graphics/Icon/Icon";

import type { CalendarEvent } from "../api/planning";
import {
  fmtTime,
  minutesOf,
  todayIso,
  weekDates,
  WEEKDAY_SHORT,
} from "./model";
import { EVENT_DRAG, type MonthCellData } from "./MonthGrid";

const HOUR_PX = 44;
const DAY_START_MIN = 0;
const DAY_END_MIN = 24 * 60;

function laneStyle(ev: CalendarEvent): string {
  const start = minutesOf(ev.start) ?? 9 * 60;
  const end = minutesOf(ev.end) ?? start + 60;
  const top = ((start - DAY_START_MIN) / 60) * HOUR_PX;
  const height = Math.max(18, ((end - start) / 60) * HOUR_PX);
  return `top:${top}px;height:${height}px`;
}

export function WeekGrid(props: {
  focus: string;
  items: () => Map<string, MonthCellData>;
  findEvent: (path: string) => CalendarEvent | undefined;
  onEditEvent: (ev: CalendarEvent) => void;
  onMoveEvent: (ev: CalendarEvent, date: string) => void;
  onNewEvent: (date: string) => void;
  onOpenProject: (path: string) => void;
}): JSXElement {
  const today = todayIso();
  const days = () => weekDates(props.focus);
  const hours = Array.from(
    { length: DAY_END_MIN / 60 - DAY_START_MIN / 60 },
    (_, i) => DAY_START_MIN / 60 + i,
  );

  const timed = (date: string) =>
    (props.items().get(date)?.events ?? []).filter(
      (e) => minutesOf(e.start) !== null,
    );
  const floating = (date: string) =>
    (props.items().get(date)?.events ?? []).filter(
      (e) => minutesOf(e.start) === null,
    );
  const deadlines = (date: string) =>
    props.items().get(date)?.deadlines ?? [];

  return (
    <div class="cal-week">
      <div class="cal-week__head">
        <For each={days()}>
          {(d) => {
            const dow = WEEKDAY_SHORT[
              (new Date(`${d}T12:00`).getDay() + 6) % 7
            ];
            return (
              <Button
                variant="ghost"
                size="sm"
                class={
                  d === today
                    ? "cal-week__day-head cal-week__day-head--today"
                    : "cal-week__day-head"
                }
                onClick={() => props.onNewEvent(d)}
              >
                <span class="cal-week__dow">{dow}</span>
                <span class="cal-week__num">{Number(d.slice(8))}</span>
              </Button>
            );
          }}
        </For>
      </div>
      <div class="cal-week__allday">
        <For each={days()}>
          {(d) => (
            <div
              class="cal-week__allday-cell"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                const path = e.dataTransfer?.getData(EVENT_DRAG);
                const ev = path ? props.findEvent(path) : undefined;
                if (ev && ev.date !== d) props.onMoveEvent(ev, d);
              }}
            >
              <For each={deadlines(d)}>
                {(dl) => (
                  <Button
                    variant="ghost"
                    size="sm"
                    class="cal-chip cal-chip--deadline"
                    onClick={() => props.onOpenProject(dl.project_path)}
                  >
                    <Icon name="flag" size={11} />
                    {dl.project}
                  </Button>
                )}
              </For>
              <For each={floating(d)}>
                {(ev) => (
                  <button
                    type="button"
                    class="cal-chip"
                    draggable
                    onDragStart={(e) =>
                      e.dataTransfer?.setData(EVENT_DRAG, ev.path)
                    }
                    onClick={() => props.onEditEvent(ev)}
                  >
                    {ev.title}
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
      <div class="cal-week__body">
        <div class="cal-week__hours">
          <For each={hours}>
            {(h) => (
              <div class="cal-week__hour" style={{ height: `${HOUR_PX}px` }}>
                <span>{h % 6 === 0 ? fmtTime(`${h}:00`) : ""}</span>
              </div>
            )}
          </For>
        </div>
        <For each={days()}>
          {(d) => (
            <div
              class="cal-week__col"
              classList={{ "cal-week__col--today": d === today }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                const path = e.dataTransfer?.getData(EVENT_DRAG);
                const ev = path ? props.findEvent(path) : undefined;
                if (ev && ev.date !== d) props.onMoveEvent(ev, d);
              }}
            >
              <For each={hours}>
                {() => (
                  <div
                    class="cal-week__slot"
                    style={{ height: `${HOUR_PX}px` }}
                    onDblClick={() => props.onNewEvent(d)}
                  />
                )}
              </For>
              <For each={timed(d)}>
                {(ev) => (
                  <button
                    type="button"
                    class="cal-block"
                    style={laneStyle(ev)}
                    draggable
                    onDragStart={(e) =>
                      e.dataTransfer?.setData(EVENT_DRAG, ev.path)
                    }
                    onClick={() => props.onEditEvent(ev)}
                    title={`${ev.title} · ${fmtTime(ev.start)}${ev.end ? `–${fmtTime(ev.end)}` : ""}`}
                  >
                    <span class="cal-block__title">{ev.title}</span>
                    <span class="cal-block__time">
                      {fmtTime(ev.start)}
                      {ev.end ? `–${fmtTime(ev.end)}` : ""}
                    </span>
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
