import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { linkNestingDepth, scanGrammar } from "./scan";
import { MAX_LINK_NESTING, textLimitViolation } from "./textLimits";

// The server property's alphabet (test_text_limits.py _TOKENS): brackets,
// code, tags, and what follows a fence closer, non-ASCII included.
const TOKENS = ["[[", "]]", "[", "]", "`", "```", "\n", "#", "a", "a//", " ",
                "```\u{1d400}", "```Ɤ", "```é", "\u{1f600}", "\ud800"];

/** Token soup with `[[` weighted, sometimes inside a chain of runs, so
 * texts past the limit are drawn by construction, not by chance. */
const texts = fc.record({
  soup: fc.array(fc.oneof(fc.constant("[["), fc.constantFrom(...TOKENS)),
                 { maxLength: 120 }),
  wrap: fc.integer({ min: 0, max: 40 }),
  opener: fc.constantFrom("[[", "#[[", "[[a//"),
}).map(({ soup, wrap, opener }) =>
  opener.repeat(wrap) + soup.join("") + "]]".repeat(wrap));

/** The depth the scanner's page-ref tokens report, outermost being 0. */
function tokenDepth(text: string): number {
  let deepest = 0;
  for (const t of scanGrammar(text).tokens) {
    if (t.kind === "page-ref") deepest = Math.max(deepest, t.depth + 1);
  }
  return deepest;
}

describe("linkNestingDepth", () => {
  it("is the depth of the scanner's page-ref tree", () => {
    let deep = 0;
    fc.assert(fc.property(texts, (text) => {
      const depth = linkNestingDepth(text);
      expect(depth).toBe(tokenDepth(text));
      if (depth > MAX_LINK_NESTING) deep += 1;
    }), { numRuns: 500 });
    // The past-the-limit case must actually be drawn.
    expect(deep).toBeGreaterThan(25);
  });

  it("is over the limit exactly when the judge refuses for nesting", () => {
    const seen = { refused: 0, fastPathMissed: 0 };
    fc.assert(fc.property(texts, (text) => {
      const over = linkNestingDepth(text) > MAX_LINK_NESTING;
      const refused = textLimitViolation(text)?.kind === "nesting";
      expect(refused).toBe(over);
      if (refused) seen.refused += 1;
      // past the fast path's count, yet within the limit
      if (!over && text.split("[[").length - 1 > MAX_LINK_NESTING) {
        seen.fastPathMissed += 1;
      }
    }), { numRuns: 500 });
    expect(seen.refused).toBeGreaterThan(25);
    expect(seen.fastPathMissed).toBeGreaterThan(25);
  });
});
