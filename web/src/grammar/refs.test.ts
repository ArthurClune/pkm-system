// @vitest-environment node
// The default jsdom environment provides a `self.location`, which makes
// Vite's `new URL(literal, import.meta.url)` static-asset rewrite resolve
// against http://localhost instead of the real file:// URL. Force node here
// so the fixture (outside the Vite root) can be read with plain fs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixtureRefs } from "../test-helpers";
import { extractRefs } from "./refs";

interface FixtureCase {
  name: string;
  text: string;
  refs: unknown[];
  block_refs: string[];
  embeds: number;
}

const fixture = JSON.parse(readFileSync(
  new URL("../../../shared/fixtures/ref_grammar.json", import.meta.url),
  "utf-8",
)) as { cases: FixtureCase[] };

describe("ref grammar fixture (pinned against the Python parser)", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const got = extractRefs(c.text);
      expect(got.refs).toEqual(fixtureRefs(c.refs));           // order-sensitive on purpose
      expect(got.block_refs).toEqual(c.block_refs);
      expect(got.embeds).toEqual(c.embeds);
    });
  }
});

// One ref or code span per few characters, up to the block length cap: the
// extractor runs on every block the replica applies, so a throw here would
// stall sync on a block every write path accepts. The legacy nest's titles
// all hold an empty `/` segment, so none of them names a page.
describe("extractRefs at the block length cap", () => {
  it.each([
    ["#a ×333,333", "#a ".repeat(333_333), 1],
    ["[[x]] ×166,666", "[[x]] ".repeat(166_666), 1],
    ["`x` ×333,333", "`x`".repeat(333_333), 0],
    ["a legacy nest of 1,000,000 characters",
     "[[a//".repeat(142_857) + "]]".repeat(142_857), 0],
  ])("extracts from %s without throwing", (_name, text, refs) => {
    expect(extractRefs(text).refs).toHaveLength(refs);
  }, 60_000);
});
