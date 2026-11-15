import { describe, expect, it } from "vitest";
import type { BlockUid } from "../api/brands";
import { block, canonicalTitleOf, orderIdxOf, uidOf } from "../test-helpers";
import { roamTableRows } from "../outline/roamTableRows";
import { planNewRow, planTableCellWrite } from "./tableWrites";

const PAGE = canonicalTitleOf("Lab notes");

function minter(): () => BlockUid {
  let n = 0;
  return () => uidOf(`tuid-new${++n}`);
}

// A 3-wide table whose body row is one cell short: (r1, c2) is padding.
const TABLE = block("tuid-table", "{{table}}", { children: [
  block("tuid-h1", "Model", { children: [
    block("tuid-h2", "Price", { children: [block("tuid-h3", "Plan")] }),
  ] }),
  block("tuid-r1", "Claude", { order_idx: orderIdxOf(4), children: [
    block("tuid-r1c1", "$5"),
  ] }),
  block("tuid-r2", "Haiku", { order_idx: orderIdxOf(7) }),
] });
const ROWS = roamTableRows(TABLE)!;

describe("planTableCellWrite", () => {
  it("writes an existing cell's text", () => {
    expect(planTableCellWrite(ROWS, 1, 1, "$6", minter(), PAGE))
      .toEqual({ kind: "text", uid: uidOf("tuid-r1c1"), text: "$6" });
  });

  it("writes nothing when an existing cell keeps its text", () => {
    expect(planTableCellWrite(ROWS, 1, 1, "$5", minter(), PAGE)).toBeNull();
  });

  it("a padding cell creates its one missing block under the row's last cell", () => {
    expect(planTableCellWrite(ROWS, 1, 2, "Pro", minter(), PAGE)).toEqual({
      kind: "create",
      ops: [{ op: "create", uid: uidOf("tuid-new1"), page_title: PAGE,
              parent_uid: uidOf("tuid-r1c1"), order_idx: orderIdxOf(0),
              text: "Pro" }],
    });
  });

  it("a padding cell further along creates the empty cells before it", () => {
    expect(planTableCellWrite(ROWS, 2, 2, "Free", minter(), PAGE)).toEqual({
      kind: "create",
      ops: [
        { op: "create", uid: uidOf("tuid-new1"), page_title: PAGE,
          parent_uid: uidOf("tuid-r2"), order_idx: orderIdxOf(0), text: "" },
        { op: "create", uid: uidOf("tuid-new2"), page_title: PAGE,
          parent_uid: uidOf("tuid-new1"), order_idx: orderIdxOf(0),
          text: "Free" },
      ],
    });
  });

  it("an empty value in a padding cell creates nothing", () => {
    expect(planTableCellWrite(ROWS, 2, 2, "", minter(), PAGE)).toBeNull();
  });

  it("a cell outside the table writes nothing", () => {
    expect(planTableCellWrite(ROWS, 3, 0, "x", minter(), PAGE)).toBeNull();
    expect(planTableCellWrite(ROWS, 1, 3, "x", minter(), PAGE)).toBeNull();
  });
});

describe("planNewRow", () => {
  it("appends a row after the table's last child with a chain as wide as the table", () => {
    expect(planNewRow(TABLE, 3, minter(), PAGE)).toEqual([
      { op: "create", uid: uidOf("tuid-new1"), page_title: PAGE,
        parent_uid: uidOf("tuid-table"), order_idx: orderIdxOf(8), text: "" },
      { op: "create", uid: uidOf("tuid-new2"), page_title: PAGE,
        parent_uid: uidOf("tuid-new1"), order_idx: orderIdxOf(0), text: "" },
      { op: "create", uid: uidOf("tuid-new3"), page_title: PAGE,
        parent_uid: uidOf("tuid-new2"), order_idx: orderIdxOf(0), text: "" },
    ]);
  });

  it("a row of width zero is nothing", () => {
    expect(planNewRow(TABLE, 0, minter(), PAGE)).toEqual([]);
  });
});
