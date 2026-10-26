import { describe, expect, it } from "vitest";
import {
  MAX_PAGE_TITLE_CHARS, TITLE_LENGTH_NOTICE, describeTitleLength,
  linkedTitleLengthOver, titleLengthOver,
} from "./titleLength";

// Imported, not read with node:fs, as depthCap.test.ts does. Hand-edited;
// server/tests/test_title_length_fixture.py replays it on the server.
import fixture from "../../../shared/fixtures/title_length.json";

/** A case's text, rebuilt from its `[piece, times]` parts. */
function textOf(parts: readonly (readonly (string | number)[])[]): string {
  return parts.map(([piece, times]) => String(piece).repeat(Number(times)))
    .join("");
}

describe("the title length cap agrees with the server's", () => {
  it("the cap is the server's", () => {
    expect(MAX_PAGE_TITLE_CHARS).toBe(fixture.max_page_title_chars);
    expect(TITLE_LENGTH_NOTICE).toBe(
      "A page title can't be longer than 1,000 characters.");
  });

  it.each(fixture.titles.map((c) => [c.name, c] as const))(
    "title %s", (_, c) => {
      const measured = titleLengthOver(textOf(c.parts));
      expect(measured).toBe(c.violation);
      if (measured !== null) {
        expect(describeTitleLength(measured)).toBe(c.describe);
      }
    });

  it.each(fixture.texts.map((c) => [c.name, c] as const))(
    "text %s", (_, c) => {
      expect(linkedTitleLengthOver(textOf(c.parts))).toBe(c.violation);
    });
});
