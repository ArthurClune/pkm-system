import { describe, expect, test } from "vitest";
import { calendarWeeks, monthLabel } from "./calendar";

describe("calendarWeeks (pkm-rw6w)", () => {
  test("July 2026: Monday-first grid, June 29 through August 2, 5 weeks", () => {
    const weeks = calendarWeeks(2026, 6);
    expect(weeks).toHaveLength(5);
    const first = weeks[0][0];
    const last = weeks[4][6];
    expect(first.date).toEqual(new Date(2026, 5, 29));
    expect(first.day).toBe(29);
    expect(first.inMonth).toBe(false);
    expect(last.date).toEqual(new Date(2026, 7, 2));
    expect(last.inMonth).toBe(false);
    expect(weeks[0][2]).toEqual({ date: new Date(2026, 6, 1), day: 1, inMonth: true });
  });

  test("every week has 7 cells and all month days appear in order", () => {
    const weeks = calendarWeeks(2026, 6);
    for (const w of weeks) expect(w).toHaveLength(7);
    const inMonth = weeks.flat().filter((c) => c.inMonth).map((c) => c.day);
    expect(inMonth).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
  });

  test("February 2027 is an exact 4-week grid with no outside days", () => {
    const weeks = calendarWeeks(2027, 1);
    expect(weeks).toHaveLength(4);
    expect(weeks.flat().every((c) => c.inMonth)).toBe(true);
  });

  test("monthLabel", () => {
    expect(monthLabel(2026, 6)).toBe("July 2026");
    expect(monthLabel(2027, 0)).toBe("January 2027");
  });
});
