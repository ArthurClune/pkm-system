import { expect, it } from "vitest";
import { substituteMissingDaily, substituteMissingDay } from "./missingPage";
import { canonicalTitleOf, rawTitleOf } from "../test-helpers";

it("substitutes an empty editable page for a 404 on a daily title", () => {
  const page = substituteMissingDaily(rawTitleOf("July 8th, 2026"), 404);
  expect(page?.blocks).toEqual([]);
  expect(page?.page.title).toBe("July 8th, 2026");
});

it("leaves any other missing page an error", () => {
  expect(substituteMissingDaily(rawTitleOf("Some Page"), 404)).toBeNull();
  expect(substituteMissingDaily(rawTitleOf("July 8th, 2026"), 500)).toBeNull();
  // null status: the read never reached HTTP at all (transport, offline)
  expect(substituteMissingDaily(rawTitleOf("July 8th, 2026"), null)).toBeNull();
});

it("treats a 404 on a journal day as empty whatever the title looks like", () => {
  expect(substituteMissingDay(canonicalTitleOf("Not A Date"), 404)?.blocks).toEqual([]);
  expect(substituteMissingDay(canonicalTitleOf("Not A Date"), 500)).toBeNull();
  expect(substituteMissingDay(canonicalTitleOf("Not A Date"), null)).toBeNull();
});
