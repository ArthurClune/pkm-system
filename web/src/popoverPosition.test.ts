import { expect, it } from "vitest";
import { clampPopoverPosition, placeUnderAnchor } from "./popoverPosition";

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

const VIEW = { viewportWidth: 1024, viewportHeight: 768, margin: 12, gap: 2 };

it("places a popover under its anchor when it fits there", () => {
  expect(placeUnderAnchor({
    anchor: { left: 100, top: 200, bottom: 220 }, width: 240, height: 100, ...VIEW,
  })).toEqual({ x: 100, y: 222 });
});

it("flips a popover above its anchor when only that fits", () => {
  expect(placeUnderAnchor({
    anchor: { left: 100, top: 700, bottom: 720 }, width: 240, height: 100, ...VIEW,
  })).toEqual({ x: 100, y: 598 });
});

it("clamps a popover that fits neither under nor above its anchor", () => {
  expect(placeUnderAnchor({
    anchor: { left: 100, top: 50, bottom: 70 }, width: 240, height: 720, ...VIEW,
  })).toEqual({ x: 100, y: 768 - 720 - 12 });
});
