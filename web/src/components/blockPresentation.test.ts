import { describe, expect, test } from "vitest";
import { quoteContent } from "./blockPresentation";

describe("quoteContent", () => {
  test("returns content after the exact leading quote prefix", () => {
    expect(quoteContent("> quoted")).toBe("quoted");
    expect(quoteContent("> ")).toBe("");
  });

  test("ignores greater-than characters without the exact prefix", () => {
    expect(quoteContent("x > quoted")).toBeNull();
    expect(quoteContent(">quoted")).toBeNull();
    expect(quoteContent(">")).toBeNull();
  });
});
