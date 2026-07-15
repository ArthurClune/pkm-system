import { expect, it, vi } from "vitest";
import type { DeliveryOutcome, WriteOutcome } from "../sync/opQueue";
import { block } from "../test-helpers";
import { acquireOutlineSession, repairActiveOutlineSessions,
         trackActiveOutlineWrite } from "./outlineSessions";

const update = (text: string) => ({
  op: "update_text" as const, uid: "u1", text,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("shares each flushed tree with every handle of a title", () => {
  const first = acquireOutlineSession("Shared", [block("u1", "initial")]);
  const second = acquireOutlineSession("Shared", [block("other", "ignored")]);
  const onSecondChange = vi.fn();
  const unsubscribe = second.subscribe(onSecondChange);

  first.applyOptimistic([block("u1", "optimistic")]);

  expect(first.getSnapshot().blocks[0].text).toBe("optimistic");
  expect(second.getSnapshot()).toEqual(first.getSnapshot());
  expect(onSecondChange).toHaveBeenCalledTimes(1);
  unsubscribe();
  first.release();
  second.release();
});

it("grants one editor and hands ownership to the next live claimant", () => {
  const first = acquireOutlineSession("Lease", []);
  const second = acquireOutlineSession("Lease", []);
  const firstLease = first.claimEditor(Symbol("first"));
  const secondLease = second.claimEditor(Symbol("second"));
  const onHandoff = vi.fn();
  secondLease.subscribe(onHandoff);

  expect(firstLease.granted).toBe(true);
  expect(secondLease.granted).toBe(false);

  firstLease.release();

  expect(firstLease.granted).toBe(false);
  expect(secondLease.granted).toBe(true);
  expect(onHandoff).toHaveBeenCalledTimes(1);
  first.release();
  second.release();
});

it("lease and handle cleanup are idempotent and skip abandoned claimants", () => {
  const first = acquireOutlineSession("Cleanup", []);
  const abandoned = acquireOutlineSession("Cleanup", []);
  const remaining = acquireOutlineSession("Cleanup", []);
  const firstLease = first.claimEditor(Symbol("first"));
  const abandonedLease = abandoned.claimEditor(Symbol("abandoned"));
  const remainingLease = remaining.claimEditor(Symbol("remaining"));

  abandonedLease.release();
  abandonedLease.release();
  abandoned.release();
  abandoned.release();
  first.release();
  first.release();

  expect(firstLease.granted).toBe(false);
  expect(remainingLease.granted).toBe(true);
  remaining.release();
});

it("deletes a released session so a later mount gets a fresh bootstrap", () => {
  const old = acquireOutlineSession("Fresh", [block("old", "old")]);
  old.release();

  const fresh = acquireOutlineSession("Fresh", [block("new", "new")]);

  expect(fresh.getSnapshot().blocks.map((node) => node.uid)).toEqual(["new"]);
  fresh.release();
});

it("retains delivery causality across release and reacquire", async () => {
  const delivered = deferred<DeliveryOutcome>();
  const first = acquireOutlineSession("Pinned write", [block("u1", "old")]);
  first.applyLocal({
    id: "slow-write", scope: ["page", "Pinned write"],
    settled: Promise.resolve({ status: "persisted", pending: 1 }),
    delivered: delivered.promise,
  }, [update("local")]);
  first.release();

  const reopened = acquireOutlineSession(
    "Pinned write", [block("u1", "stale bootstrap")],
  );
  expect(reopened.getSnapshot().blocks[0].text).toBe("local");

  delivered.resolve({ status: "delivered" });
  await delivered.promise;
  await Promise.resolve();
  reopened.release();

  const fresh = acquireOutlineSession(
    "Pinned write", [block("u1", "fresh bootstrap")],
  );
  expect(fresh.getSnapshot().blocks[0].text).toBe("fresh bootstrap");
  fresh.release();
});

it("retains an authoritative read across release and reacquire", async () => {
  const response = deferred<ReturnType<typeof block>[]>();
  const first = acquireOutlineSession(
    "Pinned read", [block("u1", "before read")],
  );
  const reading = first.requestAuthoritative(() => response.promise);
  first.release();

  const reopened = acquireOutlineSession(
    "Pinned read", [block("u1", "stale bootstrap")],
  );
  expect(reopened.getSnapshot().blocks[0].text).toBe("before read");

  response.resolve([block("u1", "read result")]);
  await reading;
  expect(reopened.getSnapshot().blocks[0].text).toBe("read result");
  reopened.release();

  const fresh = acquireOutlineSession(
    "Pinned read", [block("u1", "fresh bootstrap")],
  );
  expect(fresh.getSnapshot().blocks[0].text).toBe("fresh bootstrap");
  fresh.release();
});

it("pins a token-based authoritative read across release and reacquire", () => {
  const first = acquireOutlineSession(
    "Pinned manual read", [block("u1", "before read")],
  );
  const token = first.beginAuthoritativeRead("parent");
  first.release();

  const reopened = acquireOutlineSession(
    "Pinned manual read", [block("u1", "stale bootstrap")],
  );
  expect(reopened.getSnapshot().blocks[0].text).toBe("before read");

  first.receiveAuthoritative(token, [block("u1", "read result")]);
  expect(reopened.getSnapshot().blocks[0].text).toBe("read result");
  reopened.release();
});

it("cancels a failed token-based read so the session can be collected", () => {
  const first = acquireOutlineSession(
    "Cancelled manual read", [block("u1", "before read")],
  );
  const token = first.beginAuthoritativeRead("parent");
  first.cancelAuthoritativeRead(token);
  first.release();

  const fresh = acquireOutlineSession(
    "Cancelled manual read", [block("u1", "fresh bootstrap")],
  );
  expect(fresh.getSnapshot().blocks[0].text).toBe("fresh bootstrap");
  first.receiveAuthoritative(token, [block("u1", "late result")]);
  expect(fresh.getSnapshot().blocks[0].text).toBe("fresh bootstrap");
  fresh.release();
});

it("coalesces overlapping authoritative reads and publishes their tree once", async () => {
  const first = acquireOutlineSession("Authoritative", [block("old", "old")]);
  const second = acquireOutlineSession("Authoritative", [block("old", "old")]);
  let resolve!: (blocks: ReturnType<typeof block>[]) => void;
  const response = new Promise<ReturnType<typeof block>[]>((done) => {
    resolve = done;
  });
  const load = vi.fn(() => response);
  const duplicateLoad = vi.fn(() => Promise.resolve([block("wrong", "wrong")]));
  const onChange = vi.fn();
  second.subscribe(onChange);

  const firstRead = first.requestAuthoritative(load);
  const secondRead = second.requestAuthoritative(duplicateLoad);
  resolve([block("new", "new")]);
  await Promise.all([firstRead, secondRead]);

  expect(load).toHaveBeenCalledTimes(1);
  expect(duplicateLoad).not.toHaveBeenCalled();
  expect(second.getSnapshot().blocks.map((node) => node.uid)).toEqual(["new"]);
  expect(onChange).toHaveBeenCalledTimes(1);
  first.release();
  second.release();
});

it("routes a cross-page ticket to source and fallback target but not another title", async () => {
  const source = acquireOutlineSession("Source", [block("s", "old source")]);
  const target = acquireOutlineSession("Target", [block("t", "old target")]);
  const other = acquireOutlineSession("Other", [block("o", "old other")]);
  const loadSource = vi.fn(async () => [block("s", "new source")]);
  const loadTarget = vi.fn(async () => [block("t", "new target")]);
  const removeSourceLoader = source.setAuthoritativeLoader(loadSource);
  const removeTargetLoader = target.setAuthoritativeLoader(loadTarget);
  const settled = deferred<WriteOutcome>();
  const delivered = deferred<DeliveryOutcome>();
  trackActiveOutlineWrite({
    id: "cross-page", scope: ["page", "Source", "Target"],
    settled: settled.promise, delivered: delivered.promise,
  });
  const sourceToken = source.beginAuthoritativeRead("parent");
  const targetToken = target.beginAuthoritativeRead("parent");
  const otherToken = other.beginAuthoritativeRead("parent");

  source.receiveAuthoritative(sourceToken, [block("s", "new source")]);
  target.receiveAuthoritative(targetToken, [block("t", "new target")]);
  other.receiveAuthoritative(otherToken, [block("o", "new other")]);

  expect(source.getSnapshot().blocks[0].text).toBe("old source");
  expect(target.getSnapshot().blocks[0].text).toBe("old target");
  expect(other.getSnapshot().blocks[0].text).toBe("new other");

  settled.resolve({ status: "persisted", pending: 0 });
  delivered.resolve({ status: "delivered" });
  await settled.promise;
  await vi.waitFor(() => {
    expect(loadSource).toHaveBeenCalledTimes(1);
    expect(loadTarget).toHaveBeenCalledTimes(1);
  });

  expect(source.getSnapshot().blocks[0].text).toBe("new source");
  expect(target.getSnapshot().blocks[0].text).toBe("new target");
  removeSourceLoader();
  removeTargetLoader();
  source.release();
  target.release();
  other.release();
});

it("attaches an unresolved scoped ticket when its target session opens later", async () => {
  const delivered = deferred<DeliveryOutcome>();
  trackActiveOutlineWrite({
    id: "move-to-closed-target", scope: ["page", "Source", "Late target"],
    settled: Promise.resolve({ status: "persisted", pending: 1 }),
    delivered: delivered.promise,
  });

  const target = acquireOutlineSession(
    "Late target", [block("u1", "opened optimistic target")],
  );
  const loadTarget = vi.fn(async () => [block("u1", "post-delivery target")]);
  const removeLoader = target.setAuthoritativeLoader(loadTarget);
  const staleToken = target.beginAuthoritativeRead("cross-page-move");
  target.receiveAuthoritative(staleToken, [block("u1", "pre-POST target")]);

  expect(target.getSnapshot().blocks[0].text).toBe("opened optimistic target");
  expect(loadTarget).not.toHaveBeenCalled();

  delivered.resolve({ status: "delivered" });
  await vi.waitFor(() => expect(loadTarget).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => {
    expect(target.getSnapshot().blocks[0].text).toBe("post-delivery target");
  });

  removeLoader();
  target.release();
});

it("waits for active session loaders at the legacy repair boundary", async () => {
  const response = deferred<ReturnType<typeof block>[]>();
  const session = acquireOutlineSession(
    "Legacy repair", [block("u1", "optimistic")],
  );
  const load = vi.fn(() => response.promise);
  const removeLoader = session.setAuthoritativeLoader(load);

  const repairing = repairActiveOutlineSessions();
  let repaired = false;
  void repairing.then(() => { repaired = true; });
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(1);
  expect(repaired).toBe(false);

  response.resolve([block("u1", "authoritative")]);
  await repairing;
  expect(session.getSnapshot().blocks[0].text).toBe("authoritative");

  removeLoader();
  session.release();
});
