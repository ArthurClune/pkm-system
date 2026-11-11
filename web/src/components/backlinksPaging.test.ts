import { describe, expect, it } from "vitest";
import type { Backlinks } from "../api/payloads";
import { canonicalTitleOf, pageIdOf, uidOf } from "../test-helpers";
import type { BacklinkBatchState } from "./backlinkBatchWalk";
import {
  backlinksPaging, hasMore, initialBacklinksPaging, walking,
  type BacklinksPaging, type BacklinksPagingEvent,
} from "./backlinksPaging";
import { showBacklinkGroups } from "./groups";

const group = (n: number) => ({
  page_id: pageIdOf(n), page_title: canonicalTitleOf(`P${n}`),
  items: [{ uid: uidOf(`tuid-${n}`), text: `t${n}` }],
});
const initial: Backlinks = {
  groups: [group(1)], total_pages: 3, offset: 0, limit: 1,
};
const batch = (ns: number[], totalPages = 3): BacklinkBatchState => ({
  groups: showBacklinkGroups(ns.map(group)), totalPages, refTexts: {},
});
const titles = (s: BacklinksPaging) =>
  s.shown.groups.map((g) => g.page_title);

const step = (state: BacklinksPaging, ...events: BacklinksPagingEvent[]) =>
  events.reduce(backlinksPaging, state);

const idle = () => initialBacklinksPaging(initial);
/** One walk (id 0) in flight under epoch 0. */
const oneWalk = () => step(idle(), { type: "walkStarted" });
/** Walks 0 and 1 in flight under epoch 0. */
const twoWalks = () => step(oneWalk(), { type: "walkStarted" });
/** A refresh (epoch 1) in flight. */
const refreshing = () => step(idle(), { type: "refreshStarted" });
/** Walk 0 started under epoch 0, then a refresh (epoch 1) started. */
const walkThenRefresh = () => step(oneWalk(), { type: "refreshStarted" });
const panel = () => step(idle(), { type: "panelOpened" });

const phases = { idle, oneWalk, twoWalks, refreshing, walkThenRefresh,
                 panel } as const;
type Phase = keyof typeof phases;

describe("backlinksPaging", () => {
  // Every event from every phase. "same" means the reducer refused or
  // ignored the event and returned the state object it was given.
  const b2 = batch([2]);
  const table: [Phase, BacklinksPagingEvent,
                "same" | ((before: BacklinksPaging) => BacklinksPaging)][] = [
    ["idle", { type: "walkStarted" },
     (s) => ({ ...s, walks: new Set([0]), nextWalk: 1 })],
    ["idle", { type: "panelOpened" }, (s) => ({ ...s, panelOpen: true })],
    ["idle", { type: "panelClosed" }, "same"],
    ["idle", { type: "refreshStarted" },
     (s) => ({ ...s, epoch: 1, refreshing: true })],
    ["idle", { type: "walkLoaded", id: 0, epoch: 0, result: b2 }, "same"],
    ["idle", { type: "walkFailed", id: 0, epoch: 0, message: "x" }, "same"],
    ["idle", { type: "walkDropped", id: 0 }, "same"],
    ["idle", { type: "refreshLoaded", epoch: 0, result: b2 }, "same"],
    ["idle", { type: "refreshFailed", epoch: 0, message: "x" }, "same"],
    ["oneWalk", { type: "walkLoaded", id: 0, epoch: 0, result: b2 },
     (s) => ({ ...s, walks: new Set(), shown: batch([1, 2]) })],
    ["oneWalk", { type: "walkFailed", id: 0, epoch: 0, message: "x" },
     (s) => ({ ...s, walks: new Set(), walkError: "x" })],
    ["oneWalk", { type: "walkDropped", id: 0 },
     (s) => ({ ...s, walks: new Set() })],
    ["oneWalk", { type: "walkLoaded", id: 7, epoch: 0, result: b2 }, "same"],
    ["oneWalk", { type: "walkStarted" },
     (s) => ({ ...s, walks: new Set([0, 1]), nextWalk: 2 })],
    ["oneWalk", { type: "panelOpened" }, (s) => ({ ...s, panelOpen: true })],
    ["refreshing", { type: "walkStarted" }, "same"],
    ["refreshing", { type: "panelOpened" }, "same"],
    ["refreshing", { type: "refreshStarted" }, (s) => ({ ...s, epoch: 2 })],
    ["refreshing", { type: "refreshLoaded", epoch: 1, result: b2 },
     (s) => ({ ...s, refreshing: false, shown: b2 })],
    ["refreshing", { type: "refreshFailed", epoch: 1, message: "x" },
     (s) => ({ ...s, refreshing: false, refreshError: "x" })],
    ["refreshing", { type: "refreshLoaded", epoch: 0, result: b2 }, "same"],
    ["refreshing", { type: "refreshFailed", epoch: 0, message: "x" }, "same"],
    ["walkThenRefresh", { type: "walkLoaded", id: 0, epoch: 0, result: b2 },
     (s) => ({ ...s, walks: new Set() })],
    ["walkThenRefresh", { type: "walkFailed", id: 0, epoch: 0, message: "x" },
     (s) => ({ ...s, walks: new Set() })],
    ["walkThenRefresh", { type: "walkDropped", id: 0 },
     (s) => ({ ...s, walks: new Set() })],
    ["panel", { type: "panelOpened" }, "same"],
    ["panel", { type: "panelClosed" }, (s) => ({ ...s, panelOpen: false })],
    ["panel", { type: "refreshStarted" },
     (s) => ({ ...s, epoch: 1, refreshing: true })],
  ];
  it.each(table)("from %s, %j", (phase, event, expected) => {
    const before = phases[phase]();
    const after = backlinksPaging(before, event);
    if (expected === "same") expect(after).toBe(before);
    else expect(after).toEqual(expected(before));
  });

  it("starts from the initial batch with nothing in flight", () => {
    const s = idle();
    expect(titles(s)).toEqual(["P1"]);
    expect(hasMore(s)).toBe(true);
    expect(walking(s)).toBe(false);
  });

  it("a walk cannot start while a refresh is in flight", () => {
    const s = refreshing();
    expect(step(s, { type: "walkStarted" })).toBe(s);
    const done = step(s, { type: "refreshLoaded", epoch: 1,
                           result: batch([1]) });
    expect(walking(step(done, { type: "walkStarted" }))).toBe(true);
  });

  it("the panel cannot open while a refresh is in flight", () => {
    const s = refreshing();
    expect(step(s, { type: "panelOpened" })).toBe(s);
    const open = step(panel(), { type: "refreshStarted" });
    expect(step(open, { type: "panelClosed" }).panelOpen).toBe(false);
  });

  it("a refresh result replaces the shown groups only under its own epoch",
     () => {
    const s = step(oneWalk(), { type: "walkLoaded", id: 0, epoch: 0,
                                result: batch([2]) },
                   { type: "refreshStarted" });
    expect(titles(s)).toEqual(["P1", "P2"]);
    const done = step(s, { type: "refreshLoaded", epoch: s.epoch,
                           result: batch([3], 1) });
    expect(titles(done)).toEqual(["P3"]);
    expect(done.shown.totalPages).toBe(1);
    expect(done.refreshing).toBe(false);
  });

  it("an older refresh's result after a newer one started changes nothing",
     () => {
    const newer = step(refreshing(), { type: "refreshStarted" });
    expect(step(newer, { type: "refreshLoaded", epoch: 1,
                         result: batch([9]) })).toBe(newer);
    expect(step(newer, { type: "refreshFailed", epoch: 1, message: "x" }))
      .toBe(newer);
    expect(newer.refreshing).toBe(true);
  });

  it("a walk result from before a refresh is dropped", () => {
    const s = walkThenRefresh();
    const after = step(s, { type: "walkLoaded", id: 0, epoch: 0,
                            result: batch([1, 2, 3]) });
    expect(titles(after)).toEqual(["P1"]);
    expect(walking(after)).toBe(false);
  });

  it("two walks in flight merge onto the latest state, whichever lands first",
     () => {
    const s = twoWalks();
    const later = (first: 0 | 1) => {
      const a = { type: "walkLoaded", id: 0, epoch: 0,
                  result: batch([1, 2]) } as const;
      const b = { type: "walkLoaded", id: 1, epoch: 0,
                  result: batch([1, 3]) } as const;
      return first === 0 ? step(s, a, b) : step(s, b, a);
    };
    expect(titles(later(0))).toEqual(["P1", "P2", "P3"]);
    expect(titles(later(1))).toEqual(["P1", "P3", "P2"]);
    expect(walking(later(0))).toBe(false);
  });

  it("the section stays loading until every walk has settled", () => {
    const s = step(twoWalks(), { type: "walkLoaded", id: 0, epoch: 0,
                                 result: batch([2]) });
    expect(walking(s)).toBe(true);
    const failed = step(s, { type: "walkFailed", id: 1, epoch: 0,
                             message: "boom" });
    expect(walking(failed)).toBe(false);
  });

  it("a failed walk shows its error only under its own epoch", () => {
    expect(step(oneWalk(), { type: "walkFailed", id: 0, epoch: 0,
                             message: "boom" }).walkError).toBe("boom");
    expect(step(walkThenRefresh(), { type: "walkFailed", id: 0, epoch: 0,
                                     message: "boom" }).walkError).toBeNull();
  });

  it("a new walk clears the last walk's error", () => {
    const failed = step(oneWalk(), { type: "walkFailed", id: 0, epoch: 0,
                                     message: "boom" });
    expect(step(failed, { type: "walkStarted" }).walkError).toBeNull();
  });

  it("a failed refresh keeps the shown groups", () => {
    const s = step(refreshing(), { type: "refreshFailed", epoch: 1,
                                   message: "refresh boom" });
    expect(titles(s)).toEqual(["P1"]);
    expect(s.refreshError).toBe("refresh boom");
    expect(s.refreshing).toBe(false);
    expect(step(s, { type: "refreshStarted" }).refreshError).toBeNull();
  });
});
