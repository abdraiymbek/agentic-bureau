import { describe, expect, it } from "vitest";

import {
  addDays,
  addMonths,
  agendaRange,
  deadlineTone,
  fmtDayHeading,
  fmtTime,
  isIsoDate,
  minutesOf,
  monthCells,
  monthRange,
  shiftFocus,
  todayIso,
  weekDates,
  weekRange,
  weekStartIso,
} from "./model";

describe("iso dates", () => {
  it("validates strict YYYY-MM-DD", () => {
    expect(isIsoDate("2026-03-05")).toBe(true);
    expect(isIsoDate("2026-3-5")).toBe(false);
    expect(isIsoDate("not a date")).toBe(false);
  });

  it("addDays crosses month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("addMonths clamps to the end of short months", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
  });
});

describe("weeks", () => {
  it("starts weeks on Monday", () => {
    expect(weekStartIso("2026-03-04")).toBe("2026-03-02");
    expect(weekStartIso("2026-03-08")).toBe("2026-03-02");
    expect(weekStartIso("2026-03-09")).toBe("2026-03-09");
  });

  it("weekDates returns seven consecutive days", () => {
    expect(weekDates("2026-03-05")).toEqual([
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
    ]);
  });
});

describe("month grid", () => {
  it("covers whole weeks including spillover", () => {
    const cells = monthCells("2026-03-15");
    expect(cells.length).toBe(6);
    expect(cells[0]![0]).toEqual({ date: "2026-02-23", inMonth: false });
    expect(cells[5]![6]).toEqual({ date: "2026-04-05", inMonth: false });
  });

  it("marks February spillover correctly", () => {
    const cells = monthCells("2026-02-15");
    expect(cells[0]![0]!.date).toBe("2026-01-26");
    expect(cells.flat().filter((c) => c.inMonth).length).toBe(28);
  });

  it("monthRange matches the rendered grid", () => {
    expect(monthRange("2026-03-15")).toEqual({
      from: "2026-02-23",
      to: "2026-04-05",
    });
  });
});

describe("navigation", () => {
  it("shiftFocus steps per view", () => {
    expect(shiftFocus("day", "2026-03-05", 1)).toBe("2026-03-06");
    expect(shiftFocus("week", "2026-03-05", -1)).toBe("2026-02-26");
    expect(shiftFocus("month", "2026-03-05", 1)).toBe("2026-04-05");
  });

  it("weekRange is Monday–Sunday", () => {
    expect(weekRange("2026-03-05")).toEqual({
      from: "2026-03-02",
      to: "2026-03-08",
    });
  });

  it("agendaRange covers N days", () => {
    expect(agendaRange("2026-03-05", 14)).toEqual({
      from: "2026-03-05",
      to: "2026-03-18",
    });
  });
});

describe("formatting", () => {
  it("minutesOf parses HH:MM", () => {
    expect(minutesOf("09:30")).toBe(570);
    expect(minutesOf(null)).toBeNull();
    expect(minutesOf("bad")).toBeNull();
  });

  it("fmtTime renders 12-hour clock", () => {
    expect(fmtTime("09:05")).toBe("9:05a");
    expect(fmtTime("13:30")).toBe("1:30p");
    expect(fmtTime("00:00")).toBe("12:00a");
    expect(fmtTime(null)).toBe("");
  });

  it("fmtDayHeading names relative days", () => {
    const today = todayIso();
    expect(fmtDayHeading(today, today)).toBe("Today");
    expect(fmtDayHeading(addDays(today, 1), today)).toBe("Tomorrow");
    expect(fmtDayHeading("2026-03-05", "2026-03-01")).toBe("Thu Mar 5");
  });
});

describe("deadlineTone", () => {
  it("colors overdue, soon, future and finished", () => {
    expect(deadlineTone("2026-02-01", "active", "2026-03-01")).toBe("error");
    expect(deadlineTone("2026-03-05", "active", "2026-03-01")).toBe("warning");
    expect(deadlineTone("2026-05-01", "active", "2026-03-01")).toBe("neutral");
    expect(deadlineTone("2026-02-01", "done", "2026-03-01")).toBe("success");
  });
});
