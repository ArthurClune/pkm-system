import { expect, it } from "vitest";
import { INITIAL_SEQ, mintTicketId, parseBlockUid, parseSyncSeq } from "./ids";
import type { BlockUid } from "./api/brands";

it("parses a well-formed uid", () => {
  expect(parseBlockUid("abcdef")).toBe("abcdef");
});

it("parses a 32-character uid and rejects a 33-character one", () => {
  const uid32 = "a".repeat(32);
  const uid33 = "a".repeat(33);
  expect(parseBlockUid(uid32)).toBe(uid32);
  expect(parseBlockUid(uid33)).toBeNull();
});

it("rejects a too-short uid, a trailing newline and bracket syntax", () => {
  expect(parseBlockUid("abcde")).toBeNull();
  expect(parseBlockUid("abcdef\n")).toBeNull();
  expect(parseBlockUid("((abcdef))")).toBeNull();
});

// @ts-expect-error a plain string is not a BlockUid
const u: BlockUid = "abcdef";
void u;

it("parses a sync seq only from a finite number", () => {
  expect(parseSyncSeq(7)).toBe(7);
  expect(parseSyncSeq(Number.NaN)).toBeNull();
  expect(parseSyncSeq("7")).toBeNull();
  expect(parseSyncSeq(undefined)).toBeNull();
  expect(INITIAL_SEQ).toBe(0);
});

it("mints a numbered ticket id", () => {
  expect(mintTicketId(3)).toBe("write-3");
});
