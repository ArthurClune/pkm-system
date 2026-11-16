import { expect, it } from "vitest";
import { KEPT_OFFSETS, parseScrollOffsets, serializeScrollOffsets } from "./historyScroll";

it("round-trips offsets in insertion order", () => {
  const offsets = new Map([["a", 10], ["b", 0], ["c", 1234.5]]);
  expect([...parseScrollOffsets(serializeScrollOffsets(offsets))]).toEqual([...offsets]);
});

it("reads nothing from missing, unparseable or foreign storage", () => {
  for (const raw of [null, "", "{", "{}", "42", '"x"']) {
    expect(parseScrollOffsets(raw).size).toBe(0);
  }
});

it("skips malformed entries and keeps the rest", () => {
  const raw = JSON.stringify([
    ["ok", 5], ["short"], ["n", "7"], [3, 4], ["inf", null], "x", ["ok2", 6, 7], ["last", 9],
  ]);
  expect([...parseScrollOffsets(raw)]).toEqual([["ok", 5], ["last", 9]]);
});

it("keeps only the newest entries when saving", () => {
  const offsets = new Map<string, number>();
  for (let i = 0; i < KEPT_OFFSETS + 3; i++) offsets.set(`k${i}`, i);
  const kept = parseScrollOffsets(serializeScrollOffsets(offsets));
  expect(kept.size).toBe(KEPT_OFFSETS);
  expect(kept.has("k0")).toBe(false);
  expect(kept.get(`k${KEPT_OFFSETS + 2}`)).toBe(KEPT_OFFSETS + 2);
});
