// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { extractRefs } from "./refs";

interface FixtureCase {
  text: string;
  refs: { title: string; kind: string }[];
  block_refs: string[];
}

const fixture = JSON.parse(readFileSync(
  join(__dirname, "../../../shared/fixtures/refs_parity.json"), "utf-8"),
) as { cases: FixtureCase[] };

describe("extractRefs parity with refs.py", () => {
  for (const c of fixture.cases) {
    test(JSON.stringify(c.text.slice(0, 60)), () => {
      const got = extractRefs(c.text);
      expect(got.refs).toEqual(c.refs);
      expect(got.blockRefs).toEqual(c.block_refs);
    });
  }
});
