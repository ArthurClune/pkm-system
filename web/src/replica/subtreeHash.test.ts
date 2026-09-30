import { expect, test } from "vitest";
import { subtreeHash } from "./subtreeHash";

// Imported, not read with node:fs: this test needs the jsdom environment,
// where import.meta.url is not a file: URL.
import fixture from "../../../shared/fixtures/subtree_hash.json";

for (const c of fixture.cases) {
  test(`subtreeHash matches fixture: ${c.name}`, () => {
    const pairs = c.pairs.map(([uid, text]) => [uid, text] as const);
    expect(subtreeHash(pairs)).toBe(c.hash);
  });
}

test("subtreeHash ignores input order", () => {
  const pairs: [string, string][] = [["b", "two"], ["a", "one"]];
  expect(subtreeHash(pairs)).toBe(subtreeHash([...pairs].reverse()));
});
