import { expect, test } from "vitest";
import { ackSeq } from "./opsAck";

test("ackSeq reads a finite seq and nothing else", () => {
  expect(ackSeq({ seq: 7 })).toBe(7);
  expect(ackSeq({ ok: true })).toBeUndefined();
  expect(ackSeq({ seq: null })).toBeUndefined();
  expect(ackSeq({ seq: Number.NaN })).toBeUndefined();
  expect(ackSeq(null)).toBeUndefined();
});
