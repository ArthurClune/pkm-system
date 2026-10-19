import { expect, it } from "vitest";

it("passes, then a timer logs after the file's last test", () => {
  setTimeout(() => { console.error("late log"); }, 0);
  expect(1).toBe(1);
});
