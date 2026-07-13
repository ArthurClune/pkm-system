import { describe, expect, test } from "vitest";
import { dateForTitle, titleForDate } from "./daily";

describe("titleForDate", () => {
  test("matches Roam's ordinal format (daily.py parity)", () => {
    expect(titleForDate(new Date(2026, 6, 13))).toBe("July 13th, 2026");
    expect(titleForDate(new Date(2026, 0, 1))).toBe("January 1st, 2026");
    expect(titleForDate(new Date(2026, 1, 2))).toBe("February 2nd, 2026");
    expect(titleForDate(new Date(2026, 2, 3))).toBe("March 3rd, 2026");
    expect(titleForDate(new Date(2026, 3, 11))).toBe("April 11th, 2026");
    expect(titleForDate(new Date(2026, 4, 12))).toBe("May 12th, 2026");
    expect(titleForDate(new Date(2026, 5, 21))).toBe("June 21st, 2026");
    expect(titleForDate(new Date(2026, 7, 22))).toBe("August 22nd, 2026");
    expect(titleForDate(new Date(2026, 8, 23))).toBe("September 23rd, 2026");
    expect(titleForDate(new Date(2026, 9, 31))).toBe("October 31st, 2026");
  });
});

describe("dateForTitle", () => {
  test("round-trips titles back to dates", () => {
    expect(dateForTitle("July 13th, 2026")).toEqual(new Date(2026, 6, 13));
    expect(dateForTitle("January 1st, 2026")).toEqual(new Date(2026, 0, 1));
  });

  test("rejects non-daily titles and bad ordinals", () => {
    expect(dateForTitle("Machine Learning")).toBeNull();
    expect(dateForTitle("July 13, 2026")).toBeNull();
    expect(dateForTitle("Smarch 13th, 2026")).toBeNull();
  });
});
