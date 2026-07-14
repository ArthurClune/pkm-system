import { describe, expect, test } from "vitest";
import { effectiveChildView } from "./blockView";

describe("effectiveChildView", () => {
  test("defaults to document when a block has no explicit view", () => {
    expect(effectiveChildView(null)).toBe("document");
  });

  test("an explicit mode applies to direct children only", () => {
    expect(effectiveChildView("numbered")).toBe("numbered");
    expect(effectiveChildView("document")).toBe("document");
  });
});
