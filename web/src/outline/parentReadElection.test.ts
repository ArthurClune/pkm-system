import { expect, it, vi } from "vitest";
import { block, pagePayload } from "../test-helpers";
import type { ReadToken } from "./outlineState";
import {
  createParentReadElection,
  type ParentReadElection,
  type ParentReadHost,
} from "./parentReadElection";

/** The session as the election sees it, with every query writable so a test
 * can put the machine in the state a race would. */
function createHost() {
  const state = {
    latest: 1,
    manualReads: new Set<number>(),
    captures: new Set<number>(),
    repairing: false,
    blocks: [block("u1", "session tree")],
  };
  const host: ParentReadHost = {
    title: "Elected",
    latestRequestId: () => state.latest,
    hasActivatedCapture: (requestId) => state.captures.has(requestId),
    manualReadCount: () => state.manualReads.size,
    hasManualRead: (requestId) => state.manualReads.has(requestId),
    repairActive: () => state.repairing,
    publishedBlocks: () => state.blocks,
  };
  return { state, election: createParentReadElection(host) };
}

const token = (requestId: number): ReadToken =>
  ({ requestId, revisionAtDispatch: 0 });

/** Let the scheduled election microtask run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Watch a readiness promise without letting an expected rejection float. */
function watch(promise: Promise<unknown>) {
  const seen = { value: undefined as unknown, error: undefined as unknown };
  return {
    seen,
    done: promise.then(
      (value) => { seen.value = value; },
      (error: unknown) => { seen.error = error; },
    ),
  };
}

/** The one thing every "nobody will publish" test needs: a waiter, and a
 * controller that starts the read the machine hopes for (or does not). */
function readyWaiter(
  election: ParentReadElection,
  requestId = 1,
) {
  const readiness = election.awaitPayload(Symbol("owner"), token(requestId));
  return { readiness, ...watch(readiness.promise) };
}

it("publishes to waiters at or before the accepted read, with session blocks", async () => {
  const { state, election } = createHost();
  // An outstanding read: elections defer, so nothing but publish() settles.
  state.latest = 5;
  state.manualReads.add(5);
  const older = readyWaiter(election, 4);
  const same = readyWaiter(election, 5);
  const newer = readyWaiter(election, 6);

  election.publish(token(5), pagePayload("Elected", [block("stale", "wire")]));
  await settle();

  expect(older.seen.value).toMatchObject({
    page: { title: "Elected" },
    blocks: [expect.objectContaining({ uid: "u1" })],
  });
  expect(same.seen.value).toBeDefined();
  expect(newer.seen.value).toBeUndefined();
  expect(newer.seen.error).toBeUndefined();
});

it("answers a read an accepted payload already covers without a waiter", async () => {
  const { election } = createHost();
  const controller = vi.fn();
  election.addController(controller);
  election.publish(token(5), pagePayload("Elected", []));

  expect(election.hasAcceptedFor(token(5))).toBe(true);
  expect(election.hasAcceptedFor(token(6))).toBe(false);
  const covered = readyWaiter(election, 4);
  await settle();

  expect(covered.seen.value).toBeDefined();
  // Nothing was pending, so no election ran for it.
  expect(controller).not.toHaveBeenCalled();
});

it("elects the newest live controller and stands down once it reads", async () => {
  const { state, election } = createHost();
  const older = vi.fn();
  const newer = vi.fn(() => {
    state.latest = 2;
    state.manualReads.add(2);
  });
  election.addController(older);
  election.addController(newer);
  const waiter = readyWaiter(election);
  await settle();

  expect(newer).toHaveBeenCalledTimes(1);
  expect(older).not.toHaveBeenCalled();
  expect(waiter.seen.error).toBeUndefined();

  election.publish(token(2), pagePayload("Elected", []));
  await settle();
  expect(waiter.seen.value).toBeDefined();
});

it("defers while a read, an activated capture, or a repair could still publish", async () => {
  const { state, election } = createHost();
  const controller = vi.fn();
  election.addController(controller);
  readyWaiter(election);

  state.manualReads.add(1);
  election.schedule();
  await settle();
  expect(controller).not.toHaveBeenCalled();

  state.manualReads.clear();
  state.captures.add(state.latest);
  election.schedule();
  await settle();
  expect(controller).not.toHaveBeenCalled();

  state.captures.clear();
  state.repairing = true;
  election.schedule();
  await settle();
  expect(controller).not.toHaveBeenCalled();

  state.repairing = false;
  election.schedule();
  await settle();
  expect(controller).toHaveBeenCalledTimes(1);
});

it("rejects waiters when no controller is registered", async () => {
  const { election } = createHost();
  const waiter = readyWaiter(election);
  await settle();

  expect(String(waiter.seen.error)).toMatch(
    /No parent read controller for active outline Elected/,
  );
});

it("rejects when the elected controller starts no read", async () => {
  const { election } = createHost();
  election.addController(() => undefined);
  const waiter = readyWaiter(election);
  await settle();

  expect(String(waiter.seen.error)).toMatch(
    /Parent read controller did not start for Elected/,
  );
});

it("rejects with the controller's own failure when it throws", async () => {
  const { election } = createHost();
  election.addController(() => { throw new Error("controller exploded"); });
  const waiter = readyWaiter(election);
  await settle();

  expect(String(waiter.seen.error)).toMatch(/controller exploded/);
});

it("attempts recovery once, then reports the failure it already has", async () => {
  const { state, election } = createHost();
  const controller = vi.fn(() => {
    state.latest += 1;
    state.manualReads.add(state.latest);
  });
  election.addController(controller);
  const first = readyWaiter(election);
  await settle();
  expect(controller).toHaveBeenCalledTimes(1);

  // The elected read dies; nothing else is outstanding.
  state.manualReads.delete(state.latest);
  election.noteReadAbandoned(state.latest, new Error("elected read died"), true);
  await settle();

  expect(controller).toHaveBeenCalledTimes(1);
  expect(String(first.seen.error)).toMatch(/elected read died/);
});

it("a read this machine did not elect re-arms recovery", async () => {
  const { state, election } = createHost();
  const controller = vi.fn(() => {
    state.latest += 1;
    state.manualReads.add(state.latest);
  });
  election.addController(controller);
  readyWaiter(election);
  await settle();
  expect(controller).toHaveBeenCalledTimes(1);

  // A surface mounts and starts its own read, which then fails.
  election.noteReadBeginning();
  state.manualReads.clear();
  election.noteReadAbandoned(state.latest, new Error("mount read failed"), true);
  const second = readyWaiter(election, state.latest);
  await settle();

  expect(controller).toHaveBeenCalledTimes(2);
  expect(second.seen.error).toBeUndefined();
});

it("the elected controller's own read does not re-arm recovery", async () => {
  const { state, election } = createHost();
  const controller = vi.fn(() => {
    // What useOutlinePageLoad does inside the elected controller.
    election.noteReadBeginning();
    state.latest += 1;
    state.manualReads.add(state.latest);
  });
  election.addController(controller);
  readyWaiter(election);
  await settle();

  state.manualReads.clear();
  election.noteReadAbandoned(state.latest, new Error("elected died"), true);
  await settle();

  expect(controller).toHaveBeenCalledTimes(1);
});

it("frees a spent recovery only for a strictly older elected read", async () => {
  const { state, election } = createHost();
  const controller = vi.fn(() => {
    state.latest += 1;
    state.manualReads.add(state.latest);
  });
  election.addController(controller);
  readyWaiter(election);
  await settle();
  const elected = state.latest;

  // A sweep at the elected read's own id must not hand the recovery back to
  // itself, so a waiter arriving after it is told there is nothing left.
  election.expireRecoveryBefore(elected);
  state.manualReads.clear();
  const stillSpent = readyWaiter(election, elected);
  await settle();
  expect(controller).toHaveBeenCalledTimes(1);
  expect(String(stillSpent.seen.error)).toMatch(/No parent read controller/);

  // Another authoritative controller takes ownership at a newer request:
  // the spent recovery becomes reusable.
  state.latest = elected + 1;
  election.expireRecoveryBefore(state.latest);
  readyWaiter(election, state.latest);
  await settle();
  expect(controller).toHaveBeenCalledTimes(2);
});

it("an abandoned read that was not the newest changes nothing", async () => {
  const { state, election } = createHost();
  const controller = vi.fn();
  election.addController(controller);
  const waiter = readyWaiter(election);
  state.manualReads.add(1);

  election.noteReadAbandoned(1, new Error("superseded"), false);
  await settle();

  expect(controller).not.toHaveBeenCalled();
  expect(waiter.seen.error).toBeUndefined();
});

it("releasing a handle drops its waiters and leaves the others", async () => {
  const { election } = createHost();
  const leaving = Symbol("leaving");
  const staying = Symbol("staying");
  const dropped = watch(election.awaitPayload(leaving, token(1)).promise);
  const kept = watch(election.awaitPayload(staying, token(1)).promise);

  election.releaseWaiters(leaving);
  await settle();

  expect(dropped.seen).toEqual({ value: undefined, error: undefined });
  expect(String(kept.seen.error)).toMatch(/No parent read controller/);
});

it("a released readiness is neither resolved nor rejected", async () => {
  const { election } = createHost();
  const waiter = readyWaiter(election);
  waiter.readiness.release();
  waiter.readiness.release();
  await settle();
  election.publish(token(9), pagePayload("Elected", []));
  await settle();

  expect(waiter.seen).toEqual({ value: undefined, error: undefined });
});

it("removing the last controller re-runs the election", async () => {
  const { state, election } = createHost();
  const removeController = election.addController(() => {
    state.latest += 1;
    state.manualReads.add(state.latest);
  });
  const waiter = readyWaiter(election);
  await settle();
  expect(waiter.seen.error).toBeUndefined();

  state.manualReads.clear();
  removeController();
  removeController();
  await settle();

  expect(String(waiter.seen.error)).toMatch(/No parent read controller/);
});

it("a published payload clears the failure a later waiter would inherit", async () => {
  const { election } = createHost();
  const failed = readyWaiter(election);
  await settle();
  expect(String(failed.seen.error)).toMatch(/No parent read controller/);

  election.publish(token(2), pagePayload("Elected", []));
  const later = readyWaiter(election, 3);
  await settle();

  expect(String(later.seen.error)).toMatch(/No parent read controller/);
  expect(String(later.seen.error)).not.toMatch(/undefined/);
});
