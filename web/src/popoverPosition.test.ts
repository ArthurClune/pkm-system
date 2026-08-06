import { expect, it } from "vitest";
import { clampPopoverPosition } from "./popoverPosition";

it("leaves a position alone when the popover already fits", () => {
  expect(clampPopoverPosition({
    x: 100, y: 200, width: 300, height: 150,
    viewportWidth: 1024, viewportHeight: 768, margin: 12,
  })).toEqual({ x: 100, y: 200 });
});

it("pulls the popover back inside the right viewport edge", () => {
  expect(clampPopoverPosition({
    x: 900, y: 200, width: 480, height: 150,
    viewportWidth: 1024, viewportHeight: 768, margin: 12,
  })).toEqual({ x: 1024 - 480 - 12, y: 200 });
});

it("pulls the popover back inside the bottom viewport edge", () => {
  expect(clampPopoverPosition({
    x: 100, y: 700, width: 300, height: 400,
    viewportWidth: 1024, viewportHeight: 768, margin: 12,
  })).toEqual({ x: 100, y: 768 - 400 - 12 });
});

it("never goes past the top-left margin, even for oversized popovers", () => {
  // wider than the viewport: the left/top margin wins over the right/bottom
  expect(clampPopoverPosition({
    x: 500, y: 500, width: 2000, height: 2000,
    viewportWidth: 1024, viewportHeight: 768, margin: 12,
  })).toEqual({ x: 12, y: 12 });
});
