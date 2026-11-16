import { describe, expect, it } from "vitest";
import type {
  KeyStat, QueryRecordModel, QueryRecordsPayload, RecordCell,
} from "../api/payloads";
import { sha256Hex } from "../replica/sha256";
import {
  canonicalTitleOf, orderIdxOf, pageIdOf, uidOf,
} from "../test-helpers";
import {
  columnName, defaultColumns, planCellWrite, recordRow, similarKey,
  suggestions,
} from "./records";

function cell(id: string, text: string, extra: Partial<RecordCell> = {}):
    RecordCell {
  const at = text.indexOf("::") + 2;
  return {
    uid: u(id), key_raw: text.slice(0, at - 2), text,
    value: text.slice(at).trimStart(), value_start: at,
    ...extra,
  };
}

function record(cells: Record<string, RecordCell>,
                extra: Partial<QueryRecordModel> = {}): QueryRecordModel {
  return {
    key: "p:1", kind: "page", page_id: pageIdOf(1),
    page_title: canonicalTitleOf("Book"), uid: null, row_title: "Book",
    result_uids: [u("r1")], cells, insert_parent_uid: null,
    insert_before_order_idx: null, last_attr_order_idx: null,
    ...extra,
  };
}

function stat(key: string, count: number): KeyStat {
  return { key: canonicalTitleOf(key), label: key, count };
}

const u = (id: string) => uidOf(`block-${id}`);
const mint = () => u("new1");

describe("defaultColumns", () => {
  it("keeps keys at least half the records hold, in page order", () => {
    const p: QueryRecordsPayload = {
      records: [
        record({ type: cell("t1", "Type:: Book"),
                 isbn: cell("i1", "ISBN:: 1"),
                 author: cell("a1", "Author:: X") }),
        record({ author: cell("a2", "Author:: Y"),
                 status: cell("s2", "Status:: Read") }),
        record({ status: cell("s3", "Status:: Read"),
                 author: cell("a3", "Author:: Z") }),
        record({ author: cell("a4", "Author:: W") }),
      ],
      total: 4,
      keys: [stat("author", 4), stat("status", 2), stat("type", 1),
             stat("isbn", 1)],
      groups: null,
    };
    expect(defaultColumns(p)).toEqual(["author", "status"]);
    const lead = { ...p, total: 2 };
    expect(defaultColumns(lead)).toEqual(["type", "isbn", "author", "status"]);
  });
});

describe("recordRow", () => {
  it("maps Result, Source and each column label to its value", () => {
    const r = record({ status: cell("c1", "Reading Status:: Read") });
    const labels = new Map([["status", "Reading Status"], ["author", "Author"]]);
    expect(recordRow(r, labels)).toEqual({
      Result: "Book", Source: "page", "Reading Status": "Read",
    });
  });

  it("gives a line record its page as Source", () => {
    const r = record({}, {
      kind: "line", uid: u("l1"), row_title: "a line",
      page_title: canonicalTitleOf("Reading List"),
    });
    expect(recordRow(r, new Map())).toEqual({
      Result: "a line", Source: "Reading List",
    });
  });
});

describe("columnName", () => {
  it("renames an attribute that would shadow a fixed field", () => {
    expect(columnName("Source")).toBe("Source::");
    expect(columnName("result")).toBe("result::");
    expect(columnName("Sources")).toBe("Sources");
  });

  it("keeps the fixed fields over a same-named attribute", () => {
    const r = record({ source: cell("c1", "Source:: Wikipedia") });
    expect(recordRow(r, new Map([["source", "Source"]]))).toEqual({
      Result: "Book", Source: "page", "Source::": "Wikipedia",
    });
  });
});

describe("planCellWrite on an existing cell", () => {
  it("writes the value after the key as spelled", () => {
    const c = cell("c1", "Reading Status::");
    const ops = planCellWrite(record({ status: c }), "status",
                              "Reading Status", "Read", mint);
    expect(ops).toEqual([{
      op: "update_text", uid: u("c1"), text: "Reading Status:: Read",
      base_text_hash: sha256Hex("Reading Status::"),
      page_title: canonicalTitleOf("Book"),
    }]);
  });

  it("clears to the bare key with no trailing space", () => {
    const c = cell("c1", "Reading Status:: Read");
    const [op] = planCellWrite(record({ status: c }), "status",
                               "Reading Status", "  ", mint);
    expect(op).toMatchObject({ text: "Reading Status::" });
    expect(op).toMatchObject({
      base_text_hash: sha256Hex("Reading Status:: Read"),
    });
  });

  it("keeps the key's own spelling over the column label", () => {
    const c = cell("c1", "reading status::  Unread");
    const [op] = planCellWrite(record({ status: c }), "status",
                               "Reading Status", "Read", mint);
    expect(op).toMatchObject({ text: "reading status:: Read" });
  });

  it("writes a multi-line value verbatim", () => {
    const c = cell("c1", "Notes:: old");
    const [op] = planCellWrite(record({ notes: c }), "notes", "Notes",
                               "first\nsecond", mint);
    expect(op).toMatchObject({ text: "Notes:: first\nsecond" });
  });

  it("plans nothing when the text is unchanged", () => {
    const c = cell("c1", "Reading Status:: Read");
    expect(planCellWrite(record({ status: c }), "status", "Reading Status",
                         "Read", mint)).toEqual([]);
  });

  it.each(["Key::Read", "Key::  Read", "Key::\nRead"])(
    "plans nothing when the shown value of %j is committed", (text) => {
      const c = cell("c1", text);
      expect(c.value).toBe("Read");
      expect(planCellWrite(record({ key: c }), "key", "Key", "Read", mint))
        .toEqual([]);
    });

  it("never touches the key's later lines or children", () => {
    const c = cell("c1", "Tag:: a", {
      extra_uids: [u("c2")], child_count: 3,
    });
    const ops = planCellWrite(record({ tag: c }), "tag", "Tag", "b", mint);
    expect(ops.map((o) => o.op)).toEqual(["update_text"]);
    expect(ops[0]).toMatchObject({ uid: u("c1") });
  });
});

describe("planCellWrite on a missing cell", () => {
  it("creates before the sibling the server names", () => {
    const r = record({}, {
      kind: "line", uid: u("rec"), insert_parent_uid: u("rec"),
      insert_before_order_idx: orderIdxOf(5),
      last_attr_order_idx: orderIdxOf(2),
    });
    expect(planCellWrite(r, "status", "Reading Status", "Read", mint))
      .toEqual([{
        op: "create", uid: u("new1"), page_title: canonicalTitleOf("Book"),
        parent_uid: u("rec"), order_idx: orderIdxOf(5),
        text: "Reading Status:: Read",
      }]);
  });

  it("appends after the last :: line when nothing follows it", () => {
    const r = record({}, { last_attr_order_idx: orderIdxOf(7) });
    const [op] = planCellWrite(r, "status", "Reading Status", "Read", mint);
    expect(op).toMatchObject({ parent_uid: null, order_idx: orderIdxOf(8) });
  });

  it("goes first when the record has no children", () => {
    const r = record({});
    const [op] = planCellWrite(r, "status", "Reading Status", "Read", mint);
    expect(op).toMatchObject({ order_idx: orderIdxOf(0) });
  });

  it("plans nothing for an empty value", () => {
    expect(planCellWrite(record({}), "status", "Reading Status", " ", mint))
      .toEqual([]);
  });
});

describe("suggestions", () => {
  const records = [
    record({ status: cell("a", "Status:: Read") }),
    record({ status: cell("b", "Status:: read") }),
    record({ status: cell("c", "Status:: Unread") }),
    record({ status: cell("d", "Status::") }),
    record({}),
  ];

  it("merges case variants under the capitalised spelling", () => {
    expect(suggestions(records, "status", "")).toEqual([
      { value: "Read", count: 2 }, { value: "Unread", count: 1 },
    ]);
  });

  it("filters to values with a word starting with what is typed", () => {
    expect(suggestions(records, "status", "un")).toEqual([
      { value: "Unread", count: 1 },
    ]);
  });

  it("still offers the canonical spelling of a case variant typed", () => {
    expect(suggestions(records, "status", "read")).toEqual([
      { value: "Read", count: 2 },
    ]);
  });

  it("leaves out the value typed exactly", () => {
    expect(suggestions(records, "status", "Read")).toEqual([]);
  });

  it("returns nothing when every value is unique", () => {
    const unique = [
      record({ isbn: cell("a", "ISBN:: 1") }),
      record({ isbn: cell("b", "ISBN:: 2") }),
    ];
    expect(suggestions(unique, "isbn", "")).toEqual([]);
  });

  it("falls back to the most common spelling with no capitalised one", () => {
    const lower = [
      record({ t: cell("a", "T:: ebook") }),
      record({ t: cell("b", "T:: ebook") }),
      record({ t: cell("c", "T:: eBOOK") }),
    ];
    expect(suggestions(lower, "t", "")).toEqual([{ value: "ebook", count: 3 }]);
  });

  it("sorts ties alphabetically", () => {
    const tied = [
      record({ t: cell("a", "T:: Paper") }),
      record({ t: cell("b", "T:: Paper") }),
      record({ t: cell("c", "T:: book") }),
      record({ t: cell("d", "T:: book") }),
      record({ t: cell("e", "T:: Zine") }),
      record({ t: cell("f", "T:: Zine") }),
    ];
    expect(suggestions(tied, "t", "").map((s) => s.value))
      .toEqual(["book", "Paper", "Zine"]);
  });
});

describe("similarKey", () => {
  const typical = record({
    author: cell("a", "Author:: Hohpe"),
    publication: cell("p", "Publication:: 2017"),
    "reading status": cell("s", "Reading Status:: Read"),
    type: cell("t", "Type:: Book"),
  });

  it("finds a key sharing a stem with the label", () => {
    expect(similarKey(typical, "published", "Published")).toBe("Publication");
  });

  it("finds a key within two edits", () => {
    const r = record({ grey: cell("c", "Grey:: 50%") });
    expect(similarKey(r, "gray", "Gray")).toBe("Grey");
  });

  it("returns null when nothing is similar", () => {
    expect(similarKey(typical, "format", "Format")).toBeNull();
  });

  it("returns null when the record has the column", () => {
    expect(similarKey(typical, "publication", "Publication")).toBeNull();
  });

  it("warns on a key that differs from the column only in case", () => {
    const r = record({
      "Reading status": cell("s", "Reading status:: Read"),
    });
    expect(similarKey(r, "Reading Status", "Reading Status"))
      .toBe("Reading status");
  });

  it("prefers the closest of several", () => {
    const r = record({
      published: cell("a", "Publisher:: X"),
      publishedon: cell("b", "Published on:: 2020"),
    });
    expect(similarKey(r, "publishes", "Publishes")).toBe("Publisher");
  });
});
