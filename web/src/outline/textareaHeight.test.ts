import { describe, expect, test } from "vitest";
import { heightChanged, mayHaveShrunk } from "./textareaHeight";

describe("mayHaveShrunk", () => {
  test("more characters typed with no newline change: false", () => {
    expect(mayHaveShrunk("cat", "catches")).toBe(false);
  });

  test("fewer characters (a deletion): true", () => {
    expect(mayHaveShrunk("catches", "cat")).toBe(true);
  });

  test("same length, one line lost (a hard break removed): true", () => {
    expect(mayHaveShrunk("a\nb", "ab")).toBe(true);
  });

  // pkm-youp fix round 1: an equal-length, equal-newline-count replacement
  // can still re-wrap narrower (character widths vary -- a run of "w"s wraps
  // sooner than the same count of "i"s), so it must reset like a shrink
  // would. Skipping the reset here previously left `heightChanged` unable to
  // notice: a measurement clamped to the old (too tall) box never differs
  // from what's already applied, so the stale height stuck permanently.
  test("same length, same newline count, different characters: true (may re-wrap narrower)", () => {
    expect(mayHaveShrunk("wwww", "iiii")).toBe(true);
  });

  test("same length, one character swapped: true", () => {
    expect(mayHaveShrunk("abc", "abd")).toBe(true);
  });

  test("longer text but with a newline added: false (still growing)", () => {
    expect(mayHaveShrunk("one line", "one line\nand another")).toBe(false);
  });

  test("longer text that also lost a newline: true (length alone would miss it)", () => {
    expect(mayHaveShrunk("a\nb\nc", "a b c d")).toBe(true);
  });

  // Not strictly necessary (the effect this feeds only runs on an actual
  // draft change, and React never re-fires it for a same-value string), but
  // the function's own contract is length-based, and identical text has no
  // strict growth -- so it resets too. Harmless: the measured height won't
  // have changed either, so `heightChanged` still no-ops the write.
  test("identical text: true", () => {
    expect(mayHaveShrunk("same", "same")).toBe(true);
  });

  test("empty to empty: true", () => {
    expect(mayHaveShrunk("", "")).toBe(true);
  });
});

describe("heightChanged", () => {
  test("no prior height recorded: any measurement counts as changed", () => {
    expect(heightChanged(40, null)).toBe(true);
  });

  test("measurement equal to the last applied height: unchanged", () => {
    expect(heightChanged(40, 40)).toBe(false);
  });

  test("measurement grown past the last applied height: changed", () => {
    expect(heightChanged(60, 40)).toBe(true);
  });

  test("measurement shrunk below the last applied height: changed", () => {
    expect(heightChanged(20, 40)).toBe(true);
  });
});
