import { describe, expect, test } from "vitest";
import type { Tally } from "../reach";
import type { DriverAction } from "./driverArbitraries";
import { fakeDriverClock, REAL_DRIVER, runDriverActions } from "./driverRun";

fakeDriverClock();

const send: DriverAction = { a: "send", blank: false };
const stop: DriverAction = { a: "stop" };
const newChat: DriverAction = { a: "newChat" };
// outcome 0 resolves a create, opens a stream, and ends the turn of an
// open stream whose stop was posted (turn_stopped)
const first: DriverAction = { a: "settle", pick: 0, outcome: 0 };
const busy: DriverAction = { a: "settle", pick: 0, outcome: 55 };
const notFound: DriverAction = { a: "settle", pick: 0, outcome: 75 };

async function reached(actions: DriverAction[]): Promise<Tally> {
  const tally: Tally = new Map();
  expect((await runDriverActions(actions, REAL_DRIVER, tally)).problems).toEqual([]);
  return tally;
}

// The interleavings the property must reach, run as fixed lists: each passes
// on the real driver and lands the tally entry that names it.
describe("assistant driver property runner", () => {
  test("Stop on an open stream posts at once, and turn_stopped ends it", async () => {
    const tally = await reached([send, first, first, stop, first]);
    expect(tally.get("stop posted at once")).toBe(1);
    expect(tally.get("turn_stopped after a posted stop")).toBe(1);
  });

  test("Stop before the stream opens posts once it opens", async () => {
    const tally = await reached([send, first, stop, first]);
    expect(tally.get("stop posted once the stream opened")).toBe(1);
  });

  test("Stop on a stream that 404s before opening posts nothing", async () => {
    const tally = await reached([send, first, stop, notFound]);
    expect(tally.get("stop posts nothing: the stream settled first")).toBe(1);
  });

  test("the deadline aborts the stream and the stop POST", async () => {
    const tally = await reached([send, first, first, stop, { a: "tick", to: "bound" }]);
    expect(tally.get("fallback aborts the stream (the deadline passed)")).toBe(1);
    expect(tally.get("fallback aborts the stop POST (the deadline passed)")).toBe(1);
  });

  test("a failed stop POST aborts the stream", async () => {
    // the stream is the first request outstanding and the stop POST the
    // second; outcome 70 fails the POST
    const tally = await reached([send, first, first, stop, { a: "settle", pick: 1, outcome: 70 }]);
    expect(tally.get("fallback aborts the stream (the stop POST failed)")).toBe(1);
  });

  test("New chat's DELETE waits for the aborted stream", async () => {
    const tally = await reached([send, first, first, newChat, first]);
    expect(tally.get("new chat's DELETE waits for the aborted stream")).toBe(1);
    expect(tally.get("DELETE sent once the aborted stream settled")).toBe(1);
  });

  test("Stop during a 409's back-off sends no retry", async () => {
    const tally = await reached([send, first, busy, stop, { a: "tick", to: "next" }]);
    expect(tally.get("stop during a 409's back-off")).toBe(1);
    expect(tally.get("a 409 fails the turn")).toBe(1);
  });

  test("a conversation created for a superseded turn is deleted", async () => {
    const tally = await reached([send, newChat, first]);
    expect(tally.get("DELETE of a conversation made for a superseded turn")).toBe(1);
  });
});
