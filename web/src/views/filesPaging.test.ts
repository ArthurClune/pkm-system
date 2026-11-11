import { describe, expect, it } from "vitest";
import type { AssetSearchItem } from "../api/payloads";
import { shaOf } from "../test-helpers";
import {
  LOAD_MORE_FAILED, SELECT_ALL_FAILED, filesPaging, initialFilesPaging,
  listIsCurrent, type FilesPaging, type FilesPagingEvent,
} from "./filesPaging";

const asset = (n: number): AssetSearchItem => ({
  sha256: shaOf(String(n).padStart(64, "0")), filename: `f${n}.png`,
  mime: "image/png", size: 1, created_at: 0, url: `/assets/${n}`,
  description: null, status: "described", describe_error: null, refs: [],
});
const assets = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => asset(from + i));

const step = (state: FilesPaging, ...events: FilesPagingEvent[]) =>
  events.reduce(filesPaging, state);

/** The first reload in flight: generation 1, nothing loaded. */
const loading = () => step(initialFilesPaging(), { type: "reloadStarted" });
/** Two items of five shown under generation 1. */
const ready = () =>
  step(loading(), { type: "loaded", gen: 1, items: assets(2), total: 5 });
/** The generation 1 reload failed. */
const failed = () => step(loading(), { type: "failed", gen: 1 });
/** A filter changed after generation 1 loaded; its reload has not landed. */
const superseded = () => step(ready(), { type: "filterChanged" });
const moreInFlight = () => step(ready(), { type: "moreStarted" });
const selectingAll = () => step(ready(), { type: "selectAllStarted" });

const phases = { loading, ready, failed, superseded, moreInFlight,
                 selectingAll } as const;
type Phase = keyof typeof phases;

describe("filesPaging", () => {
  // Every event from every phase. "same" means the reducer refused or
  // ignored the event and returned the state object it was given.
  const g1 = { gen: 1, items: assets(1, 10), total: 7 } as const;
  const table: [Phase, FilesPagingEvent, "same" | Partial<FilesPaging>][] = [
    ["loading", { type: "loaded", ...g1 },
     { phase: "ready", items: g1.items, total: 7, itemsGen: 1 }],
    ["loading", { type: "failed", gen: 1 }, { phase: "error" }],
    ["loading", { type: "loaded", ...g1, gen: 0 }, "same"],
    ["loading", { type: "failed", gen: 0 }, "same"],
    ["loading", { type: "moreStarted" }, "same"],
    ["loading", { type: "selectAllStarted" }, "same"],
    ["loading", { type: "moreLoaded", ...g1 }, "same"],
    ["loading", { type: "moreFailed", gen: 1 }, "same"],
    ["loading", { type: "selectAllLoaded", ...g1 }, "same"],
    ["loading", { type: "selectAllFailed", gen: 1 }, "same"],
    ["ready", { type: "moreStarted" }, { more: { gen: 1 } }],
    ["ready", { type: "selectAllStarted" }, { busy: "select-all" }],
    ["ready", { type: "filterChanged" },
     { filterGen: 2, phase: "loading", itemsGen: 1 }],
    ["ready", { type: "reloadStarted" },
     { filterGen: 2, phase: "loading", itemsGen: 1 }],
    ["ready", { type: "deleteStarted" }, { busy: "delete" }],
    ["ready", { type: "noticeShown", text: "hi" }, { notice: "hi" }],
    ["failed", { type: "moreStarted" }, "same"],
    ["failed", { type: "selectAllStarted" }, "same"],
    ["failed", { type: "loaded", ...g1, gen: 0 }, "same"],
    ["failed", { type: "reloadStarted" },
     { filterGen: 2, phase: "loading" }],
    ["superseded", { type: "moreStarted" }, "same"],
    ["superseded", { type: "selectAllStarted" }, "same"],
    ["superseded", { type: "loaded", ...g1 }, "same"],
    ["superseded", { type: "failed", gen: 1 }, "same"],
    ["superseded", { type: "loaded", ...g1, gen: 2 },
     { phase: "ready", itemsGen: 2, items: g1.items, total: 7 }],
    ["moreInFlight", { type: "moreStarted" }, "same"],
    ["moreInFlight", { type: "moreLoaded", ...g1 },
     { more: null, items: [...assets(2), ...g1.items], total: 7 }],
    ["moreInFlight", { type: "moreFailed", gen: 1 },
     { more: null, notice: LOAD_MORE_FAILED }],
    ["moreInFlight", { type: "selectAllStarted" }, "same"],
    ["selectingAll", { type: "selectAllStarted" }, "same"],
    ["selectingAll", { type: "selectAllLoaded", ...g1 },
     { busy: null, items: g1.items, selected: new Set([asset(10).sha256]) }],
    ["selectingAll", { type: "selectAllFailed", gen: 1 },
     { busy: null, notice: SELECT_ALL_FAILED }],
    ["selectingAll", { type: "moreStarted" }, "same"],
  ];
  it.each(table)("from %s, %j", (phase, event, expected) => {
    const before = phases[phase]();
    const after = filesPaging(before, event);
    if (expected === "same") expect(after).toBe(before);
    else expect(after).toEqual({ ...before, ...expected });
  });

  it("an event that changes nothing returns the same state", () => {
    const s = step(ready(), { type: "noticeShown", text: "hi" });
    expect(step(s, { type: "noticeShown", text: "hi" })).toBe(s);
    const deleting = step(s, { type: "deleteStarted" });
    expect(step(deleting, { type: "deleteStarted" })).toBe(deleting);
  });

  it("a filter change bumps the generation and clears the selection at the " +
     "keystroke", () => {
    const s = step(ready(), { type: "toggled", sha: asset(0).sha256 });
    expect(s.selected.size).toBe(1);
    const changed = step(s, { type: "filterChanged" });
    expect(changed.filterGen).toBe(s.filterGen + 1);
    expect(changed.selected.size).toBe(0);
    expect(listIsCurrent(changed)).toBe(false);
  });

  it("a reload's result lands only under the generation it started", () => {
    const s = step(ready(), { type: "reloadStarted" });
    const landed = step(s, { type: "loaded", gen: s.filterGen,
                             items: assets(1, 20), total: 1 });
    expect(landed.items).toEqual(assets(1, 20));
    expect(landed.itemsGen).toBe(s.filterGen);
    expect(listIsCurrent(landed)).toBe(true);
  });

  it("a result for a superseded reload changes nothing", () => {
    const first = step(ready(), { type: "reloadStarted" });
    const second = step(first, { type: "filterChanged" });
    expect(step(second, { type: "loaded", gen: first.filterGen,
                          items: assets(3), total: 3 })).toBe(second);
    expect(step(second, { type: "failed", gen: first.filterGen }))
      .toBe(second);
  });

  it("load more starts only from a list loaded under the current generation",
     () => {
    expect(step(loading(), { type: "moreStarted" }).more).toBeNull();
    expect(step(superseded(), { type: "moreStarted" }).more).toBeNull();
    expect(step(failed(), { type: "moreStarted" }).more).toBeNull();
    expect(step(ready(), { type: "moreStarted" }).more).toEqual({ gen: 1 });
  });

  it("load more is single-flight", () => {
    const s = moreInFlight();
    expect(step(s, { type: "moreStarted" })).toBe(s);
    const reloaded = step(s, { type: "reloadStarted" },
                          { type: "loaded", gen: 2, items: assets(2),
                            total: 5 });
    expect(step(reloaded, { type: "moreStarted" })).toBe(reloaded);
  });

  it("a stale load-more result is dropped and frees only its own lock", () => {
    const s = step(moreInFlight(), { type: "filterChanged" });
    const landed = step(s, { type: "moreLoaded", gen: 1,
                             items: assets(3, 50), total: 99 });
    expect(landed).toEqual({ ...s, more: null });
    const other: FilesPaging = { ...s, more: { gen: 2 } };
    expect(step(other, { type: "moreLoaded", gen: 1, items: [], total: 0 }))
      .toBe(other);
    expect(step(other, { type: "moreFailed", gen: 1 })).toBe(other);
  });

  it("Select all and Load more exclude each other, since the later answer " +
     "would land on a list the earlier one replaced", () => {
    const more = moreInFlight();
    expect(step(more, { type: "selectAllStarted" })).toBe(more);
    const all = selectingAll();
    expect(step(all, { type: "moreStarted" })).toBe(all);
  });

  it("select all starts only from a current list and selects every item it " +
     "fetched", () => {
    expect(step(loading(), { type: "selectAllStarted" }).busy).toBeNull();
    expect(step(superseded(), { type: "selectAllStarted" }).busy).toBeNull();
    const s = selectingAll();
    expect(step(s, { type: "selectAllStarted" })).toBe(s);
    const all = assets(5);
    const done = step(s, { type: "selectAllLoaded", gen: 1, items: all });
    expect(done.items).toEqual(all);
    expect([...done.selected]).toEqual(all.map((a) => a.sha256));
    expect(done.busy).toBeNull();
  });

  it("a stale select-all result selects nothing but frees busy", () => {
    const s = step(selectingAll(), { type: "filterChanged" });
    expect(step(s, { type: "selectAllLoaded", gen: 1, items: assets(5) }))
      .toEqual({ ...s, busy: null });
    expect(step(s, { type: "selectAllFailed", gen: 1 }))
      .toEqual({ ...s, busy: null });
  });

  it("a failed reload clears the selection and shows the error phase", () => {
    const s = step(ready(), { type: "toggled", sha: asset(0).sha256 },
                   { type: "reloadStarted" });
    const after = step(s, { type: "failed", gen: s.filterGen });
    expect(after.phase).toBe("error");
    expect(after.selected.size).toBe(0);
  });

  it("a failed load more shows its notice only while its generation is " +
     "current", () => {
    expect(step(moreInFlight(), { type: "moreFailed", gen: 1 }).notice)
      .toBe(LOAD_MORE_FAILED);
    const moved = step(moreInFlight(), { type: "filterChanged" },
                       { type: "moreFailed", gen: 1 });
    expect(moved.notice).toBeNull();
  });

  it("toggling twice restores the selection; a delete frees busy with its " +
     "notice", () => {
    const sha = asset(0).sha256;
    const once = step(ready(), { type: "toggled", sha });
    expect(once.selected.has(sha)).toBe(true);
    expect(step(once, { type: "toggled", sha }).selected.has(sha)).toBe(false);
    const done = step(ready(), { type: "deleteStarted" },
                      { type: "deleteFinished", notice: "Deleted 1 file." });
    expect(done.busy).toBeNull();
    expect(done.notice).toBe("Deleted 1 file.");
  });

  it("a filter change keeps the notice", () => {
    const s = step(ready(), { type: "noticeShown", text: "Link copied." },
                   { type: "filterChanged" });
    expect(s.notice).toBe("Link copied.");
  });
});
