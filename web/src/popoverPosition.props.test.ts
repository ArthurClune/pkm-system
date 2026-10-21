// clampPopoverPosition over any measured rect and viewport: a popover that
// fits lands inside the margins, one that does not pins to the start edge.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { clampPopoverPosition } from "./popoverPosition";

const axisArb = fc.record({
  at: fc.integer({ min: -500, max: 2500 }),
  size: fc.integer({ min: 0, max: 1500 }),
  viewport: fc.integer({ min: 100, max: 2000 }),
});

describe("clampPopoverPosition", () => {
  test("clamps each axis inside the margins, or pins to the start edge", () => {
    const tally = { fits: 0, tooBig: 0, moved: 0, untouched: 0 };
    fc.assert(fc.property(axisArb, axisArb, fc.integer({ min: 0, max: 40 }),
      (h, v, margin) => {
        const out = clampPopoverPosition({
          x: h.at, y: v.at, width: h.size, height: v.size,
          viewportWidth: h.viewport, viewportHeight: v.viewport, margin,
        });
        for (const [got, a] of [[out.x, h], [out.y, v]] as const) {
          if (a.size + 2 * margin <= a.viewport) {
            tally.fits += 1;
            expect(got).toBeGreaterThanOrEqual(margin);
            expect(got + a.size).toBeLessThanOrEqual(a.viewport - margin);
            if (a.at >= margin && a.at + a.size <= a.viewport - margin) {
              expect(got).toBe(a.at);
              tally.untouched += 1;
            } else {
              tally.moved += 1;
            }
          } else {
            tally.tooBig += 1;
            expect(got).toBe(margin);
          }
        }
      }), { numRuns: 500 });
    for (const [name, count] of Object.entries(tally)) {
      expect(count, name).toBeGreaterThan(30);
    }
  });
});
