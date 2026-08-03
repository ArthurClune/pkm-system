import { expect, test } from "vitest";
import {
  BLOCK_STAMPS_STORAGE_KEY,
  isBlockStampsPref,
  toggleBlockStampsPref,
} from "./blockStampsPref";

test("the storage key is namespaced", () => {
  expect(BLOCK_STAMPS_STORAGE_KEY).toBe("pkm:block-stamps");
});

test("only the two known values are accepted", () => {
  expect(isBlockStampsPref("on")).toBe(true);
  expect(isBlockStampsPref("off")).toBe(true);
  expect(isBlockStampsPref("yes")).toBe(false);
  expect(isBlockStampsPref(null)).toBe(false);
  expect(isBlockStampsPref(undefined)).toBe(false);
});

test("toggling flips between the two", () => {
  expect(toggleBlockStampsPref("off")).toBe("on");
  expect(toggleBlockStampsPref("on")).toBe("off");
});
