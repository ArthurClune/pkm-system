import { expect, it, vi } from "vitest";

it("silences an expected warning and asserts it", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  console.warn("expected warning");
  expect(warn).toHaveBeenCalledWith("expected warning");
  vi.restoreAllMocks();
});
