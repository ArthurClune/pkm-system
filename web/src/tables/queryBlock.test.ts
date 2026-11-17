import { describe, expect, it } from "vitest";
import type {
  KeyStat, QueryGroup, QueryRecordModel, QueryRecordsPayload,
} from "../api/payloads";
import type { MacroOptions } from "../grammar/macroOptions";
import { canonicalTitleOf, pageIdOf, uidOf } from "../test-helpers";
import {
  initialQueryBlock, QUERY_BLOCK, type QueryBlockEvent, type QueryBlockState,
} from "./queryBlock";
import { editedEvent } from "./queryViewState";

const { step, shown, wantsBlocks, groupsFetchDue } = QUERY_BLOCK;

function record(key: string, cells: Record<string, string>): QueryRecordModel {
  return {
    key, kind: "page", page_id: pageIdOf(1), page_title: canonicalTitleOf(key),
    uid: null, row_title: key, result_uids: [uidOf(`result-${key}`)],
    cells: Object.fromEntries(Object.entries(cells).map(([k, v], i) => [k, {
      uid: uidOf(`cell-${key}-${i}`), key_raw: k, text: `${k}:: ${v}`, value: v,
      value_start: k.length + 2 }])),
    insert_parent_uid: null, insert_before_order_idx: null,
    last_attr_order_idx: null,
  };
}

const AUTHOR: KeyStat = { key: canonicalTitleOf("author"), label: "author",
                          count: 2 };

/** Records with an author cell: a table by default, no groups. */
const table = (...keys: string[]): QueryRecordsPayload => ({
  records: keys.map((k) => record(k, { author: k })), keys: [AUTHOR],
  total: keys.length, groups: null,
});

/** Records with no `::` line: blocks by default, groups carried. */
const bare = (groups: QueryGroup[] = []): QueryRecordsPayload => ({
  records: [record("a", {})], keys: [], total: 1, groups,
});

const run = (s: QueryBlockState, ...events: QueryBlockEvent[]) =>
  events.reduce(step, s);

const landed = (load: string, payload: QueryRecordsPayload): QueryBlockEvent =>
  ({ kind: "recordsLanded", load, payload });

const pick = (view: "table" | "cards" | "blocks"): QueryBlockEvent =>
  ({ kind: "view", event: { kind: "view", view } });

const start = (options: MacroOptions = {}) => initialQueryBlock(options);

describe("whether a block starts /api/query", () => {
  it("not for a table query, before or after its records land", () => {
    const s = start();
    expect(groupsFetchDue(s, "L0")).toBe(false);
    expect(groupsFetchDue(run(s, landed("L0", table("a"))), "L0")).toBe(false);
  });

  it("with the records when the macro saves the blocks view", () => {
    const s = start({ view: "blocks" });
    expect(wantsBlocks(s)).toBe(true);
    expect(groupsFetchDue(s, "L0")).toBe(true);
  });

  it("once per load: not again while the first is out", () => {
    const s = run(start({ view: "blocks" }),
                  { kind: "groupsStarted", load: "L0" });
    expect(groupsFetchDue(s, "L0")).toBe(false);
    expect(groupsFetchDue(s, "L1")).toBe(true);
  });

  it("not once the records carried this load's groups", () => {
    const s = run(start(), landed("L0", bare()));
    expect(wantsBlocks(s)).toBe(true);
    expect(groupsFetchDue(s, "L0")).toBe(false);
  });

  it("when the reader picks Blocks over a table", () => {
    const s = run(start(), landed("L0", table("a")), pick("blocks"));
    expect(groupsFetchDue(s, "L0")).toBe(true);
  });

  it("for a new load only once its records settle, which may carry them", () => {
    const s = run(start(), landed("L0", table("a")), pick("blocks"),
                  { kind: "groupsStarted", load: "L0" },
                  { kind: "groupsLanded", load: "L0", groups: [] });
    expect(groupsFetchDue(s, "L1")).toBe(false);
    expect(groupsFetchDue(run(s, landed("L1", table("a"))), "L1")).toBe(true);
    expect(groupsFetchDue(run(s, { kind: "recordsFailed", load: "L1",
                                   error: "boom" }), "L1")).toBe(true);
  });

  it("not again after a failure, until the reader leaves Blocks and returns", () => {
    const failed = run(start({ view: "blocks" }),
                       { kind: "groupsStarted", load: "L0" },
                       { kind: "groupsFailed", load: "L0", error: "boom" },
                       landed("L0", table("a")));
    expect(failed.groupsError).toBe("boom");
    expect(groupsFetchDue(failed, "L0")).toBe(false);
    const left = run(failed, pick("table"));
    expect(left.groupsTried).toBeNull();
    expect(groupsFetchDue(run(left, pick("blocks")), "L0")).toBe(true);
  });
});

describe("a groups answer", () => {
  const saved = run(start({ view: "blocks" }),
                    { kind: "groupsStarted", load: "L0" });

  it("lands for the load its fetch was started for", () => {
    const groups: QueryGroup[] = [];
    const s = run(saved, { kind: "groupsLanded", load: "L0", groups });
    expect(s.groups).toBe(groups);
    expect(s.groupsFor).toBe("L0");
  });

  it("is ignored once the records carried the same load's groups", () => {
    const carried: QueryGroup[] = [];
    const s = run(saved, landed("L0", bare(carried)),
                  { kind: "groupsLanded", load: "L0", groups: [] },
                  { kind: "groupsFailed", load: "L0", error: "late" });
    expect(s.groups).toBe(carried);
    expect(s.groupsError).toBeNull();
  });

  it("for an old load never replaces the current load's groups", () => {
    const carried: QueryGroup[] = [];
    const s = run(saved, landed("L1", bare(carried)),
                  { kind: "groupsLanded", load: "L0", groups: [] });
    expect(s.groups).toBe(carried);
    expect(s.groupsFor).toBe("L1");
  });

  it("is dropped when the reader left Blocks while it was out", () => {
    const s = run(start(), landed("L0", table("a")), pick("blocks"),
                  { kind: "groupsStarted", load: "L0" }, pick("table"),
                  { kind: "groupsLanded", load: "L0", groups: [] });
    expect(s.groups).toBeNull();
  });
});

describe("a records load landing", () => {
  it("holds a dropped row under the rows frozen when it lands", () => {
    let s = run(start(), landed("L0", table("a", "b")));
    const now = shown(s);
    if (now === null || s.loaded === null) throw new Error("not loaded");
    s = run(s, { kind: "view", event: editedEvent(now, s.loaded.keys) },
            landed("L1", table("b")));
    expect(s.qv?.view.frozen).toEqual(["a", "b"]);
    expect([...s.held.keys()]).toEqual(["a"]);
    expect(shown(s)?.rows.map((r) => [r.record.key, r.stale]))
      .toEqual([["a", true], ["b", false]]);
  });

  it("steps a clean view to the new defaults", () => {
    const s = run(start(), landed("L0", table("a")), landed("L1", bare()));
    expect(shown(s)?.view).toBe("blocks");
    expect(s.recordsFor).toBe("L1");
  });

  it("clears an earlier records error", () => {
    const s = run(start(), { kind: "recordsFailed", load: "L0", error: "x" },
                  landed("L1", table("a")));
    expect(s.error).toBeNull();
  });
});

describe("a refresh", () => {
  /** Rows a and b shown, then frozen by an edit; `pre` runs before it. */
  const frozen = (...pre: QueryBlockEvent[]) => {
    let s = run(start(), landed("L0", table("a", "b")), ...pre);
    const now = shown(s);
    if (now === null || s.loaded === null) throw new Error("not loaded");
    s = run(s, { kind: "view", event: editedEvent(now, s.loaded.keys) });
    expect(s.qv?.view.frozen).not.toBeNull();
    return s;
  };
  const refresh = (load: string): QueryBlockEvent => ({ kind: "refresh", load });

  it("releases the held rows when a newer load's records land", () => {
    const s = run(frozen(), refresh("L0"), landed("L1", table("b")));
    expect(s.qv?.view.frozen).toBeNull();
    expect(s.qv?.held).toBeNull();
    expect(shown(s)?.rows.map((r) => [r.record.key, r.stale]))
      .toEqual([["b", false]]);
    expect(s.refreshFrom).toBeNull();
  });

  it("holds through a landing of the load it was clicked on", () => {
    const s = run(frozen(), refresh("L0"), landed("L0", table("b")));
    expect(s.qv?.view.frozen).toEqual(["a", "b"]);
    expect(s.refreshFrom).toBe("L0");
  });

  it("holds through a failure, and the next landing releases", () => {
    let s = run(frozen(), refresh("L0"),
                { kind: "recordsFailed", load: "L1", error: "x" });
    expect(s.qv?.view.frozen).toEqual(["a", "b"]);
    expect(s.refreshFrom).toBe("L0");
    s = run(s, landed("L2", table("b")));
    expect(s.qv?.view.frozen).toBeNull();
    expect(s.refreshFrom).toBeNull();
  });

  it("a second click keeps the first click's load", () => {
    const s = run(frozen(), refresh("L0"), refresh("L1"));
    expect(s.refreshFrom).toBe("L0");
    expect(run(s, landed("L1", table("b"))).qv?.view.frozen).toBeNull();
  });

  it("keeps the live view's unsaved filter", () => {
    const filter: QueryBlockEvent = {
      kind: "view", event: { kind: "filter", text: "a" } };
    const s = run(frozen(filter), refresh("L0"), landed("L1", table("b")));
    expect(s.qv?.view.live.filter).toBe("a");
    expect(s.qv?.view.frozen).toBeNull();
  });

  it("a landing with no refresh pending still holds", () => {
    const s = run(frozen(), landed("L1", table("b")));
    expect(s.qv?.view.frozen).toEqual(["a", "b"]);
  });
});

describe("the macro's options", () => {
  it("step a clean view to what they save", () => {
    const s = run(start(), landed("L0", table("a")),
                  { kind: "options", options: { view: "cards" } });
    expect(shown(s)?.view).toBe("cards");
  });

  it("leave the state as it is when unchanged", () => {
    const options = {};
    const s = run(start(options), landed("L0", table("a")));
    expect(step(s, { kind: "options", options })).toBe(s);
  });
});

it("patches a cell in the records and in a held record", () => {
  let s = run(start(), landed("L0", table("a", "b")));
  const now = shown(s);
  if (now === null || s.loaded === null) throw new Error("not loaded");
  s = run(s, { kind: "view", event: editedEvent(now, s.loaded.keys) },
          landed("L1", table("b")));
  const mark = (r: QueryRecordModel) => ({ ...r, row_title: `${r.key}!` });
  s = run(s, { kind: "patch", key: "a", fn: mark },
          { kind: "patch", key: "b", fn: mark });
  expect(s.held.get("a")?.row_title).toBe("a!");
  expect(s.records.map((r) => r.row_title)).toEqual(["b!"]);
});
