import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_PAGE_TITLE_CHARS, TITLE_LENGTH_NOTICE, describeTitleLength,
  titleLengthOver,
} from "./titleLength";

interface TitleLengthCase {
  name: string;
  parts: [string, number][];
  violation: number | null;
  describe: string | null;
}

// Hand-edited; server/tests/test_title_length_fixture.py replays it on the
// server. Read with JSON.parse, not imported: vite's native JSON loader
// rejects the lone surrogate escapes the fixture holds on purpose.
const fixture = JSON.parse(readFileSync(
  join(__dirname, "../../../shared/fixtures/title_length.json"), "utf-8",
)) as {
  max_page_title_chars: number;
  titles: TitleLengthCase[];
  texts: TitleLengthCase[];
};

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

  // A JSON loader that replaced a lone surrogate with U+FFFD would leave
  // these cases passing while no longer testing a lone surrogate.
  it("the lone surrogate cases load unreplaced", () => {
    const cases = [...fixture.titles, ...fixture.texts]
      .filter((c) => c.name.includes("lone_surrogate"));
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(textOf(c.parts)).toMatch(/[\ud800-\udfff]/);
    }
  });
});
