import { expect, test } from "vitest";
import type { UpdateTextOp } from "../api/ops";
import { parseSha256Hex, sha256Hex } from "./sha256";

test("sha256Hex of the empty string is the known digest", () => {
  expect(sha256Hex("")).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("a plain string does not satisfy a hash field", () => {
  // @ts-expect-error a plain string is not a hash
  const h: UpdateTextOp["base_text_hash"] = "x" as string;
  expect(h).toBe("x");
});

test("parseSha256Hex accepts 64 lowercase hex characters only", () => {
  const hex = "ab".repeat(32);
  expect(parseSha256Hex(hex)).toBe(hex);
  expect(parseSha256Hex(hex.toUpperCase())).toBeNull();
  expect(parseSha256Hex(hex.slice(1))).toBeNull();
  expect(parseSha256Hex(`${hex}\n`)).toBeNull();
});
