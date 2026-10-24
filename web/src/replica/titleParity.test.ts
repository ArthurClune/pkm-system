// @vitest-environment node
// Replays shared/fixtures/title_parity.json, the server's verdicts on a
// seeded corpus of whitespace- and syntax-heavy titles
// (server/src/pkm/title_parity_dump.py): the replica must reach the same
// identity, syntax reason and blankness for every title, and read the same
// refs back from it written as a link and as an attribute.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { fixtureRefs, fixtureText } from "../test-helpers";
import { extractRefs } from "./refs";
import { canonicalizeTitle, isBlankTitle, titleSyntaxReason } from "./titles";

interface TitleParityCase {
  titleText: string;
  normalized: string;
  canonical: string;
  reason: "forbidden_syntax" | null;
  blank: boolean;
  linkRefs: unknown[];
  attributeRefs: unknown[];
}

const parityCase = (row: unknown): TitleParityCase => {
  const r = row as Record<string, unknown>;
  return {
    titleText: fixtureText(row, "title"),
    normalized: fixtureText(row, "normalized"),
    canonical: fixtureText(row, "canonical"),
    reason: r.reason as TitleParityCase["reason"],
    blank: r.blank as boolean,
    linkRefs: r.link_refs as unknown[],
    attributeRefs: r.attribute_refs as unknown[],
  };
};

const cases = (JSON.parse(readFileSync(new URL(
  "../../../shared/fixtures/title_parity.json", import.meta.url,
), "utf-8")) as { cases: unknown[] }).cases.map(parityCase);

describe("title verdicts agree with the server's", () => {
  test("the corpus is the generated one, not an empty file", () => {
    expect(cases.length).toBeGreaterThanOrEqual(600);
    // Each verdict is drawn both ways, so no column can pass vacuously.
    expect(cases.filter((c) => c.reason !== null).length).toBeGreaterThan(50);
    expect(cases.filter((c) => c.blank).length).toBeGreaterThan(20);
    expect(cases.filter((c) => c.normalized !== c.titleText).length)
      .toBeGreaterThan(100);
    // Only a title whose sole whitespace is one edge space differs here:
    // the fold strips the edges of any title it changes.
    expect(cases.filter((c) => c.canonical !== c.normalized).length)
      .toBeGreaterThan(20);
  });

  test.each(cases.map((c) => [JSON.stringify(c.titleText), c] as const))(
    "%s", (_name, c) => {
      expect(canonicalizeTitle(c.titleText, false)).toBe(c.normalized);
      expect(canonicalizeTitle(c.titleText, true)).toBe(c.canonical);
      expect(titleSyntaxReason(c.titleText)).toBe(c.reason);
      expect(isBlankTitle(c.titleText)).toBe(c.blank);
      expect(extractRefs(`[[${c.titleText}]]`).refs).toEqual(fixtureRefs(c.linkRefs));
      expect(extractRefs(`${c.titleText}:: v`).refs)
        .toEqual(fixtureRefs(c.attributeRefs));
    });
});
