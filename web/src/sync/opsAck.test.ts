import { expect, test } from "vitest";
import fixture from "../../../shared/fixtures/ops_acks.json";
import { parseOpsAck } from "../props/sync/wire";
import { readOpsAck, type SkipReason } from "./opsAck";
import { seqOf } from "../test-helpers";

test.each(fixture.cases)("reads the $name wire ack", ({ wire }) => {
  const ack = parseOpsAck(wire);
  expect(readOpsAck(ack)).toEqual({ seq: ack.seq ?? undefined, skipped: ack.skipped });
});

test("an ack missing seq names no seq and no skips", () => {
  expect(readOpsAck({ ok: true, ts: 1, applied: 2 })).toEqual({ seq: undefined, skipped: [] });
});

test("an ack missing skipped keeps its seq and names no skips", () => {
  expect(readOpsAck({ ok: true, ts: 1, applied: 2, seq: seqOf(7) })).toEqual({ seq: 7, skipped: [] });
});

test("a null or non-finite seq is unknown", () => {
  expect(readOpsAck({ ok: true, ts: 1, applied: 1, seq: null }).seq).toBeUndefined();
  // A wire value the reader must call unknown.
  // @ts-expect-error -- NaN is no SyncSeq
  expect(readOpsAck({ ok: true, ts: 1, applied: 1, seq: Number.NaN }).seq).toBeUndefined();
});

test("a malformed skipped field reads as no skips", () => {
  // A wire value the reader must survive.
  // @ts-expect-error -- skipped is no array
  expect(readOpsAck({ ok: true, ts: 1, applied: 1, skipped: "nope" }).skipped)
    .toEqual([]);
});

test("SkipReason is exactly the shared fixture's reasons", () => {
  // A reason added to or removed from the server's SkipReason changes the
  // generated union, and this record then fails to type-check.
  const reasons: Record<SkipReason, true> = {
    block_not_found: true,
    parent_not_found: true,
    cycle: true,
    page_deleted: true,
  };
  expect(Object.keys(reasons)).toEqual(fixture.skip_reasons);
});
