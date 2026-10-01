// The server test (test_ops_idempotency.py) proves the shared fixture's
// `wire` values are exactly what the route emits for each stored ack shape.
// This feeds those same values through the real drain, so the two halves
// compose on one fixture: a stored ack the server would actually replay
// drives deleteBatch and onSkipped exactly as it would in production.
import { beforeEach, expect, test, vi } from "vitest";
import fixture from "../../../shared/fixtures/ops_acks.json";
import type { BlockOp } from "../api/ops";
import { jsonResponse, uid } from "../test-helpers";
import { memReplica } from "./memReplica";
import { createOpQueue } from "./opQueue";

beforeEach(() => { localStorage.clear(); });

// Local to this file, like opQueue.replica.test.ts's fetchSeq: a fetch stub
// is test wiring, not something other test files should import.
function fetchSeq(responses: Array<() => Response | Promise<Response>>) {
  let call = 0;
  const mock = vi.fn(async () => {
    const make = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return make();
  });
  vi.stubGlobal("fetch", mock);
  return { mock };
}

const op: BlockOp = { op: "delete", uid: uid("u1") };

test.each(fixture.cases)("the $name ack the route replays drives the drain",
async ({ wire }) => {
  fetchSeq([() => jsonResponse(wire)]);
  const replica = memReplica();
  const base = replica.deleteBatch;
  const deletes: Array<number | undefined> = [];
  replica.deleteBatch = async (id, batchId, ackedSeq) => {
    deletes.push(ackedSeq);
    return base(id, batchId, ackedSeq);
  };
  const skips: void[] = [];
  const q = createOpQueue(replica);
  q.onSkipped(() => skips.push(undefined));
  const ticket = q.enqueue([op]);
  await q.settled();
  await q.drain();
  expect(deletes).toEqual([wire.seq ?? undefined]);
  expect(skips).toHaveLength(wire.skipped.length > 0 ? 1 : 0);
  await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
});
