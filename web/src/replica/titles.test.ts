// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { BlockOp } from "../api/ops";
import { canonicalizeTitle, findOpTitleViolation, opPageTitles,
         titleSyntaxReason } from "./titles";
import type { CanonicalTitle, NormalizedTitle } from "../api/brands";
import type { components } from "../api/types";
import { normTitle, ord, title, uid } from "../test-helpers";

interface TitleSyntaxCase {
  name: string;
  title: string;
  reason: "forbidden_syntax" | null;
}

const titleSyntaxCases = JSON.parse(readFileSync(new URL(
  "../../../shared/fixtures/title_syntax.json", import.meta.url,
), "utf-8")) as { cases: TitleSyntaxCase[] };

describe("titleSyntaxReason", () => {
  test.each(titleSyntaxCases.cases)("$name", ({ title, reason }) => {
    expect(titleSyntaxReason(title)).toBe(reason);
  });
});

describe("findOpTitleViolation", () => {
  test.each([
    ["create_page", { op: "create_page", page_title: "New #Old" },
      "page_title", "New #Old"],
    ["create", { op: "create", uid: "syntax01", page_title: "New #Old",
      parent_uid: null, order_idx: 0, text: "plain" }, "page_title", "New #Old"],
    ["move", { op: "move", uid: "uid_b4", parent_uid: null, order_idx: 0,
      page_title: "New #Old" }, "page_title", "New #Old"],
    ["create reference", { op: "create", uid: "syntax02", page_title: "AI",
      parent_uid: null, order_idx: 0,
      text: "[[Safe Ref]] then [[New #Old]]" }, "reference", "New #Old"],
    ["update reference", { op: "update_text", uid: "uid_b4",
      text: "[[Safe Ref]] then [[New #Old]]" }, "reference", "New #Old"],
  ] as const)("checks the %s title source", (_name, op, source, title) => {
    expect(findOpTitleViolation([op as BlockOp])).toEqual({
      opIndex: 0, source, title, reason: "forbidden_syntax",
    });
  });

  test("returns the first violation in operation, explicit-field, reference order", () => {
    const ops: BlockOp[] = [
      { op: "create", uid: uid("syntax03"), page_title: "Bad #Page",
        parent_uid: null, order_idx: ord(0), text: "[[Bad #Ref]]" },
      { op: "create_page", page_title: "Later #Page" },
    ];

    expect(findOpTitleViolation(ops)).toEqual({
      opIndex: 0, source: "page_title", title: "Bad #Page",
      reason: "forbidden_syntax",
    });
  });

  test("returns the outer nested reference first", () => {
    expect(findOpTitleViolation([{
      op: "create", uid: uid("syntax04"), page_title: "AI", parent_uid: null,
      order_idx: ord(0), text: "[[Outer [[New #Old]]]]",
    }])).toEqual({
      opIndex: 0, source: "reference", title: "Outer [[New #Old]]",
      reason: "forbidden_syntax",
    });
  });
});

describe("opPageTitles", () => {
  test("names each op's page and each title its text links, raw", () => {
    expect(opPageTitles([
      { op: "create", uid: uid("uid_a"), page_title: " Made ", parent_uid: null,
        order_idx: ord(0), text: "[[Linked]] #tag" },
      { op: "move", uid: uid("uid_a"), parent_uid: null, order_idx: ord(0),
        page_title: "Moved" },
      { op: "move", uid: uid("uid_a"), parent_uid: uid("uid_b"),
        order_idx: ord(0) },
      { op: "create_page", page_title: "Empty" },
      { op: "update_text", uid: uid("uid_a"), text: "see [[Later]]",
        page_title: "Not made by an update" },
      { op: "delete", uid: uid("uid_a") },
    ])).toEqual([" Made ", "Linked", "tag", "Moved", "Empty", "Later"]);
  });
});

describe("canonicalizeTitle", () => {
  test.each([
    ["A\t B", false, "A B"],
    ["  A\n B  ", false, "A B"],
    ["A\t B", true, "A B"],
    ["  A\n B  ", true, "A B"],
  ] as const)("always normalizes control whitespace in %s", (title, active, want) => {
    expect(canonicalizeTitle(title, active)).toBe(want);
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

describe("title brands", () => {
  test("a CanonicalTitle passes where a NormalizedTitle is expected, not the reverse", () => {
    const canonical: CanonicalTitle = title("Page");
    const normalized: NormalizedTitle = canonical;
    // @ts-expect-error a NormalizedTitle is not a CanonicalTitle
    const back: CanonicalTitle = normTitle("Page");
    expect([normalized, back]).toEqual(["Page", "Page"]);
  });

  test("a generated response title is the CanonicalTitle brand", () => {
    type PageMetaTitle = components["schemas"]["PageMeta"]["title"];
    const fromWire: PageMetaTitle = title("Page");
    const normalized: NormalizedTitle = fromWire;
    // @ts-expect-error a NormalizedTitle is not a generated CanonicalTitle field
    const back: PageMetaTitle = normTitle("Page");
    // @ts-expect-error a raw string is not a generated CanonicalTitle field
    const raw: PageMetaTitle = "Page";
    expect([normalized, back, raw]).toEqual(["Page", "Page", "Page"]);
  });
});
