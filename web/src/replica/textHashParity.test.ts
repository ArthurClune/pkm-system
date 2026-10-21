// The web half of the text-hash parity fixture: odd texts (lone high and low
// surrogates, astral emoji and ZWJ sequences, NFC and NFD spellings, NUL,
// CRLF) with the sha256Hex the browser computes for each, its well-formed
// form, and subtreeHash over sets of them.
// server/tests/test_text_hash_parity.py holds text_hash, well_formed and
// subtree_hash to the same values, which is what keeps a guarded edit or
// delete from reading as a conflict on odd text.
// Regenerate after a deliberate change with UPDATE_TEXT_HASH_FIXTURE=1; the
// sample is deterministic (fixed seed), so any diff means the generator or
// the product code moved.
//
// JSON.stringify writes a lone surrogate as a `\udXXX` escape, so the file
// stays valid UTF-8 and both loaders turn the escape back into the lone
// code unit; the tallies below check that they do.
import fc from "fast-check";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { wellFormed } from "./wellFormed";
import { sha256Hex } from "./sha256";
import { subtreeHash } from "./subtreeHash";

const FIXTURE = join(__dirname, "../../../shared/fixtures/text_hash_parity.json");

const unit = (min: number, max: number) =>
  fc.integer({ min, max }).map((u) => String.fromCharCode(u));

const pieceArb = fc.oneof(
  unit(0xd800, 0xdbff),
  unit(0xdc00, 0xdfff),
  fc.constantFrom("\u{1F600}", "\u{1F389}", "\u{1D11E}"),
  fc.constantFrom("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
                  "\u{1F3F3}\uFE0F\u200D\u{1F308}"),
  fc.constantFrom("\u00E9", "e\u0301", "\u1100\u1161", "\u00C5", "A\u030A"),
  fc.constantFrom("\u0000", "\r\n", "\n", "\r"),
  fc.string({ maxLength: 4 }),
);

const textArb = fc.array(pieceArb, { minLength: 1, maxLength: 6 }).map((p) => p.join(""));

const uidArb = fc.stringMatching(/^[A-Za-z0-9_-]{6,10}$/);

const pairsArb = fc.uniqueArray(fc.tuple(uidArb, textArb), {
  minLength: 1, maxLength: 4, selector: ([uid]) => uid,
});

type Shape =
  | "lone high" | "lone low" | "astral" | "zwj" | "nfd" | "nul" | "crlf";

const SHAPES: readonly Shape[] = [
  "lone high", "lone low", "astral", "zwj", "nfd", "nul", "crlf",
];

/** Which shapes `text` holds, read off its UTF-16 code units. */
function shapesOf(text: string): Set<Shape> {
  const found = new Set<Shape>();
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)) found.add("lone high");
  if (/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) found.add("lone low");
  if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text)) found.add("astral");
  if (text.includes("\u200D")) found.add("zwj");
  if (wellFormed(text).normalize("NFC") !== wellFormed(text)) found.add("nfd");
  if (text.includes("\u0000")) found.add("nul");
  if (text.includes("\r\n")) found.add("crlf");
  return found;
}

interface Fixture {
  cases: { text: string; well_formed: string; hash: string }[];
  subtree_cases: { pairs: [string, string][]; hash: string }[];
}

function generate(): string {
  const cases = fc
    .sample(textArb, { seed: 20261021, numRuns: 160 })
    .map((text) => ({ text, well_formed: wellFormed(text), hash: sha256Hex(text) }));
  const subtreeCases = fc
    .sample(pairsArb, { seed: 20261022, numRuns: 40 })
    .map((pairs) => ({ pairs, hash: subtreeHash(pairs) }));
  return `${JSON.stringify({ cases, subtree_cases: subtreeCases }, null, 2)}\n`;
}

function tally(texts: readonly string[]): Record<Shape, number> {
  const counts = Object.fromEntries(SHAPES.map((s) => [s, 0])) as Record<Shape, number>;
  for (const text of texts) for (const s of shapesOf(text)) counts[s] += 1;
  return counts;
}

test("shared/fixtures/text_hash_parity.json is current", () => {
  const expected = generate();
  if (process.env.UPDATE_TEXT_HASH_FIXTURE === "1") writeFileSync(FIXTURE, expected);
  expect(
    readFileSync(FIXTURE, "utf8") === expected,
    "stale fixture: run with UPDATE_TEXT_HASH_FIXTURE=1 to rewrite it",
  ).toBe(true);
});

test("the fixture as loaded holds every shape, lone surrogates included", () => {
  const loaded = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
  const counts = tally(loaded.cases.map((c) => c.text));
  for (const shape of SHAPES) expect(counts[shape], shape).toBeGreaterThanOrEqual(8);
  const subtreeCounts = tally(loaded.subtree_cases.flatMap((c) => c.pairs.map(([, t]) => t)));
  expect(subtreeCounts["lone high"] + subtreeCounts["lone low"]).toBeGreaterThanOrEqual(8);
});

test("a lone surrogate hashes as its well-formed form, which differs from the raw text", () => {
  const loaded = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
  const odd = loaded.cases.filter((c) => c.text !== c.well_formed);
  expect(odd.length).toBeGreaterThanOrEqual(8);
  for (const c of odd) {
    expect(c.well_formed).toContain("\uFFFD");
    expect(sha256Hex(c.well_formed)).toBe(c.hash);
  }
});
