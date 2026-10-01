import { describe, expect, test } from "vitest";
import { elapsedLabel } from "./elapsed";

describe("elapsedLabel", () => {
  test("renders seconds under a minute", () => {
    expect(elapsedLabel({ sinceMs: 0, nowMs: 0 })).toBe("0s");
    expect(elapsedLabel({ sinceMs: 0, nowMs: 47_000 })).toBe("47s");
    expect(elapsedLabel({ sinceMs: 0, nowMs: 59_999 })).toBe("59s");
  });

  test("renders minutes and seconds from one minute up", () => {
    expect(elapsedLabel({ sinceMs: 0, nowMs: 60_000 })).toBe("1m 0s");
    expect(elapsedLabel({ sinceMs: 0, nowMs: 89_000 })).toBe("1m 29s");
    expect(elapsedLabel({ sinceMs: 0, nowMs: 300_000 })).toBe("5m 0s");
  });

  test("clamps a clock that reads earlier than the start to zero", () => {
    expect(elapsedLabel({ sinceMs: 5_000, nowMs: 0 })).toBe("0s");
  });
});
