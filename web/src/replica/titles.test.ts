// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { BlockOp } from "../api/ops";
import { asRawTitle, canonicalizeTitle, findOpTitleViolation,
         titleSyntaxReason } from "./titles";
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

describe("canonicalizeTitle", () => {
  test.each([
    ["A\t B", false, "A B"],
    ["  A\n B  ", false, "A B"],
    ["A\t B", true, "A B"],
    ["  A\n B  ", true, "A B"],
  ] as const)("always normalizes control whitespace in %s", (text, active, want) => {
    expect(canonicalizeTitle(text, active)).toBe(want);
  });

  test("preserves boundary U+0020 before activation", () => {
    expect(canonicalizeTitle("  A  ", false)).toBe("  A  ");
  });

  test("strips only boundary U+0020 after activation", () => {
    expect(canonicalizeTitle("  A  ", true)).toBe("A");
    expect(canonicalizeTitle("A  B", true)).toBe("A  B");
    expect(canonicalizeTitle("\u00a0 A \u00a0", true)).toBe("\u00a0 A \u00a0");
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
