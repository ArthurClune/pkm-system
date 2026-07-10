import { describe, expect, test } from "vitest";
import { refTitleAtCaret } from "./refAtCaret";

describe("refTitleAtCaret", () => {
  test("caret inside the title", () => {
    expect(refTitleAtCaret("see [[Machine Learning]] please", 12)).toBe("Machine Learning");
  });

  test("caret outside any ref", () => {
    expect(refTitleAtCaret("see [[Machine Learning]] please", 2)).toBeNull();
    expect(refTitleAtCaret("see [[Machine Learning]] please", 28)).toBeNull();
  });

  test("caret on the opening brackets counts as inside", () => {
    const text = "[[World]]";
    expect(refTitleAtCaret(text, 0)).toBe("World");
    expect(refTitleAtCaret(text, 1)).toBe("World");
    expect(refTitleAtCaret(text, 2)).toBe("World");
  });

  test("caret on the closing brackets counts as inside", () => {
    const text = "[[World]]";
    expect(refTitleAtCaret(text, 7)).toBe("World");
    expect(refTitleAtCaret(text, 8)).toBe("World");
    expect(refTitleAtCaret(text, 9)).toBe("World");
  });

  test("caret just past the ref (one char after the closer) is outside", () => {
    expect(refTitleAtCaret("[[World]] x", 10)).toBeNull();
  });

  test("multiple refs: picks the one containing the caret", () => {
    const text = "[[a]] b [[c]]";
    expect(refTitleAtCaret(text, 2)).toBe("a");
    expect(refTitleAtCaret(text, 6)).toBeNull(); // in " b " between the two
    expect(refTitleAtCaret(text, 10)).toBe("c");
  });

  test("unclosed [[ never matches", () => {
    expect(refTitleAtCaret("see [[Machine", 8)).toBeNull();
    expect(refTitleAtCaret("see [[Machine", 13)).toBeNull();
  });

  test("empty [[]] returns null", () => {
    expect(refTitleAtCaret("[[]]", 2)).toBeNull();
  });

  test("nested refs: caret in the inner span picks the innermost title", () => {
    const text = "[[outer [[inner]] tail]]";
    // caret inside "inner"
    const innerStart = text.indexOf("inner");
    expect(refTitleAtCaret(text, innerStart + 2)).toBe("inner");
    // caret in "outer "/"tail" prose but still within the outer span
    expect(refTitleAtCaret(text, 3)).toBe("outer [[inner]] tail");
  });
});
