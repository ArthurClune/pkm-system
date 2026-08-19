import { describe, expect, test } from "vitest";
import { elapsedLabel } from "./elapsed";

describe("elapsedLabel", () => {
  test("renders seconds under a minute", () => {
    expect(elapsedLabel(0, 0)).toBe("0s");
    expect(elapsedLabel(0, 47_000)).toBe("47s");
    expect(elapsedLabel(0, 59_999)).toBe("59s");
  });

  test("renders minutes and seconds from one minute up", () => {
    expect(elapsedLabel(0, 60_000)).toBe("1m 0s");
    expect(elapsedLabel(0, 89_000)).toBe("1m 29s");
    expect(elapsedLabel(0, 300_000)).toBe("5m 0s");
  });

  test("clamps a clock that reads earlier than the start to zero", () => {
    expect(elapsedLabel(5_000, 0)).toBe("0s");
  });
});
