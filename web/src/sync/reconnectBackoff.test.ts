import { describe, expect, it } from "vitest";
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS, reconnectDelayMs } from "./reconnectBackoff";

describe("reconnectDelayMs", () => {
  it("starts at the base interval for the first retry", () => {
    expect(reconnectDelayMs(0)).toBe(RECONNECT_BASE_MS);
  });

  it("doubles per consecutive failure", () => {
    expect([1, 2, 3].map(reconnectDelayMs)).toEqual([4000, 8000, 16000]);
  });

  it("caps at the ceiling and stays there", () => {
    expect(reconnectDelayMs(4)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelayMs(5)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelayMs(500)).toBe(RECONNECT_MAX_MS);
  });

  it("keeps a dead link under four attempts per minute once capped", () => {
    // the bean's acceptance criterion: 30/min before, <= 4/min after the
    // first minute of failures
    expect(60_000 / reconnectDelayMs(4)).toBeLessThanOrEqual(4);
  });
});
