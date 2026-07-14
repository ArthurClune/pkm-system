import { describe, expect, test } from "vitest";
import { effectiveChildView } from "./blockView";

describe("effectiveChildView", () => {
  test("inherits when a block has no explicit view", () => {
    expect(effectiveChildView("document", null)).toBe("document");
    expect(effectiveChildView("numbered", null)).toBe("numbered");
  });

  test("an explicit mode creates a nested boundary", () => {
    expect(effectiveChildView("document", "numbered")).toBe("numbered");
    expect(effectiveChildView("numbered", "document")).toBe("document");
  });
});
