import { describe, expect, it } from "vitest";
import { linkNestingDepth } from "./scan";
import {
  MAX_BLOCK_TEXT_CHARS, MAX_LINK_NESTING, codePointLength, describeTextLimit,
  textLimitViolation,
} from "./textLimits";

// Imported, not read with node:fs, as depthCap.test.ts does. The server
// writes it (pkm.text_limits_parity_dump) from its own measure and judge.
import fixture from "../../../shared/fixtures/text_limits_parity.json";

/** A case's text, rebuilt from its `[piece, times]` parts: the fixture
 * stores a million-character text as one short pair. */
function textOf(parts: readonly (readonly (string | number)[])[]): string {
  return parts.map(([piece, times]) => String(piece).repeat(Number(times)))
    .join("");
}

describe("text limits agree with the server's", () => {
  it("the limits are the server's", () => {
    expect(MAX_BLOCK_TEXT_CHARS).toBe(fixture.max_block_text_chars);
    expect(MAX_LINK_NESTING).toBe(fixture.max_link_nesting);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const text = textOf(c.parts);
    expect(codePointLength(text)).toBe(c.code_points);
    expect(codePointLength(text)).toBe([...text].length);
    expect(linkNestingDepth(text)).toBe(c.nesting_depth);
    const violation = textLimitViolation(text);
    if (c.violation === null) {
      expect(violation).toBeNull();
    } else {
      const { describe: wording, ...expected } = c.violation;
      expect(violation).toEqual(expected);
      expect(describeTextLimit(violation!)).toBe(wording);
    }
  });

  it("the generated corpus measures the same depth", () => {
    for (const { text, nesting_depth } of fixture.generated) {
      expect(linkNestingDepth(text), JSON.stringify(text)).toBe(nesting_depth);
    }
  });
});
