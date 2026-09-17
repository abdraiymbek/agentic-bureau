import { For, Show, type JSXElement } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import Icon from "@ds/components/graphics/Icon/Icon";

import type { CalendarEvent, CalendarDeadline } from "../api/planning";
import { fmtTime, monthCells, todayIso, WEEKDAY_SHORT } from "./model";

const MAX_CHIPS = 3;
export const EVENT_DRAG = "application/x-directory-event";

export interface MonthCellData {
  events: CalendarEvent[];
  deadlines: CalendarDeadline[];
}

export function MonthGrid(props: {
  focus: string;
  items: () => Map<string, MonthCellData>;
  findEvent: (path: string) => CalendarEvent | undefined;
  onSelectDay: (date: string) => void;
  onEditEvent: (ev: CalendarEvent) => void;
  onMoveEvent: (ev: CalendarEvent, date: string) => void;
  onOpenProject: (path: string) => void;
}): JSXElement {
  const today = todayIso();
  const weeks = () => monthCells(props.focus);

  const cellData = (date: string) =>
    props.items().get(date) ?? { events: [], deadlines: [] };

  return (
    <div class="cal-month">
      <div class="cal-month__dow">
        <For each={WEEKDAY_SHORT}>{(d) => <span>{d}</span>}</For>
      </div>
      <div class="cal-month__grid">
        <For each={weeks()}>
          {(week) => (
            <For each={week}>
              {(cell) => {
                const data = () => cellData(cell.date);
                const chips = () => [
                  ...data().events.map((ev) => ({ kind: "event" as const, ev })),
                  ...data().deadlines.map((dl) => ({
                    kind: "deadline" as const,
                    dl,
                  })),
                ];
                const overflow = () => Math.max(0, chips().length - MAX_CHIPS);
                return (
                  <div
                    class="cal-cell"
                    classList={{
                      "cal-cell--outside": !cell.inMonth,
                      "cal-cell--today": cell.date === today,
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      const path = e.dataTransfer?.getData(EVENT_DRAG);
                      if (!path) return;
                      const ev = props.findEvent(path);
                      if (ev && ev.date !== cell.date)
                        props.onMoveEvent(ev, cell.date);
                    }}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      class="cal-cell__day"
                      onClick={() => props.onSelectDay(cell.date)}
                    >
                      {Number(cell.date.slice(8))}
                    </Button>
                    <div class="cal-cell__chips">
                      <For each={chips().slice(0, MAX_CHIPS)}>
                        {(chip) => (
                          <Show
                            when={chip.kind === "event"}
                            fallback={
                              <Button
                                variant="ghost"
                                size="sm"
                                class="cal-chip cal-chip--deadline"
                                onClick={() =>
                                  props.onOpenProject(
                                    (chip as { dl: CalendarDeadline }).dl
                                      .project_path,
                                  )
                                }
                              >
                                <Icon name="flag" size={11} />
                                {(chip as { dl: CalendarDeadline }).dl.project}
                              </Button>
                            }
                          >
                            <button
                              type="button"
                              class="cal-chip"
                              draggable
                              onDragStart={(e) =>
                                e.dataTransfer?.setData(
                                  EVENT_DRAG,
                                  (chip as { ev: CalendarEvent }).ev.path,
                                )
                              }
                              onClick={() =>
                                props.onEditEvent(
                                  (chip as { ev: CalendarEvent }).ev,
                                )
                              }
                            >
                              <Show
                                when={(chip as { ev: CalendarEvent }).ev.start}
                              >
                                <span class="cal-chip__time">
                                  {fmtTime(
                                    (chip as { ev: CalendarEvent }).ev.start,
                                  )}
                                </span>
                              </Show>
                              {(chip as { ev: CalendarEvent }).ev.title}
                            </button>
                          </Show>
                        )}
                      </For>
                      <Show when={overflow() > 0}>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="cal-chip cal-chip--more"
                          onClick={() => props.onSelectDay(cell.date)}
                        >
                          +{overflow()} more
                        </Button>
                      </Show>
                    </div>
                  </div>
                );
              }}
            </For>
          )}
        </For>
      </div>
    </div>
  );
}
