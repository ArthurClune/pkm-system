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

  test("same length, same newline count: false", () => {
    expect(mayHaveShrunk("abc", "abd")).toBe(false);
  });

  test("longer text but with a newline added: false (still growing)", () => {
    expect(mayHaveShrunk("one line", "one line\nand another")).toBe(false);
  });

  test("longer text that also lost a newline: true (length alone would miss it)", () => {
    expect(mayHaveShrunk("a\nb\nc", "a b c d")).toBe(true);
  });

  test("identical text: false", () => {
    expect(mayHaveShrunk("same", "same")).toBe(false);
  });

  test("empty to empty: false", () => {
    expect(mayHaveShrunk("", "")).toBe(false);
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
