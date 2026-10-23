import { describe, expect, test } from "vitest";
import { confirmHint, placeOf } from "./confirmHint";

describe("placeOf", () => {
  const view = { top: 100, bottom: 300 };

  test("a marker ending at or above the view's top is above", () => {
    expect(placeOf({ top: 40, bottom: 41 }, view)).toBe("above");
    expect(placeOf({ top: 99, bottom: 100 }, view)).toBe("above");
  });

  // inside the transcript's band but hidden: the list still has to scroll
  test("a marker below the view, or clipped inside it, is below", () => {
    expect(placeOf({ top: 400, bottom: 401 }, view)).toBe("below");
    expect(placeOf({ top: 200, bottom: 201 }, view)).toBe("below");
  });

  test("a view with no height places nothing", () => {
    expect(placeOf({ top: 0, bottom: 0 }, { top: 0, bottom: 0 })).toBeNull();
  });
});

describe("confirmHint", () => {
  test("points the way to an unseen end first", () => {
    expect(confirmHint("above", "below"))
      .toBe("Scroll to the end to review every write");
    expect(confirmHint("seen", "above"))
      .toBe("Scroll up to bring the end of the list into view");
  });

  test("then to an unseen start", () => {
    expect(confirmHint("above", "seen"))
      .toBe("Scroll back to the start to review every write");
    expect(confirmHint("below", "seen"))
      .toBe("Scroll down to the start of the card to review every write");
  });

  test("says nothing once both are seen", () => {
    expect(confirmHint("seen", "seen")).toBeNull();
  });
});
