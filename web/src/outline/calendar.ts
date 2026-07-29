// pattern: Functional Core
// Month-grid maths for the /date picker (pkm-rw6w): a Monday-first grid of
// whole weeks covering the given month, with leading/trailing days from the
// adjacent months marked inMonth: false. All dates are local midnights,
// matching replica/daily.ts's convention.
import { MONTHS } from "../replica/daily";

export interface CalendarCell {
  date: Date;
  day: number;
  inMonth: boolean;
}

/** Mo..Su — calendar weeks start on Monday. */
export const WEEKDAY_HEADERS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month]} ${year}`;
}

export function calendarWeeks(year: number, month: number): CalendarCell[][] {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7; // days before the 1st, Monday-first
  const d = new Date(year, month, 1 - lead);
  const weeks: CalendarCell[][] = [];
  do {
    const week: CalendarCell[] = [];
    for (let i = 0; i < 7; i++) {
      week.push({ date: new Date(d), day: d.getDate(), inMonth: d.getMonth() === month });
      d.setDate(d.getDate() + 1);
    }
    weeks.push(week);
  } while (d.getMonth() === month);
  return weeks;
}
