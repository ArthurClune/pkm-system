import { afterEach, expect, it, vi } from "vitest";
import { copyText } from "./copyText";

afterEach(() => {
  Object.assign(navigator, { clipboard: undefined });
  vi.restoreAllMocks();
});

it("resolves true when the clipboard accepts the text", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  await expect(copyText("hi")).resolves.toBe(true);
  expect(writeText).toHaveBeenCalledWith("hi");
});

it("resolves false when there is no Clipboard API", async () => {
  Object.assign(navigator, { clipboard: undefined });
  await expect(copyText("hi")).resolves.toBe(false);
});

it("resolves false when the write is rejected", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  Object.assign(navigator, { clipboard: { writeText } });
  await expect(copyText("hi")).resolves.toBe(false);
});

it("resolves false when the write throws synchronously", async () => {
  const writeText = vi.fn(() => { throw new Error("blocked"); });
  Object.assign(navigator, { clipboard: { writeText } });
  await expect(copyText("hi")).resolves.toBe(false);
});
