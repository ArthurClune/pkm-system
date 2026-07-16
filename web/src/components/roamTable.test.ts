import { describe, expect, test } from "vitest";
import { block } from "../test-helpers";
import { roamTableRows } from "./roamTable";

const texts = (rows: ReturnType<typeof roamTableRows>) =>
  rows?.map((row) => row.map((cell) => cell?.text ?? null));

function validTable(text = "{{[[table]]}}") {
  return block("table", text, { children: [
    block("h1", "**Model**", { children: [
      block("h2", "Price", { children: [block("h3", "Plan")] }),
    ] }),
    block("r1c1", "[[Claude]]", { children: [
      block("r1c2", "$5", { children: [block("r1c3", "Pro")] }),
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

  test("rejects non-table and empty table blocks", () => {
    expect(roamTableRows(validTable("before {{table}}"))).toBeNull();
    expect(roamTableRows(block("empty", "{{table}}"))).toBeNull();
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
