// @vitest-environment node
// The default jsdom environment provides a `self.location`, which makes
// Vite's `new URL(literal, import.meta.url)` static-asset rewrite resolve
// against http://localhost instead of the real file:// URL. Force node here
// so the fixture (outside the Vite root) can be read with plain fs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractRefs } from "./refs";

interface FixtureCase {
  name: string;
  text: string;
  refs: { title: string; kind: string }[];
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
      expect(got.refs).toEqual(c.refs);           // order-sensitive on purpose
      expect(got.block_refs).toEqual(c.block_refs);
      expect(got.embeds).toEqual(c.embeds);
    });
  }
});
