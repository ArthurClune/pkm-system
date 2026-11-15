import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { splitMacroOptions, type MacroOptions } from "./macroOptions";
import {
  formatMacroOptions, normaliseMacroOptions, optionsRefusal,
} from "./macroOptionsWrite";

// The server property's alphabet (test_macro_options.py _TEXT): the
// refused characters are drawn so the refusal is exercised, not dodged.
const TEXT = fc.array(fc.constantFrom(..."ab -:,\t#{}|[]"), { maxLength: 8 })
  .map((cs) => cs.join(""));

const OPTIONS: fc.Arbitrary<MacroOptions> = fc.record({
  view: fc.constantFrom("table", "cards", "blocks"),
  filter: TEXT,
  sort: fc.record({ col: TEXT, dir: fc.constantFrom("asc", "desc") }),
  columns: fc.array(TEXT, { maxLength: 4 }),
}, { requiredKeys: [] }) as fc.Arbitrary<MacroOptions>;

describe("macro options", () => {
  it("accepted options round-trip to their normal form", () => {
    fc.assert(fc.property(OPTIONS, (opts) => {
      fc.pre(optionsRefusal(opts) === null);
      const head = "{and: [[A]]}";
      expect(splitMacroOptions(head + formatMacroOptions(opts)))
        .toStrictEqual({ head, options: normaliseMacroOptions(opts) });
    }), { numRuns: 500 });
  });
});
