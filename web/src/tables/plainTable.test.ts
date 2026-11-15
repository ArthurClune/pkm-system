import { describe, expect, it } from "vitest";
import { block, orderIdxOf } from "../test-helpers";
import { roamTable } from "../outline/roamTableRows";
import { tableMacroOptions } from "../grammar/macroOptions";
import {
  bodyRows, planTableSave, shownTableRows, tableColumns, tableSavedView,
} from "./plainTable";
import type { ViewFields } from "./viewState";

function row(id: string, ...texts: string[]) {
  const [first, ...rest] = texts;
  let child: ReturnType<typeof block> | undefined;
  rest.reverse().forEach((text, i) => {
    child = block(`${id}-c${rest.length - i}`, text,
                  { children: child ? [child] : [] });
  });
  return block(id, first!, { children: child ? [child] : [] });
}

const TABLE = block("tuid-table", "{{table}}", { children: [
  row("tuid-h", "Lab", "Cache hit"),
  row("tuid-a", "apache", "40"),
  row("tuid-b", "nginx", "7"),
  block("tuid-c", "zeta", { order_idx: orderIdxOf(3) }),
] });
const ROWS = roamTable(TABLE)!.rows;

const view = (over: Partial<ViewFields> = {}): ViewFields =>
  ({ filter: "", sort: null, view: "table", columns: [], ...over });

const ids = (r: ReturnType<typeof shownTableRows>) => r.rows.map((s) => s.item.id);

describe("tableColumns", () => {
  it("names each column by its header's text", () => {
    expect(tableColumns(ROWS[0]!).map((c) => c.key)).toEqual(["Lab", "Cache hit"]);
  });

  it("names an empty or repeated header by its position", () => {
    const t = roamTable(block("tuid-t", "{{table}}", { children: [
      row("tuid-hh", "Column 2", " ", "A", "A"),
      row("tuid-rr", "1", "2", "3", "4"),
    ] }))!;
    expect(tableColumns(t.rows[0]!).map((c) => c.key))
      .toEqual(["Column 2", "Column 2'", "A", "Column 4"]);
  });
});

describe("shownTableRows", () => {
  const columns = tableColumns(ROWS[0]!);
  const body = bodyRows(ROWS);

  it("keeps the header out of the body and counts every body row", () => {
    expect(body.map((r) => r.id)).toEqual(["tuid-a", "tuid-b", "tuid-c"]);
    expect(body.map((r) => r.index)).toEqual([1, 2, 3]);
  });

  it("sorts body rows by a column, blanks last", () => {
    const asc = shownTableRows(body, columns,
      view({ sort: { col: "Cache hit", dir: "asc" } }), null);
    expect(ids(asc)).toEqual(["tuid-b", "tuid-a", "tuid-c"]);
    const desc = shownTableRows(body, columns,
      view({ sort: { col: "Lab", dir: "desc" } }), null);
    expect(ids(desc)).toEqual(["tuid-c", "tuid-b", "tuid-a"]);
  });

  it("filters body rows and counts the matches", () => {
    const r = shownTableRows(body, columns, view({ filter: "ng" }), null);
    expect(ids(r)).toEqual(["tuid-b"]);
    expect(r.matching).toBe(1);
    expect(ids(shownTableRows(body, columns, view({ filter: "cache:4" }), null)))
      .toEqual(["tuid-a"]);
  });

  it("holds frozen rows in place and marks the ones that no longer match", () => {
    const r = shownTableRows(body, columns, view({ filter: "ng" }),
                             ["tuid-c", "tuid-a"]);
    expect(ids(r)).toEqual(["tuid-c", "tuid-a"]);
    expect(r.rows.map((s) => s.stale)).toEqual([true, true]);
    expect(r.matching).toBe(0);
  });
});

describe("tableSavedView", () => {
  it("reads only filter and sort from a table's options", () => {
    expect(tableSavedView({ view: "cards", columns: ["Lab"], filter: "x",
                            sort: { col: "Lab", dir: "asc" } }))
      .toEqual(view({ filter: "x", sort: { col: "Lab", dir: "asc" } }));
  });
});

describe("planTableSave", () => {
  const next = { filter: "apache", sort: { col: "Cache hit", dir: "asc" as const } };

  it("writes the view into the macro's options", () => {
    expect(planTableSave("{{table}}", next))
      .toEqual({ text: "{{table | filter: apache | sort: Cache hit asc}}" });
  });

  it("keeps the macro's spelling and the whitespace around it", () => {
    const plan = planTableSave("  {{[[TABLE]] | sort: Lab desc}} \n", next);
    expect(plan).toEqual(
      { text: "  {{[[TABLE]] | filter: apache | sort: Cache hit asc}} \n" });
    if ("text" in plan) {
      expect(tableMacroOptions(plan.text)).toEqual(next);
    }
  });

  it("removes every option when the view has none", () => {
    expect(planTableSave("{{table | filter: x}}", {})).toEqual({ text: "{{table}}" });
  });

  it("refuses a view the macro text cannot hold", () => {
    expect(planTableSave("{{table}}", { filter: "a | b" }))
      .toEqual({ refusal: "A saved view cannot contain '|': 'a | b'" });
  });

  it("refuses a block that is not a table macro", () => {
    expect(planTableSave("{{table}} and more", next)).toHaveProperty("refusal");
  });

  it("refuses a view that would not read back", () => {
    const dir = "up" as "asc";
    expect(planTableSave("{{table}}", { sort: { col: "Lab", dir } }))
      .toHaveProperty("refusal");
  });
});
