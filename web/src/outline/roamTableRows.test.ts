import { describe, expect, test } from "vitest";
import { block } from "../test-helpers";
import { roamTable, roamTableRows } from "./roamTableRows";

const texts = (rows: ReturnType<typeof roamTableRows>) =>
  rows?.map((row) => row.map((cell) => cell?.text ?? null));

function validTable(text = "{{[[table]]}}") {
  return block("tuid-table", text, { children: [
    block("tuid-h1", "**Model**", { children: [
      block("tuid-h2", "Price", { children: [block("tuid-h3", "Plan")] }),
    ] }),
    block("tuid-r1c1", "[[Claude]]", { children: [
      block("tuid-r1c2", "$5", { children: [block("tuid-r1c3", "Pro")] }),
    ] }),
  ] });
}

describe("roamTableRows", () => {
  test("converts direct-child rows and their child chains in source order", () => {
    expect(texts(roamTableRows(validTable()))).toEqual([
      ["**Model**", "Price", "Plan"],
      ["[[Claude]]", "$5", "Pro"],
    ]);
  });

  test("accepts both exact macro spellings with whitespace and case", () => {
    expect(roamTableRows(validTable("  {{TABLE}}  "))).not.toBeNull();
    expect(roamTableRows(validTable("{{[[TaBlE]]}}"))).not.toBeNull();
  });

  test("a table macro with options still yields rows", () => {
    const table = validTable("{{table | sort: Lab desc}}");
    expect(texts(roamTableRows(table))).toEqual([
      ["**Model**", "Price", "Plan"],
      ["[[Claude]]", "$5", "Pro"],
    ]);
    expect(roamTable(table)?.options)
      .toStrictEqual({ sort: { col: "Lab", dir: "desc" } });
  });

  test("a bare table macro has no options", () => {
    expect(roamTable(validTable("{{table}}"))?.options).toStrictEqual({});
  });

  test("rejects non-table and empty table blocks", () => {
    expect(roamTableRows(validTable("before {{table}}"))).toBeNull();
    expect(roamTableRows(block("tuid-empty", "{{table}}"))).toBeNull();
    expect(roamTable(block("tuid-empty", "{{table | sort: A asc}}")))
      .toBeNull();
    expect(roamTableRows(validTable("{{table|sort: A asc}}"))).toBeNull();
    expect(roamTableRows(validTable("{{table | view: cards}} notes {{toc}}")))
      .toBeNull();
    expect(roamTableRows(validTable("{{table | a}} {{query: {and: [[B]]}}}")))
      .toBeNull();
  });

  test("pads ragged rows to the widest row", () => {
    const table = validTable();
    table.children[1].children[0].children = [];
    expect(texts(roamTableRows(table))).toEqual([
      ["**Model**", "Price", "Plan"],
      ["[[Claude]]", "$5", null],
    ]);
  });

  test("rejects branching cell structures rather than hiding a branch", () => {
    const table = validTable();
    table.children[0].children.push(block("branch", "must remain visible"));
    expect(roamTableRows(table)).toBeNull();
  });
});
