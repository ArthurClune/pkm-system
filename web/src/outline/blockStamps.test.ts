// @vitest-environment node
import { describe, expect, test } from "vitest";
import type { BlockOp } from "../api/ops";
import {
  bumpedUids,
  formatStamp,
  formatStampTitle,
  opBumpsUpdatedAt,
  stampBand,
  stampTs,
} from "./blockStamps";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 7, 3, 12, 0).getTime(); // 3 Aug 2026, local noon

describe("stampTs", () => {
  test("prefers updated_at", () => {
    expect(stampTs({ created_at: 1000, updated_at: 2000 })).toBe(2000);
  });

  test("falls back to created_at when updated_at is null", () => {
    expect(stampTs({ created_at: 1000, updated_at: null })).toBe(1000);
  });

  test("is null when the block has neither", () => {
    expect(stampTs({ created_at: null, updated_at: null })).toBeNull();
  });
});

describe("stampBand", () => {
  test.each([
    ["exactly 7 days old is still this week", 7 * DAY, "week"],
    ["a moment past 7 days is this month", 7 * DAY + 1, "month"],
    ["exactly 31 days old is still this month", 31 * DAY, "month"],
    ["a moment past 31 days is this year", 31 * DAY + 1, "year"],
    ["exactly 365 days old is still this year", 365 * DAY, "year"],
    ["a moment past 365 days is older", 365 * DAY + 1, "older"],
  ])("%s", (_label, age, band) => {
    expect(stampBand(NOW, NOW - age)).toBe(band);
  });

  test("a future timestamp (clock skew) reads as freshest, not oldest", () => {
    expect(stampBand(NOW, NOW + DAY)).toBe("week");
  });
});

describe("formatStamp", () => {
  test("renders a compact day/month/two-digit-year", () => {
    expect(formatStamp(new Date(2026, 7, 3, 14, 22).getTime())).toBe("3 Aug 26");
  });

  test("pads years below 2010 to two digits", () => {
    expect(formatStamp(new Date(2009, 0, 9).getTime())).toBe("9 Jan 09");
  });
});

describe("formatStampTitle", () => {
  test("gives the full local date and zero-padded time for hover", () => {
    expect(formatStampTitle(new Date(2026, 7, 3, 14, 22).getTime()))
      .toBe("3 August 2026, 14:22");
    expect(formatStampTitle(new Date(2026, 7, 3, 9, 5).getTime()))
      .toBe("3 August 2026, 09:05");
  });
});

describe("opBumpsUpdatedAt", () => {
  const cases: Array<[BlockOp, boolean]> = [
    [{ op: "create", uid: "u1", page_title: "P", parent_uid: null,
       order_idx: 0, text: "hi" }, true],
    [{ op: "update_text", uid: "u1", text: "hi" }, true],
    [{ op: "move", uid: "u1", parent_uid: null, order_idx: 1 }, true],
    [{ op: "set_heading", uid: "u1", heading: 2 }, true],
    [{ op: "set_view_type", uid: "u1", view_type: "numbered" }, true],
    // pkm-r7k8: collapsing is a view toggle, not a change
    [{ op: "set_collapsed", uid: "u1", collapsed: true }, false],
    [{ op: "delete", uid: "u1" }, false],
    [{ op: "create_page", page_title: "P" }, false],
  ];
  test.each(cases)("%o -> %s", (op, expected) => {
    expect(opBumpsUpdatedAt(op)).toBe(expected);
  });
});

describe("bumpedUids", () => {
  test("collects changed uids once each, skipping non-changes", () => {
    expect(bumpedUids([
      { op: "update_text", uid: "u1", text: "a" },
      { op: "set_collapsed", uid: "u2", collapsed: true },
      { op: "update_text", uid: "u1", text: "ab" },
      { op: "set_heading", uid: "u3", heading: 1 },
      { op: "create_page", page_title: "P" },
    ])).toEqual(["u1", "u3"]);
  });

  test("is empty for a collapse-only batch", () => {
    expect(bumpedUids([{ op: "set_collapsed", uid: "u1", collapsed: false }]))
      .toEqual([]);
  });
});
