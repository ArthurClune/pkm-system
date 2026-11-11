import { describe, expect, it } from "vitest";
import { focusWrapTarget } from "./focusWrap";

describe("focusWrapTarget", () => {
  const [a, b, c] = ["a", "b", "c"];

  it("returns null when there is nothing to trap", () => {
    expect(focusWrapTarget([], a, false)).toBeNull();
    expect(focusWrapTarget([], a, true)).toBeNull();
  });

  it("Tab from the last focusable wraps to the first", () => {
    expect(focusWrapTarget([a, b, c], c, false)).toBe(a);
  });

  it("Shift+Tab from the first focusable wraps to the last", () => {
    expect(focusWrapTarget([a, b, c], a, true)).toBe(c);
  });

  it("returns null mid-list so the browser's own tab order runs", () => {
    expect(focusWrapTarget([a, b, c], b, false)).toBeNull();
    expect(focusWrapTarget([a, b, c], b, true)).toBeNull();
  });

  it("pulls focus back inside when the active element escaped the trap", () => {
    expect(focusWrapTarget([a, b, c], "elsewhere", false)).toBe(a);
    expect(focusWrapTarget([a, b, c], "elsewhere", true)).toBe(c);
    expect(focusWrapTarget([a, b, c], null, false)).toBe(a);
  });

  it("a single focusable always wraps to itself", () => {
    expect(focusWrapTarget([a], a, false)).toBe(a);
    expect(focusWrapTarget([a], a, true)).toBe(a);
  });
});
