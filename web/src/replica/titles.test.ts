// @vitest-environment node
import { describe, expect, test } from "vitest";
import { canonicalizeTitle } from "./titles";

describe("canonicalizeTitle", () => {
  test.each([
    ["A\t B", false, "A B"],
    ["  A\n B  ", false, "A B"],
    ["A\t B", true, "A B"],
    ["  A\n B  ", true, "A B"],
  ] as const)("always normalizes control whitespace in %s", (title, active, want) => {
    expect(canonicalizeTitle(title, active)).toBe(want);
  });

  test("preserves boundary U+0020 before activation", () => {
    expect(canonicalizeTitle("  A  ", false)).toBe("  A  ");
  });

  test("strips only boundary U+0020 after activation", () => {
    expect(canonicalizeTitle("  A  ", true)).toBe("A");
    expect(canonicalizeTitle("A  B", true)).toBe("A  B");
    expect(canonicalizeTitle("\u00a0 A \u00a0", true)).toBe("\u00a0 A \u00a0");
  });
});
