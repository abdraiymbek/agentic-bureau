export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const WEEKDAY_LONG = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
export const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  return ISO_RE.test(s);
}

export function parseIso(iso: string): Date {
  const [y = 1970, m = 1, d = 1] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function formatIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayIso(now: Date = new Date()): string {
  return formatIso(now);
}

export function addDays(iso: string, days: number): string {
  const d = parseIso(iso);
  d.setDate(d.getDate() + days);
  return formatIso(d);
}

export function addMonths(iso: string, months: number): string {
  const d = parseIso(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return formatIso(d);
}

export function weekStartIso(iso: string): string {
  const d = parseIso(iso);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return formatIso(d);
}

export function weekDates(iso: string): string[] {
  const start = weekStartIso(iso);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export interface MonthCell {
  date: string;
  inMonth: boolean;
}

export function monthCells(iso: string): MonthCell[][] {
  const d = parseIso(iso);
  const first = formatIso(new Date(d.getFullYear(), d.getMonth(), 1));
  const last = formatIso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  const start = weekStartIso(first);
  const weeks: MonthCell[][] = [];
  let cur = start;
  while (cur <= last) {
    const week: MonthCell[] = [];
    for (let i = 0; i < 7; i++) {
      week.push({
        date: cur,
        inMonth: cur >= first && cur <= last,
      });
      cur = addDays(cur, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export interface Range {
  from: string;
  to: string;
}

export function monthRange(iso: string): Range {
  const cells = monthCells(iso);
  return {
    from: cells[0]![0]!.date,
    to: cells[cells.length - 1]![6]!.date,
  };
}

export function weekRange(iso: string): Range {
  const dates = weekDates(iso);
  return { from: dates[0]!, to: dates[6]! };
}

export function dayRange(iso: string): Range {
  return { from: iso, to: iso };
}

export function agendaRange(iso: string, days: number): Range {
  return { from: iso, to: addDays(iso, days - 1) };
}

export type CalendarView = "month" | "week" | "day";

export function rangeFor(view: CalendarView, iso: string): Range {
  switch (view) {
    case "month":
      return monthRange(iso);
    case "week":
      return weekRange(iso);
    case "day":
      return dayRange(iso);
  }
}

export function shiftFocus(
  view: CalendarView,
  iso: string,
  dir: number,
): string {
  switch (view) {
    case "month":
      return addMonths(iso, dir);
    case "week":
      return addDays(iso, 7 * dir);
    case "day":
      return addDays(iso, dir);
  }
}

export function rangeKey(r: Range): string {
  return `${r.from}..${r.to}`;
}

export function minutesOf(time: string | null | undefined): number | null {
  if (!time) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function fmtTime(time: string | null | undefined): string {
  if (!time) return "";
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return time;
  let h = Number(m[1]);
  const ampm = h < 12 ? "a" : "p";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m[2]}${ampm}`;
}

export function fmtDayHeading(iso: string, today: string): string {
  if (iso === today) return "Today";
  if (iso === addDays(today, 1)) return "Tomorrow";
  if (iso === addDays(today, -1)) return "Yesterday";
  const d = parseIso(iso);
  const dow = WEEKDAY_SHORT[(d.getDay() + 6) % 7]!;
  return `${dow} ${MONTH_LONG[d.getMonth()]!.slice(0, 3)} ${d.getDate()}`;
}

export function fmtMonthHeading(iso: string): string {
  const d = parseIso(iso);
  return `${MONTH_LONG[d.getMonth()]} ${d.getFullYear()}`;
}

export function deadlineTone(
  date: string,
  status: string,
  today: string,
): "error" | "warning" | "neutral" | "success" {
  if (status === "done" || status === "archived") return "success";
  if (date < today) return "error";
  if (date <= addDays(today, 7)) return "warning";
  return "neutral";
}

export function projectName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
