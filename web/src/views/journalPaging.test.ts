import { describe, expect, it } from "vitest";
import {
  BATCH, SERVER_MAX_DAYS, initialJournalPaging, journalPager, journalPaging,
  type JournalPaging, type JournalPagingEvent,
} from "./journalPaging";

type Day = { date: string };
const days = (n: number, from = 0): Day[] =>
  Array.from({ length: n }, (_, i) => ({ date: `d${String(from + i).padStart(3, "0")}` }));

const step = (state: JournalPaging<Day>, ...events: JournalPagingEvent<Day>[]) =>
  events.reduce(journalPaging, state);

/** A journal showing `n` days, nothing in flight. */
function showing(n: number): JournalPaging<Day> {
  let s = step(initialJournalPaging<Day>(), { type: "older" });
  s = step(s, { type: "loaded", id: s.loading!.id, days: days(Math.min(n, BATCH)) });
  while (s.days.length < n) {
    s = step(s, { type: "older" });
    s = step(s, { type: "loaded", id: s.loading!.id,
                  days: days(Math.min(BATCH, n - s.days.length), s.days.length) });
  }
  return s;
}

describe("journalPaging", () => {
  it("starts with a head batch, then pages older from the oldest day shown", () => {
    const first = step(initialJournalPaging<Day>(), { type: "older" });
    expect(first.loading).toEqual({ id: 0, kind: "head", want: BATCH, before: undefined });
    const s = step(showing(5), { type: "older" });
    expect(s.loading).toMatchObject({ kind: "older", want: BATCH, before: "d004" });
  });

  it("starts one load at a time", () => {
    const s = step(initialJournalPaging<Day>(), { type: "older" });
    expect(step(s, { type: "older" })).toBe(s);
  });

  it("a short batch exhausts the past, and older is then ignored", () => {
    let s = step(initialJournalPaging<Day>(), { type: "older" });
    s = step(s, { type: "loaded", id: 0, days: days(3) });
    expect(s.done).toBe(true);
    expect(journalPager(s)).toBe("none");
    expect(step(s, { type: "older" })).toBe(s);
  });

  it("a resync asks for the window on screen, clamped to the server's cap", () => {
    expect(step(showing(10), { type: "resync" }).loading)
      .toMatchObject({ kind: "head", want: 10, before: undefined });
    expect(step(showing(2), { type: "resync" }).loading).toMatchObject({ want: BATCH });
    expect(step(showing(40), { type: "resync" }).loading)
      .toMatchObject({ want: SERVER_MAX_DAYS });
  });

  it("a failed reload keeps the days and cursor and shows the button", () => {
    let s = step(showing(10), { type: "resync" });
    s = step(s, { type: "failed", id: s.loading!.id, message: "boom" });
    expect(s.days).toHaveLength(10);
    expect(s.error).toBe("boom");
    expect(journalPager(s)).toBe("button");
    s = step(s, { type: "older" });
    expect(s.loading).toMatchObject({ kind: "older", before: "d009" });
    expect(journalPager(s)).toBe("sentinel");
    s = step(s, { type: "loaded", id: s.loading!.id, days: days(5, 10) });
    expect(s.days).toHaveLength(15);
    expect(s.error).toBeNull();
  });

  it("ignores a superseded or abandoned load's result", () => {
    const older = step(showing(5), { type: "older" });
    const reload = step(older, { type: "resync" });
    expect(step(reload, { type: "loaded", id: older.loading!.id, days: days(5, 5) }))
      .toBe(reload);
    expect(step(reload, { type: "failed", id: older.loading!.id, message: "x" }))
      .toBe(reload);
    const abandoned = step(reload, { type: "abandon" });
    expect(abandoned.loading).toBeNull();
    expect(step(abandoned, { type: "abandon" })).toBe(abandoned);
    expect(step(abandoned, { type: "loaded", id: reload.loading!.id, days: [] }))
      .toBe(abandoned);
  });
});
