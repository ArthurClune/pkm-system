import { describe, expect, it } from "vitest";
import { devProxyOrigin } from "./devProxyOrigin";

const target = "http://127.0.0.1:8975";

describe("devProxyOrigin", () => {
  it("rewrites an origin that is same-origin with the dev server", () => {
    expect(
      devProxyOrigin("http://localhost:5173", "localhost:5173", target),
    ).toBe(target);
    expect(
      devProxyOrigin("http://127.0.0.1:5199", "127.0.0.1:5199", target),
    ).toBe(target);
  });

  it.each([
    ["another localhost port", "http://localhost:3000", "localhost:5173"],
    ["an opaque origin", "null", "localhost:5173"],
    ["another scheme", "https://localhost:5173", "localhost:5173"],
    ["no origin", undefined, "localhost:5173"],
    ["no host", "http://localhost:5173", undefined],
  ])("leaves %s alone", (_label, origin, host) => {
    expect(devProxyOrigin(origin, host, target)).toBeUndefined();
  });
});
