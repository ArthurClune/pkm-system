import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { matchesFilter, parseFilter } from "./filter";
import { compareCells, sortRows } from "./sort";

const MONTHS = ["Jan", "feb", "March", "APR", "sep", "December"];
const dateCell = fc.oneof(
  fc.tuple(fc.constantFrom(...MONTHS), fc.integer({ min: 1990, max: 2040 }))
    .map(([m, y]) => `${m} ${y}`),
  fc.integer({ min: 1990, max: 2040 }).map(String),
);
const numberCell = fc.double({ min: 0, max: 1000, noNaN: true })
  .map((n) => String(n));
const textCell = fc.stringMatching(/^[a-z][a-z#\[\] ]{0,7}$/);
const blank = fc.constantFrom<string | undefined>(undefined, "", " ");
const sameKind = (cell: fc.Arbitrary<string>) =>
  fc.oneof(cell, blank) as fc.Arbitrary<string | undefined>;
const dir = fc.constantFrom<"asc" | "desc">("asc", "desc");

describe("compareCells laws", () => {
  for (const [name, cell] of [
    ["dates", dateCell], ["numbers", numberCell], ["text", textCell],
  ] as const) {
    it(`${name}: antisymmetric and transitive`, () => {
      fc.assert(fc.property(
        sameKind(cell), sameKind(cell), sameKind(cell), dir,
        (a, b, c, d) => {
          expect(Math.sign(compareCells(a, b, d)))
            .toBe(-Math.sign(compareCells(b, a, d)) || 0);
          if (compareCells(a, b, d) <= 0 && compareCells(b, c, d) <= 0) {
            expect(compareCells(a, c, d)).toBeLessThanOrEqual(0);
          }
        },
      ));
    });
  }

  it("blanks are last in both directions", () => {
    fc.assert(fc.property(
      fc.oneof(dateCell, numberCell, textCell), blank, dir,
      (v, b, d) => {
        expect(compareCells(b, v, d)).toBeGreaterThan(0);
        expect(compareCells(v, b, d)).toBeLessThan(0);
      },
    ));
  });
});

describe("sortRows laws", () => {
  it("is a stable permutation, in order", () => {
    fc.assert(fc.property(
      fc.array(fc.tuple(sameKind(dateCell), fc.nat()), { maxLength: 30 }),
      dir,
      (cells, d) => {
        const rows = cells.map(([k], i) => ({ k, i }));
        const out = sortRows(rows, (r) => r.k, d);
        expect([...out].sort((x, y) => x.i - y.i)).toEqual(rows);
        for (let j = 1; j < out.length; j++) {
          const c = compareCells(out[j - 1]!.k, out[j]!.k, d);
          expect(c).toBeLessThanOrEqual(0);
          if (c === 0) expect(out[j - 1]!.i).toBeLessThan(out[j]!.i);
        }
      },
    ));
  });
});

describe("filter laws", () => {
  it("parseFilter and matchesFilter never throw", () => {
    fc.assert(fc.property(fc.string(), (text) => {
      const terms = parseFilter(text);
      matchesFilter({ A: text }, terms, ["A", "B"]);
    }));
  });

  it("negating a term flips its match", () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[a-z]{1,5}$/), fc.string(),
      (word, cell) => {
        const r = { A: cell };
        expect(matchesFilter(r, parseFilter(`-${word}`), ["A"]))
          .toBe(!matchesFilter(r, parseFilter(word), ["A"]));
      },
    ));
  });
});
