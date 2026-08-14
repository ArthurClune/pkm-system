import { describe, expect, test } from "vitest";
import { stripCaretBlockRefs } from "./normalizeRefs";

// pkm-wx86: MCP tool output shows blocks with trailing ^uid markers; GLM
// copies the caret verbatim into citations, emitting ((^uid)) which the
// shared ref grammar rejects. The assistant render path strips the caret
// so the citation tokenizes as a block ref; the grammar itself is untouched.
describe("stripCaretBlockRefs", () => {
  test("rewrites ((^uid)) to ((uid))", () => {
    expect(stripCaretBlockRefs("see ((^dfflHRRvB)) for details")).toBe(
      "see ((dfflHRRvB)) for details",
    );
  });

  test("leaves a well-formed ((uid)) alone", () => {
    expect(stripCaretBlockRefs("see ((dfflHRRvB))")).toBe("see ((dfflHRRvB))");
  });

  test("rewrites every occurrence", () => {
    expect(stripCaretBlockRefs("((^0b2foJUip)) and ((^5Gmg5wcyy))")).toBe(
      "((0b2foJUip)) and ((5Gmg5wcyy))",
    );
  });

  test("leaves a bare ^uid marker outside parens alone", () => {
    expect(stripCaretBlockRefs("some block text  ^dfflHRRvB")).toBe(
      "some block text  ^dfflHRRvB",
    );
  });

  test("leaves ((^short)) alone when the uid is under the grammar minimum", () => {
    // the grammar requires 6+ uid chars; a shorter body was never a valid
    // ref, so don't rewrite text that would still not tokenize
    expect(stripCaretBlockRefs("((^abc))")).toBe("((^abc))");
  });

  test("leaves ((^uid with spaces)) alone", () => {
    expect(stripCaretBlockRefs("((^not a uid))")).toBe("((^not a uid))");
  });
});
