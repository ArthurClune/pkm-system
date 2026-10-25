// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { BlockOp } from "../api/ops";
import { TITLE_WHITESPACE } from "../grammar/titleWhitespace.gen";
import { asRawTitle, canonicalizeTitle, describeOpTitleViolation,
         findOpTitleViolation, titleSyntaxReason } from "./titles";
import type { CanonicalTitle, NormalizedTitle, RawTitle } from "../api/brands";
import type { components } from "../api/types";
import {
  canonicalTitleOf, fixtureText, normalizedTitleOf, orderIdxOf, rawTitleOf, typeProbe, uidOf,
} from "../test-helpers";

// The fixture's JSON, read row by row: `titleText` is the fixture's `title`,
// text for the parser under test.
interface TitleSyntaxCase {
  name: string;
  titleText: string;
  reason: "forbidden_syntax" | null;
}

const titleSyntaxCase = (row: unknown): TitleSyntaxCase => ({
  name: fixtureText(row, "name"),
  titleText: fixtureText(row, "title"),
  reason: (row as Pick<TitleSyntaxCase, "reason">).reason,
});

const titleSyntaxCases = JSON.parse(readFileSync(new URL(
  "../../../shared/fixtures/title_syntax.json", import.meta.url,
), "utf-8")) as { cases: unknown[] };

describe("titleSyntaxReason", () => {
  test.each(titleSyntaxCases.cases.map(titleSyntaxCase))("$name", (c) => {
    expect(titleSyntaxReason(c.titleText)).toBe(c.reason);
  });
});

describe("findOpTitleViolation", () => {
  // Judged edge-stripped, whatever the plain-space flag: the server's ops
  // check once passed these padded spellings and its store, under the
  // flag, then refused the stripped `Acme]` / `a]` with a 500.
  test("refuses a padded title whose stripped form is forbidden", () => {
    expect(findOpTitleViolation([
      { op: "create_page", page_title: rawTitleOf("Acme] ") },
    ])).toEqual({ opIndex: 0, source: "page_title",
                  title: rawTitleOf("Acme] "), reason: "forbidden_syntax" });
    expect(findOpTitleViolation([
      { op: "create", uid: uidOf("edge_ab01"), page_title: rawTitleOf("AI"),
        parent_uid: null, order_idx: orderIdxOf(900), text: "see [[a] ]]" },
    ])).toEqual({ opIndex: 0, source: "reference",
                  title: rawTitleOf("a] "), reason: "forbidden_syntax" });
  });

  // `[[a[]]` unlinked leaves `a[`, which joins a following `[a[]]` into a
  // fresh link, so the server's page delete re-forms one per pass.
  test("refuses a link or page title ending in an open bracket", () => {
    expect(findOpTitleViolation([
      { op: "create_page", page_title: rawTitleOf("Acme[ ") },
    ])).toEqual({ opIndex: 0, source: "page_title",
                  title: rawTitleOf("Acme[ "), reason: "forbidden_syntax" });
    expect(findOpTitleViolation([
      { op: "update_text", uid: uidOf("edge_ab02"),
        text: "see [[a[]][a[]]" },
    ])).toEqual({ opIndex: 0, source: "reference",
                  title: rawTitleOf("a["), reason: "forbidden_syntax" });
  });

  const rows: [string, BlockOp, "page_title" | "reference", RawTitle][] = [
    ["create_page", { op: "create_page", page_title: rawTitleOf("New #Old") },
      "page_title", rawTitleOf("New #Old")],
    ["create", { op: "create", uid: uidOf("syntax01"), page_title: rawTitleOf("New #Old"),
      parent_uid: null, order_idx: orderIdxOf(0), text: "plain" }, "page_title", rawTitleOf("New #Old")],
    ["move", { op: "move", uid: uidOf("uid_b4"), parent_uid: null, order_idx: orderIdxOf(0),
      page_title: rawTitleOf("New #Old") }, "page_title", rawTitleOf("New #Old")],
    ["create reference", { op: "create", uid: uidOf("syntax02"), page_title: rawTitleOf("AI"),
      parent_uid: null, order_idx: orderIdxOf(0),
      text: "[[Safe Ref]] then [[New #Old]]" }, "reference", rawTitleOf("New #Old")],
    ["update reference", { op: "update_text", uid: uidOf("uid_b4"),
      text: "[[Safe Ref]] then [[New #Old]]" }, "reference", rawTitleOf("New #Old")],
  ];
  test.each(rows)("checks the %s title source", (_name, op, source, title: RawTitle) => {
    expect(findOpTitleViolation([op])).toEqual({
      opIndex: 0, source, title, reason: "forbidden_syntax",
    });
  });

  test("returns the first violation in operation, explicit-field, reference order", () => {
    const ops: BlockOp[] = [
      { op: "create", uid: uidOf("syntax03"), page_title: rawTitleOf("Bad #Page"),
        parent_uid: null, order_idx: orderIdxOf(0), text: "[[Bad #Ref]]" },
      { op: "create_page", page_title: rawTitleOf("Later #Page") },
    ];

    expect(findOpTitleViolation(ops)).toEqual({
      opIndex: 0, source: "page_title", title: "Bad #Page",
      reason: "forbidden_syntax",
    });
  });

  test("returns the outer nested reference first", () => {
    expect(findOpTitleViolation([{
      op: "create", uid: uidOf("syntax04"), page_title: rawTitleOf("AI"), parent_uid: null,
      order_idx: orderIdxOf(0), text: "[[Outer [[New #Old]]]]",
    }])).toEqual({
      opIndex: 0, source: "reference", title: "Outer [[New #Old]]",
      reason: "forbidden_syntax",
    });
  });
});

const titleLength = JSON.parse(readFileSync(new URL(
  "../../../shared/fixtures/title_length.json", import.meta.url,
), "utf-8")) as {
  texts: { name: string; parts: [string, number][]; violation: number | null;
           op_describe?: string }[];
};

const partsText = (parts: readonly [string, number][]): string =>
  parts.map(([piece, times]) => piece.repeat(times)).join("");

describe("findOpTitleViolation and the title length cap", () => {
  test.each(titleLength.texts)("refuses the linked title of $name as the "
    + "fixture says", (c) => {
    const violation = findOpTitleViolation([
      { op: "create", uid: uidOf("fixture_001"),
        page_title: rawTitleOf("Fixture"), parent_uid: null,
        order_idx: orderIdxOf(0), text: partsText(c.parts) },
    ]);
    if (c.violation === null) {
      expect(violation).toBeNull();
      return;
    }
    expect(violation?.reason).toBe("too_long");
    expect(violation && describeOpTitleViolation(violation))
      .toBe(c.op_describe);
  });

  test("refuses a page title over the cap for length before syntax", () => {
    const violation = findOpTitleViolation([
      { op: "create_page", page_title: rawTitleOf(`#${"t".repeat(1001)}`) },
    ]);
    expect(violation?.reason).toBe("too_long");
    expect(violation && describeOpTitleViolation(violation)).toBe(
      "page_title title of 1002 characters is over the limit of 1000");
  });

  test("never judges an update_text page_title hint", () => {
    expect(findOpTitleViolation([
      { op: "update_text", uid: uidOf("uid_b4"), text: "edited",
        page_title: rawTitleOf("t".repeat(1001)) },
    ])).toBeNull();
  });

  test("words a syntax refusal as before", () => {
    const violation = findOpTitleViolation([
      { op: "create_page", page_title: rawTitleOf("New #Old") },
    ]);
    expect(violation && describeOpTitleViolation(violation)).toBe(
      'unsupported page_title title syntax: "New #Old"');
  });
});

describe("canonicalizeTitle", () => {
  test.each([
    ["A\t B", false, "A B"],
    ["  A\n B  ", false, "A B"],
    ["A\t B", true, "A B"],
    ["  A\n B  ", true, "A B"],
  ] as const)("always normalizes control whitespace in %s", (text, active, want) => {
    expect(canonicalizeTitle(text, active)).toBe(want);
  });

  test("preserves single boundary U+0020 before activation", () => {
    expect(canonicalizeTitle(" A ", false)).toBe(" A ");
  });

  test("strips boundary U+0020 after activation", () => {
    expect(canonicalizeTitle(" A ", true)).toBe("A");
    expect(canonicalizeTitle("  A  ", true)).toBe("A");
  });

  // Mirrors server tests/test_title_whitespace_fold.py's fold table.
  test.each([
    ["A  B", "A B", "A B"],
    ["A\u00a0B", "A B", "A B"],
    [" A ", " A ", "A"],
    ["  A", "A", "A"],
    ["\tA\u3000", "A", "A"],
    ["Foo\n", "Foo", "Foo"],
    ["A B", "A B", "A B"],
    ["\u00a0 A \u00a0", "A", "A"],
    ["", "", ""],
  ] as const)("folds the whitespace runs of %j", (text, inactive, active) => {
    expect(canonicalizeTitle(text, false)).toBe(inactive);
    expect(canonicalizeTitle(text, true)).toBe(active);
    expect(canonicalizeTitle(inactive, false)).toBe(inactive);
    expect(canonicalizeTitle(active, true)).toBe(active);
  });

  test.each(["A\u200bB", "A\ufeffB", "A\x1cB", "A\u180eB"])(
    "leaves the look-alike %j outside the list byte for byte", (text) => {
      expect(canonicalizeTitle(text, false)).toBe(text);
      expect(canonicalizeTitle(text, true)).toBe(text);
    });

  test("the list is JS whitespace less U+FEFF plus U+0085", () => {
    const expected = new Set<string>(["\x85"]);
    for (let c = 0; c <= 0xffff; c += 1) {
      const ch = String.fromCharCode(c);
      if (/\s/.test(ch) && ch !== "\ufeff") expected.add(ch);
    }
    expect(new Set(TITLE_WHITESPACE)).toEqual(expected);
  });
});

// A CanonicalTitle passes where a NormalizedTitle is expected, not the
// reverse.
typeProbe(() => {
  const canonical: CanonicalTitle = canonicalTitleOf("Page");
  const normalized: NormalizedTitle = canonical;
  // @ts-expect-error a NormalizedTitle is not a CanonicalTitle
  const back: CanonicalTitle = normalizedTitleOf("Page");
  void [normalized, back];
});

// A generated response title is the CanonicalTitle brand.
typeProbe(() => {
  type PageMetaTitle = components["schemas"]["PageMeta"]["title"];
  const fromWire: PageMetaTitle = canonicalTitleOf("Page");
  const normalized: NormalizedTitle = fromWire;
  // @ts-expect-error a NormalizedTitle is not a generated CanonicalTitle
  // field
  const back: PageMetaTitle = normalizedTitleOf("Page");
  // @ts-expect-error a raw string is not a generated CanonicalTitle field
  const raw: PageMetaTitle = "Page";
  void [normalized, back, raw];
});

describe("asRawTitle", () => {
  test("returns the text unchanged", () => {
    expect(asRawTitle(" a\tb ")).toBe(" a\tb ");
  });
});

describe("canonicalizeTitle on a long title", () => {
  // A regex that trims a run of spaces from the end retries from every
  // space of an inner run: 0.5 s at 40,000 spaces, minutes at the cap.
  // The inner run folds to one space.
  test("trims a 1,000,000-character title in linear time", () => {
    const inner = " ".repeat(999_990);
    const started = performance.now();
    expect(canonicalizeTitle(`  a${inner}a  `, true)).toBe("a a");
    expect(performance.now() - started).toBeLessThan(3000);
  }, 300_000);
});
