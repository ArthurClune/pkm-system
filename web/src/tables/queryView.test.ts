import { describe, expect, it } from "vitest";
import type {
  KeyStat, QueryRecordModel, QueryRecordsPayload, RecordCell,
} from "../api/payloads";
import type { BlockOp } from "../api/ops";
import { sha256Hex } from "../replica/sha256";
import { subtreeHash } from "../replica/subtreeHash";
import {
  canonicalTitleOf, orderIdxOf, pageIdOf, uidOf,
} from "../test-helpers";
import {
  inverseCellWrite, patchRecord, planQuerySave, queryColumns, queryDefaults,
  restoreCell, shownRows, writeMessage,
} from "./queryView";
import type { ViewFields } from "./viewState";

const u = (id: string) => uidOf(`block-${id}`);

function cell(id: string, text: string, extra: Partial<RecordCell> = {}):
    RecordCell {
  const at = text.indexOf("::") + 2;
  return {
    uid: u(id), key_raw: text.slice(0, at - 2), text,
    value: text.slice(at).trimStart(), value_start: at, child_count: 0,
    ...extra,
  };
}

function record(key: string, name: string, cells: Record<string, RecordCell>,
                extra: Partial<QueryRecordModel> = {}): QueryRecordModel {
  return {
    key, kind: "page", page_id: pageIdOf(1),
    page_title: canonicalTitleOf(name), uid: null, row_title: name,
    result_uids: [u(`r${key.replace(":", "")}`)], cells, insert_parent_uid: null,
    insert_before_order_idx: null, last_attr_order_idx: null,
    ...extra,
  };
}

function stat(key: string, count: number, label = key): KeyStat {
  return { key: canonicalTitleOf(key), label, count };
}

const view = (over: Partial<ViewFields> = {}): ViewFields =>
  ({ filter: "", sort: null, view: "table", columns: [], ...over });

const A = record("p:a", "Alpha", {
  Author: cell("a1", "Author:: Xavier"),
  "Reading Status": cell("s1", "Reading Status:: Read"),
});
const B = record("p:b", "Beta", {
  Author: cell("a2", "author:: Yolanda"),
});
const KEYS = [stat("Author", 2), stat("Reading Status", 1)];
const PAYLOAD: QueryRecordsPayload = { records: [A, B], keys: KEYS, total: 2 };

describe("queryDefaults", () => {
  it("is a table of the shared keys' labels when any record has cells", () => {
    const p = { ...PAYLOAD, keys: [stat("Author", 2, "Writer"),
                                   stat("Reading Status", 1)], total: 3 };
    expect(queryDefaults(p)).toEqual({ view: "table", columns: ["Writer"] });
  });

  it("is blocks when no record has a :: line", () => {
    const bare = { records: [record("p:c", "C", {})], keys: [], total: 1 };
    expect(queryDefaults(bare)).toEqual({ view: "blocks", columns: [] });
  });
});

describe("queryColumns", () => {
  it("maps a column name to its key by label, then by key", () => {
    const keys = [stat("Pub", 1, "Published")];
    expect(queryColumns(["Published", "Pub", "Nowhere"], keys)).toEqual([
      { name: "Published", label: "Published", key: "Pub" },
      { name: "Pub", label: "Pub", key: "Pub" },
      { name: "Nowhere", label: "Nowhere", key: "Nowhere" },
    ]);
  });

  it("names an attribute called Result apart from the title column", () => {
    expect(queryColumns(["Result"], [stat("Result", 1)])).toEqual([
      { name: "Result::", label: "Result", key: "Result" },
    ]);
  });

  it("drops a repeated name", () => {
    expect(queryColumns(["Author", "Author"], KEYS)).toHaveLength(1);
  });
});

describe("shownRows", () => {
  const cols = queryColumns(["Author", "Reading Status"], KEYS);

  it("filters on a column by the prefix of its name", () => {
    const { rows, matching } = shownRows([A, B], cols, view({ filter: "-status:read" }), null);
    expect(rows.map((r) => r.record.key)).toEqual(["p:b"]);
    expect(matching).toBe(1);
  });

  it("sorts on a column name, and on Result", () => {
    const desc = shownRows([A, B], cols,
      view({ sort: { col: "Author", dir: "desc" } }), null);
    expect(desc.rows.map((r) => r.record.key)).toEqual(["p:b", "p:a"]);
    const title = shownRows([B, A], cols,
      view({ sort: { col: "Result", dir: "asc" } }), null);
    expect(title.rows.map((r) => r.record.key)).toEqual(["p:a", "p:b"]);
  });

  it("holds frozen rows in place and marks the ones that stopped matching", () => {
    const { rows, matching } = shownRows([A, B], cols,
      view({ filter: "-status:read", sort: { col: "Author", dir: "desc" } }),
      ["p:a", "p:b", "p:gone"]);
    expect(rows.map((r) => [r.record.key, r.stale])).toEqual([
      ["p:a", true], ["p:b", false]]);
    expect(matching).toBe(1);
  });

  it("matches on the Source of a line record", () => {
    const line = record("l:1", "a line", {}, {
      kind: "line", uid: u("l1"), page_title: canonicalTitleOf("Reading List"),
    });
    const { rows } = shownRows([A, line], cols, view({ filter: "source:reading" }), null);
    expect(rows.map((r) => r.record.key)).toEqual(["l:1"]);
  });
});

describe("planQuerySave", () => {
  const EXPR = "{and: [[Book]]}";
  const refusalOf = (r: ReturnType<typeof planQuerySave>) =>
    "refusal" in r ? r.refusal : null;

  it("rewrites the macro found in the host's own text", () => {
    const host = `> see {{query: ${EXPR}}} here`;
    expect(planQuerySave(host, EXPR, {}, { filter: "kind" })).toEqual({
      text: `> see {{query: ${EXPR} | filter: kind}} here`,
    });
  });

  it("picks the macro whose options match when the expression repeats", () => {
    const host = `{{query: ${EXPR}}} {{query: ${EXPR} | view: cards}}`;
    expect(planQuerySave(host, EXPR, { view: "cards" }, { view: "blocks" }))
      .toEqual({ text: `{{query: ${EXPR}}} {{query: ${EXPR} | view: blocks}}` });
  });

  it("refuses when the host does not hold the macro", () => {
    const r = planQuerySave("((abcdefghi))", EXPR, {}, { filter: "x" });
    expect(refusalOf(r)).toMatch(/find this query/);
  });

  it("refuses when two identical macros make the target ambiguous", () => {
    const host = `{{query: ${EXPR}}} {{query: ${EXPR}}}`;
    const r = planQuerySave(host, EXPR, {}, { filter: "x" });
    expect(refusalOf(r)).toMatch(/find this query/);
  });

  it("refuses option text that cannot round-trip", () => {
    const r = planQuerySave(`{{query: ${EXPR}}}`, EXPR, {}, { filter: "a [[b" });
    expect(refusalOf(r)).toMatch(/cannot contain/);
  });

  it("refuses when the rewritten macro would read back other options", () => {
    // An unclosed [[ in the head swallows every ` | ` after it.
    const expr = "{and: [[Book}";
    const r = planQuerySave(`{{query: ${expr}}}`, expr, {}, { filter: "x" });
    expect(refusalOf(r)).toMatch(/read back/);
  });
});

describe("cell write bookkeeping", () => {
  it("inverts an update to the text it replaced", () => {
    const ops: BlockOp[] = [{
      op: "update_text", uid: u("s1"), text: "Reading Status:: Unread",
      base_text_hash: sha256Hex("Reading Status:: Read"),
      page_title: canonicalTitleOf("Alpha"),
    }];
    expect(inverseCellWrite(A, "Reading Status", ops)).toEqual([{
      op: "update_text", uid: u("s1"), text: "Reading Status:: Read",
      base_text_hash: sha256Hex("Reading Status:: Unread"),
      page_title: canonicalTitleOf("Alpha"),
    }]);
  });

  it("inverts a create to a delete of what it made", () => {
    const ops: BlockOp[] = [{
      op: "create", uid: u("n1"), page_title: canonicalTitleOf("Beta"),
      parent_uid: null, order_idx: orderIdxOf(1), text: "Reading Status:: Read",
    }];
    expect(inverseCellWrite(B, "Reading Status", ops)).toEqual([{
      op: "delete", uid: u("n1"),
      base_subtree_hash: subtreeHash([[u("n1"), "Reading Status:: Read"]]),
    }]);
  });

  it("patches an updated cell's text and value", () => {
    const next = patchRecord(A, "Reading Status", [{
      op: "update_text", uid: u("s1"), text: "Reading Status:: Unread",
    }]);
    expect(next.cells["Reading Status"]).toMatchObject({
      text: "Reading Status:: Unread", value: "Unread" });
    expect(A.cells["Reading Status"]!.value).toBe("Read");
  });

  it("patches a created cell in, and moves the next insert past it", () => {
    const r = record("p:c", "C", {}, { insert_before_order_idx: orderIdxOf(4) });
    const next = patchRecord(r, "Format", [{
      op: "create", uid: u("n2"), page_title: canonicalTitleOf("C"),
      parent_uid: null, order_idx: orderIdxOf(4), text: "Format:: Kindle",
    }]);
    expect(next.cells.Format).toEqual({
      uid: u("n2"), key_raw: "Format", text: "Format:: Kindle",
      value: "Kindle", value_start: 8, child_count: 0,
    });
    expect(next.insert_before_order_idx).toBe(5);
    const tail = patchRecord(record("p:d", "D", {}), "Format", [{
      op: "create", uid: u("n3"), page_title: canonicalTitleOf("D"),
      parent_uid: null, order_idx: orderIdxOf(0), text: "Format:: Kindle",
    }]);
    expect(tail.last_attr_order_idx).toBe(0);
  });

  it("restores one cell and the insert slot from before a write", () => {
    const before = record("p:c", "C", { Author: cell("ca", "Author:: Z") },
                          { insert_before_order_idx: orderIdxOf(4) });
    const created = patchRecord(before, "Format", [{
      op: "create", uid: u("n4"), page_title: canonicalTitleOf("C"),
      parent_uid: null, order_idx: orderIdxOf(4), text: "Format:: Kindle",
    }]);
    const meanwhile = patchRecord(created, "Author", [{
      op: "update_text", uid: u("ca"), text: "Author:: Y" }]);
    const back = restoreCell(meanwhile, before, "Format");
    expect(Object.keys(back.cells)).toEqual(["Author"]);
    expect(back.cells.Author!.value).toBe("Y");
    expect(back.insert_before_order_idx).toBe(4);
    expect(restoreCell(patchRecord(A, "Reading Status", [{
      op: "update_text", uid: u("s1"), text: "Reading Status:: x" }]),
      A, "Reading Status")).toEqual(A);
  });

  it("names the key, value and page", () => {
    expect(writeMessage("Reading Status", "Read", canonicalTitleOf("Alpha")))
      .toBe("Reading Status:: Read written to Alpha");
    expect(writeMessage("Format", "", canonicalTitleOf("Alpha")))
      .toBe("Format cleared on Alpha");
  });
});
