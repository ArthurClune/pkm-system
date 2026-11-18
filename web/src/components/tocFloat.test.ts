import { expect, test } from "vitest";
import { FLOATING_TOC_MIN_PANE_PX, tocFloatRoom } from "./tocFloat";

test("floats only with the sidebar closed and the pane wide enough", () => {
  expect(tocFloatRoom(false, FLOATING_TOC_MIN_PANE_PX)).toBe(true);
  expect(tocFloatRoom(false, FLOATING_TOC_MIN_PANE_PX - 1)).toBe(false);
  expect(tocFloatRoom(true, 2000)).toBe(false);
  expect(tocFloatRoom(false, 0)).toBe(false);
});

test("the threshold leaves a reading column beside the 220px toc", () => {
  expect(FLOATING_TOC_MIN_PANE_PX).toBe(860);
});
