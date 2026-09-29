import { expect, test } from "vitest";
import { ApiError } from "../api/client";
import { isTerminalRejection } from "./rejection";

test.each([400, 409, 413, 422])(
  "a %d ApiError is a terminal rejection", (status) => {
    expect(isTerminalRejection(new ApiError(status, "/api/ops"))).toBe(true);
  },
);

test.each([401, 403, 408, 429])(
  "a %d ApiError takes the retry-later path, not terminal", (status) => {
    expect(isTerminalRejection(new ApiError(status, "/api/ops"))).toBe(false);
  },
);

test("a 500 ApiError is not a terminal rejection", () => {
  expect(isTerminalRejection(new ApiError(500, "/api/ops"))).toBe(false);
});

test("a non-ApiError failure is not a terminal rejection", () => {
  expect(isTerminalRejection(new TypeError("network down"))).toBe(false);
});
