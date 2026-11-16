import { describe, expect, it } from "vitest";
import type { KeyStat, QueryRecordModel } from "../api/payloads";
import { canonicalTitleOf, pageIdOf, uidOf } from "../test-helpers";
import {
  editedEvent, initialQueryView, showQuery, stepQueryView, type HeldShown,
  type QueryViewState,
} from "./queryViewState";
import type { ViewFields } from "./viewState";

const stat = (key: string, label = key): KeyStat =>
  ({ key: canonicalTitleOf(key), label, count: 1 });

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

const SAVED: ViewFields =
  { filter: "", sort: null, view: "table", columns: ["Author", "Gone"] };
const SHOWN: HeldShown = { view: "table", columns: ["Author", "Gone"],
                           keys: [stat("author", "Author"), stat("gone", "Gone")] };
const A = record("a", { author: "X", gone: "1" });
const B = record("b", { author: "Y" });
const none = new Map<string, QueryRecordModel>();

/** Clean, edited once, then a refetch whose defaults lost Gone and the
 * table. */
function heldThenLoaded(): QueryViewState {
  let s = initialQueryView(SAVED);
  s = stepQueryView(s, { kind: "edited", visibleIds: ["a", "b"], shown: SHOWN });
  return stepQueryView(s, { kind: "loaded",
                            saved: { ...SAVED, view: "blocks", columns: ["Author"] } });
}

describe("stepQueryView", () => {
  it("takes the snapshot with the freeze", () => {
    expect(heldThenLoaded().held).toBe(SHOWN);
  });

  it("keeps the first edit's snapshot through later edits", () => {
    const s = stepQueryView(heldThenLoaded(), { kind: "edited", visibleIds: ["b"],
      shown: { ...SHOWN, columns: ["Author"] } });
    expect(s.held).toBe(SHOWN);
  });

  it("drops it with the held rows", () => {
    const s = stepQueryView(heldThenLoaded(), { kind: "filter", text: "x" });
    expect(s).toMatchObject({ held: null, view: { frozen: null } });
  });
});

describe("showQuery", () => {
  const keys = [stat("author", "Author")];

  it("shows the first edit's view and columns, keyed by its stats", () => {
    const shown = showQuery(heldThenLoaded(), {}, keys, [B], new Map([["a", A]]));
    expect(shown.view).toBe("table");
    expect(shown.columns.map((c) => [c.label, c.key]))
      .toEqual([["Author", "author"], ["Gone", "gone"]]);
    expect(shown.rows.map((r) => [r.record.key, r.stale]))
      .toEqual([["a", true], ["b", false]]);
  });

  it("shows what the macro sets as it is", () => {
    const shown = showQuery(heldThenLoaded(), { view: "blocks", columns: ["Author"] },
                            keys, [B], none);
    expect(shown.view).toBe("blocks");
    expect(shown.columns.map((c) => c.label)).toEqual(["Author"]);
  });

  it("shows the live view once the rows are released", () => {
    const s = stepQueryView(heldThenLoaded(), { kind: "reset" });
    const shown = showQuery(s, {}, keys, [B], none);
    expect(shown.view).toBe("blocks");
    expect(shown.columns.map((c) => c.label)).toEqual(["Author"]);
  });
});

describe("editedEvent", () => {
  it("carries the rows, view, column labels and stats on screen", () => {
    const shown = showQuery(initialQueryView(SAVED), {}, SHOWN.keys, [A, B], none);
    expect(editedEvent(shown, SHOWN.keys)).toEqual({
      kind: "edited", visibleIds: ["a", "b"], shown: SHOWN });
  });
});
