import { describe, expect, it } from "vitest";
import {
  formatMacroOptions, normaliseMacroOptions, optionsRefusal,
  rewriteMacroOptions, splitMacroOptions, tableMacroOptions,
  type MacroOptions,
} from "./macroOptions";

// The server writes it (pkm.macro_options_parity_dump) from
// pkm.macro_options, which this module mirrors.
import fixture from "../../../shared/fixtures/macro_options_parity.json";

interface FixtureOptions {
  view: string | null;
  filter: string | null;
  sort: string[] | null;
  columns: string[] | null;
}

function fromFixture(o: FixtureOptions): MacroOptions {
  const out: MacroOptions = {};
  if (o.view !== null) out.view = o.view as MacroOptions["view"];
  if (o.filter !== null) out.filter = o.filter;
  if (o.sort !== null) {
    out.sort = { col: o.sort[0], dir: o.sort[1] as "asc" | "desc" };
  }
  if (o.columns !== null) out.columns = o.columns;
  return out;
}

describe("macro options agree with the server's", () => {
  it.each(fixture.cases.map((c) => [JSON.stringify(c.body), c] as const))(
    "splits %s", (_, c) => {
      const { head, options } = splitMacroOptions(c.body);
      expect(head).toBe(c.head);
      expect(options).toStrictEqual(fromFixture(c.options));
      expect(formatMacroOptions(options)).toBe(c.formatted);
    });

  it.each(fixture.format_cases.map((c) => [c.formatted, c] as const))(
    "formats to %j", (_, c) => {
      expect(formatMacroOptions(fromFixture(c.options))).toBe(c.formatted);
    });
});

describe("splitMacroOptions", () => {
  it("strips the whitespace Python strips, and only that", () => {
    expect(splitMacroOptions("x | view:\x1ccards\x85 | filter: \ufeffa"))
      .toStrictEqual({ head: "x", options: { view: "cards", filter: "\ufeffa" } });
  });
});

describe("normaliseMacroOptions", () => {
  it("trims and drops what is left empty", () => {
    expect(normaliseMacroOptions({
      filter: "  ", sort: { col: " ", dir: "asc" }, columns: [" ", ""],
    })).toStrictEqual({});
    expect(normaliseMacroOptions({
      view: "table", filter: " f ", sort: { col: " S ", dir: "desc" },
      columns: [" a", "", "b "],
    })).toStrictEqual({
      view: "table", filter: "f", sort: { col: "S", dir: "desc" },
      columns: ["a", "b"],
    });
  });
});

describe("optionsRefusal", () => {
  it.each([
    ["[[x]]", "[["], ["#x", "#"], ["a|b", "|"], ["a}", "}"], ["a{", "{"],
  ])("refuses %j in a filter, naming %j", (bad, char) => {
    const msg = optionsRefusal({ filter: bad });
    expect(msg).toBe(`A saved view cannot contain '${char}': '${bad}'`);
  });

  it("covers the sort column and column names", () => {
    expect(optionsRefusal({ sort: { col: "#x", dir: "asc" } }))
      .toContain("'#'");
    expect(optionsRefusal({ columns: ["ok", "[[x"] })).toContain("'[['");
    expect(optionsRefusal({ columns: ["a,b"] }))
      .toBe("A column name cannot contain ',': 'a,b'");
  });

  it("refuses a stray ']]'", () => {
    expect(optionsRefusal({ filter: "a]]" })).toContain("']]'");
  });

  it("quotes the value as Python's repr does", () => {
    expect(optionsRefusal({ filter: "it's #" }))
      .toBe(`A saved view cannot contain '#': "it's #"`);
    expect(optionsRefusal({ filter: "a\x07\u200b\\ #" }))
      .toBe("A saved view cannot contain '#': 'a\\x07\\u200b\\\\ #'");
  });

  it("passes clean options", () => {
    expect(optionsRefusal({
      view: "table", filter: "-status:read", sort: { col: "A B", dir: "desc" },
      columns: ["A", "B"],
    })).toBeNull();
    expect(optionsRefusal({})).toBeNull();
  });
});

describe("rewriteMacroOptions", () => {
  it("keeps the prefix spelling and replaces the options", () => {
    const text = "{{[[query]]: {and: [[A]]}}}";
    expect(rewriteMacroOptions(text, [0, text.length], { view: "cards" }))
      .toBe("{{[[query]]: {and: [[A]]} | view: cards}}");
  });

  it("replaces existing options and leaves the text around the span", () => {
    const macro = "{{query: {and: [[A]]} | view: table | sort: X asc}}";
    const text = `before ${macro} after`;
    const span: [number, number] = [7, 7 + macro.length];
    expect(rewriteMacroOptions(text, span, { sort: { col: "Y", dir: "desc" } }))
      .toBe("before {{query: {and: [[A]]} | sort: Y desc}} after");
  });

  it("removes every option when given none", () => {
    const text = "{{table | sort: Lab desc}}";
    expect(rewriteMacroOptions(text, [0, text.length], {}))
      .toBe("{{table}}");
  });

  it("rewrites a table macro", () => {
    const text = "{{[[table]]}}";
    expect(rewriteMacroOptions(text, [0, text.length],
                               { filter: "apache" }))
      .toBe("{{[[table]] | filter: apache}}");
  });
});

describe("tableMacroOptions", () => {
  it("reads both spellings, any case, with or without options", () => {
    expect(tableMacroOptions("{{table}}")).toStrictEqual({});
    expect(tableMacroOptions("  {{[[TaBlE]]}}\n")).toStrictEqual({});
    expect(tableMacroOptions("{{table | sort: Lab desc}}"))
      .toStrictEqual({ sort: { col: "Lab", dir: "desc" } });
    expect(tableMacroOptions("{{[[table]] | filter: x}}"))
      .toStrictEqual({ filter: "x" });
  });

  it("reads options whose braces balance inside the macro", () => {
    expect(tableMacroOptions("{{table | filter: {x}}}"))
      .toStrictEqual({ filter: "{x}" });
  });

  it("rejects anything else", () => {
    for (const t of ["{{tables}}", "{{table}} x", "x {{table}}", "{{[[table]]",
                     "{{table|sort: A asc}}", "{{table [[a | b]]}}",
                     "{{ table}}", "table", "{{query: {and: [[A]]}}}",
                     "{{table | view: cards}} notes {{toc}}",
                     "{{table | a}} {{query: {and: [[B]]}}}",
                     "{{table | a}} x {{y}}", "{{table | filter: a}} b}}"]) {
      expect(tableMacroOptions(t)).toBeNull();
    }
  });
});
