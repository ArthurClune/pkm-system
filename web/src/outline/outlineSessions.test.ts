import { expect, it, vi } from "vitest";
import type { DeliveryOutcome, WriteOutcome, WriteTicket } from "../sync/opQueue";
import { block } from "../test-helpers";
import { acquireOutlineSession, attachActiveOutlineWriteReplay,
         isOutlineSessionActive,
         peekOutlineSession,
         repairActiveOutlineSessions,
         trackActiveOutlineWrite } from "./outlineSessions";
import { findNode, insertSubtree, removeSubtree } from "./tree";

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

it("invalidates an automatic read at final delivery settlement before replacing it once", async () => {
  const delivered = deferred<DeliveryOutcome>();
  const stale = deferred<ReturnType<typeof block>[]>();
  const fresh = deferred<ReturnType<typeof block>[]>();
  const responses = [stale.promise, fresh.promise];
  const load = vi.fn(() => responses.shift()!);
  const session = acquireOutlineSession(
    "Settlement supersedes", [block("u1", "old")],
  );
  const removeLoader = session.setAuthoritativeLoader("editable", load);
  const published: string[] = [];
  session.subscribe(() => {
    published.push(session.getSnapshot().blocks[0]?.text ?? "empty");
  });
  session.applyLocal({
    id: "settling", scope: ["page", "Settlement supersedes"],
    settled: Promise.resolve({ status: "persisted", pending: 1 }),
    delivered: delivered.promise,
  }, [update("local")]);
  const firstRead = session.requestAuthoritative(load);
  expect(load).toHaveBeenCalledTimes(1);

  delivered.resolve({ status: "delivered" });
  await delivered.promise;
  await Promise.resolve();
  stale.resolve([block("u1", "stale pre-POST")]);
  await firstRead;
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));

  expect(session.getSnapshot().blocks[0].text).toBe("local");
  expect(published).not.toContain("stale pre-POST");
  fresh.resolve([block("u1", "fresh post-POST")]);
  await vi.waitFor(() => {
    expect(session.getSnapshot().blocks[0].text).toBe("fresh post-POST");
  });
  expect(load).toHaveBeenCalledTimes(2);

  removeLoader();
  session.release();
});

it("a newer manual read expires an older handle reservation", () => {
  const first = acquireOutlineSession(
    "Manual supersession", [block("u1", "old")],
  );
  const second = acquireOutlineSession("Manual supersession", null);
  const oldToken = first.beginAuthoritativeRead("parent");
  const newToken = second.beginAuthoritativeRead("resync");
  second.receiveAuthoritative(newToken, [block("u1", "new")]);
  first.release();
  second.release();

  expect(isOutlineSessionActive("Manual supersession")).toBe(false);
  const fresh = acquireOutlineSession(
    "Manual supersession", [block("u1", "fresh bootstrap")],
  );
  first.receiveAuthoritative(oldToken, [block("u1", "late old")]);
  first.cancelAuthoritativeRead(oldToken);
  expect(fresh.getSnapshot().blocks[0].text).toBe("fresh bootstrap");
  fresh.release();
});

it("an expired unbootstrapped parent cannot reset the newer manual read", () => {
  const title = "Overlapping empty parents";
  const older = acquireOutlineSession(title, null);
  const newer = acquireOutlineSession(title, null);
  const olderToken = older.beginAuthoritativeRead("parent");
  const newerToken = newer.beginAuthoritativeRead("parent");

  const olderAccepted = older.receiveAuthoritative(
    olderToken, [block("old", "expired")],
  );
  const child = acquireOutlineSession(title, []);
  const newerAccepted = newer.receiveAuthoritative(
    newerToken, [block("new", "newer response")],
  );
  const observed = {
    olderAccepted,
    newerAccepted,
    blocks: child.getSnapshot().blocks.map((node) => node.text),
  };

  child.release();
  newer.release();
  older.release();

  expect(observed).toEqual({
    olderAccepted: false,
    newerAccepted: true,
    blocks: ["newer response"],
  });
  expect(isOutlineSessionActive(title)).toBe(false);
});

it("an existing-session bootstrap cannot overwrite an unresolved local write", async () => {
  const title = "Unbootstrapped relevant write";
  const delivered = deferred<DeliveryOutcome>();
  const session = acquireOutlineSession(title, null);
  session.applyLocal({
    id: "unresolved-create", scope: ["page", title],
    settled: Promise.resolve({ status: "persisted", pending: 1 }),
    delivered: delivered.promise,
  }, [{
    op: "create", uid: "local", page_title: title,
    parent_uid: null, order_idx: 0, text: "local write",
  }]);

  const child = acquireOutlineSession(title, [block("stale", "stale bootstrap")]);
  const observed = child.getSnapshot().blocks.map((node) => node.text);

  delivered.resolve({ status: "delivered" });
  await delivered.promise;
  await Promise.resolve();
  child.release();
  session.release();

  expect(observed).toEqual(["local write"]);
  expect(isOutlineSessionActive(title)).toBe(false);
});

it("a genuine later bootstrap preserves monotonic manual request ids", () => {
  const title = "Bootstrap request identity";
  const first = acquireOutlineSession(title, null);
  const cancelled = first.beginAuthoritativeRead("parent");
  first.cancelAuthoritativeRead(cancelled);
  const bootstrapped = acquireOutlineSession(
    title, [block("server", "genuine bootstrap")],
  );
  const next = bootstrapped.beginAuthoritativeRead("parent");
  const observed = {
    text: bootstrapped.getSnapshot().blocks[0]?.text,
    cancelledRequestId: cancelled.requestId,
    nextRequestId: next.requestId,
  };

  bootstrapped.cancelAuthoritativeRead(next);
  bootstrapped.release();
  first.release();

  expect(observed.text).toBe("genuine bootstrap");
  expect(observed.nextRequestId).toBeGreaterThan(observed.cancelledRequestId);
  expect(isOutlineSessionActive(title)).toBe(false);
});

it("an automatic read expires an older manual reservation", async () => {
  const session = acquireOutlineSession(
    "Automatic supersession", [block("u1", "old")],
  );
  const oldToken = session.beginAuthoritativeRead("parent");
  await session.requestAuthoritative(async () => [block("u1", "automatic")]);
  session.release();

  expect(isOutlineSessionActive("Automatic supersession")).toBe(false);
  const fresh = acquireOutlineSession(
    "Automatic supersession", [block("u1", "fresh bootstrap")],
  );
  session.receiveAuthoritative(oldToken, [block("u1", "late old")]);
  session.cancelAuthoritativeRead(oldToken);
  expect(fresh.getSnapshot().blocks[0].text).toBe("fresh bootstrap");
  fresh.release();
});

it("routes a cross-page ticket to source and fallback target but not another title", async () => {
  const source = acquireOutlineSession("Source", [block("s", "old source")]);
  const target = acquireOutlineSession("Target", [block("t", "old target")]);
  const other = acquireOutlineSession("Other", [block("o", "old other")]);
  const loadSource = vi.fn(async () => [block("s", "new source")]);
  const loadTarget = vi.fn(async () => [block("t", "new target")]);
  const removeSourceLoader = source.setAuthoritativeLoader("editable", loadSource);
  const removeTargetLoader = target.setAuthoritativeLoader("editable", loadTarget);
  const settled = deferred<WriteOutcome>();
  const delivered = deferred<DeliveryOutcome>();
  trackActiveOutlineWrite({
    id: "cross-page", scope: ["page", "Source", "Target"],
    settled: settled.promise, delivered: delivered.promise,
  }, []);
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
  }, []);

  const target = acquireOutlineSession(
    "Late target", [block("u1", "opened optimistic target")],
  );
  const loadTarget = vi.fn(async () => [block("u1", "post-delivery target")]);
  const removeLoader = target.setAuthoritativeLoader("editable", loadTarget);
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
  const removeLoader = session.setAuthoritativeLoader("editable", load);

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

it("legacy repair supersedes and awaits an existing automatic read", async () => {
  const stale = deferred<ReturnType<typeof block>[]>();
  const forced = deferred<ReturnType<typeof block>[]>();
  const session = acquireOutlineSession(
    "Forced after existing", [block("u1", "optimistic")],
  );
  const loadForced = vi.fn(() => forced.promise);
  const removeLoader = session.setAuthoritativeLoader("editable", loadForced);
  const existing = session.requestAuthoritative(() => stale.promise);

  const repairing = repairActiveOutlineSessions();
  let repaired = false;
  void repairing.then(() => { repaired = true; });
  stale.resolve([block("u1", "stale existing")]);
  await existing;
  await Promise.resolve();

  expect(repaired).toBe(false);
  expect(session.getSnapshot().blocks[0].text).toBe("optimistic");
  await vi.waitFor(() => expect(loadForced).toHaveBeenCalledTimes(1));

  forced.resolve([block("u1", "forced authoritative")]);
  await repairing;
  expect(session.getSnapshot().blocks[0].text).toBe("forced authoritative");
  removeLoader();
  session.release();
});

it("legacy repair adopts server state and reapplies a wholly later ticket", async () => {
  const rejected = deferred<DeliveryOutcome>();
  const later = deferred<DeliveryOutcome>();
  const session = acquireOutlineSession("Repair rebase", [
    block("u1", "old"), block("u2", "old other", { order_idx: 1 }),
  ]);
  session.applyLocal({
    id: "rejected", scope: ["page", "Repair rebase"],
    settled: Promise.resolve({ status: "persisted", pending: 2 }),
    delivered: rejected.promise,
  }, [{ op: "update_text", uid: "u2", text: "rejected local" }]);
  session.applyLocal({
    id: "later", scope: ["page", "Repair rebase"],
    settled: Promise.resolve({ status: "persisted", pending: 2 }),
    delivered: later.promise,
  }, [{ op: "update_text", uid: "u1", text: "later local" }]);
  const load = vi.fn(async () => load.mock.calls.length === 1 ? [
    block("u1", "server before later"),
    block("u2", "server repaired", { order_idx: 1 }),
  ] : [
    block("u1", "later local"),
    block("u2", "server repaired", { order_idx: 1 }),
  ]);
  const removeLoader = session.setAuthoritativeLoader("editable", load);

  rejected.resolve({ status: "failed", error: new Error("rejected") });
  await rejected.promise;
  await Promise.resolve();
  await repairActiveOutlineSessions();

  expect(session.getSnapshot().blocks.map((node) => node.text)).toEqual([
    "later local", "server repaired",
  ]);
  expect(load).toHaveBeenCalledTimes(1);

  later.resolve({ status: "delivered" });
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  removeLoader();
  session.release();
});

it("legacy repair rejects when an active session has no loader", async () => {
  const session = acquireOutlineSession(
    "Missing repair loader", [block("u1", "optimistic")],
  );
  try {
    await expect(repairActiveOutlineSessions()).rejects.toThrow(
      /authoritative loader.*Missing repair loader/i,
    );
  } finally {
    session.release();
  }
});

it("keeps repair pending when a remote revision advances during its GET", async () => {
  const stale = deferred<ReturnType<typeof block>[]>();
  const fresh = deferred<ReturnType<typeof block>[]>();
  const responses = [stale.promise, fresh.promise];
  const session = acquireOutlineSession(
    "Repair remote advance", [block("u1", "before repair")],
  );
  const load = vi.fn(() => responses.shift()!);
  const removeLoader = session.setAuthoritativeLoader("editable", load);
  const repairing = repairActiveOutlineSessions();
  try {
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    session.applyRemote({
      client_id: "remote", ts: 1, ops: [update("remote advance")],
    });

    stale.resolve([block("u1", "stale forced response")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(session.getSnapshot().blocks[0].text).toBe("remote advance");
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    let repaired = false;
    void repairing.then(() => { repaired = true; });
    await Promise.resolve();
    expect(repaired).toBe(false);
    fresh.resolve([block("u1", "fresh forced response")]);
    await repairing;
    expect(session.getSnapshot().blocks[0].text).toBe("fresh forced response");
  } finally {
    stale.resolve([block("u1", "cleanup stale")]);
    fresh.resolve([block("u1", "cleanup fresh")]);
    await repairing.catch(() => undefined);
    removeLoader();
    session.release();
  }
});

it("enrolls sessions acquired during a repair and ignores released newcomers", async () => {
  const firstResponse = deferred<ReturnType<typeof block>[]>();
  const secondResponse = deferred<ReturnType<typeof block>[]>();
  const first = acquireOutlineSession("Repair cohort first", [
    block("u1", "first optimistic"),
  ]);
  const firstLoad = vi.fn(() => firstResponse.promise);
  const removeFirstLoader = first.setAuthoritativeLoader("editable", firstLoad);
  const repairing = repairActiveOutlineSessions();
  let second: ReturnType<typeof acquireOutlineSession> | undefined;
  let removeSecondLoader: (() => void) | undefined;
  try {
    await vi.waitFor(() => expect(firstLoad).toHaveBeenCalledTimes(1));
    second = acquireOutlineSession("Repair cohort second", [
      block("u2", "second optimistic"),
    ]);
    const secondLoad = vi.fn(() => secondResponse.promise);
    removeSecondLoader = second.setAuthoritativeLoader("editable", secondLoad);
    const released = acquireOutlineSession("Repair cohort released", [
      block("gone", "released immediately"),
    ]);
    released.release();

    firstResponse.resolve([block("u1", "first repaired")]);
    await vi.waitFor(() => expect(secondLoad).toHaveBeenCalledTimes(1));
    let repaired = false;
    void repairing.then(() => { repaired = true; });
    await Promise.resolve();
    expect(repaired).toBe(false);

    secondResponse.resolve([block("u2", "second repaired")]);
    await repairing;
    expect(first.getSnapshot().blocks[0].text).toBe("first repaired");
    expect(second.getSnapshot().blocks[0].text).toBe("second repaired");
    expect(isOutlineSessionActive("Repair cohort released")).toBe(false);
  } finally {
    firstResponse.resolve([block("u1", "cleanup first")]);
    secondResponse.resolve([block("u2", "cleanup second")]);
    await repairing.catch(() => undefined);
    removeSecondLoader?.();
    second?.release();
    removeFirstLoader();
    first.release();
  }
});

it("reports a missing loader for a live session that joins a repair", async () => {
  const firstResponse = deferred<ReturnType<typeof block>[]>();
  const first = acquireOutlineSession("Repair loader first", [
    block("u1", "first optimistic"),
  ]);
  const removeLoader = first.setAuthoritativeLoader(
    "editable", vi.fn(() => firstResponse.promise),
  );
  const repairing = repairActiveOutlineSessions();
  let missing: ReturnType<typeof acquireOutlineSession> | undefined;
  try {
    await Promise.resolve();
    missing = acquireOutlineSession("Repair loader late missing", [
      block("u2", "late optimistic"),
    ]);
    firstResponse.resolve([block("u1", "first repaired")]);
    await expect(repairing).rejects.toThrow(
      /authoritative loader.*Repair loader late missing/i,
    );
  } finally {
    firstResponse.resolve([block("u1", "cleanup first")]);
    await repairing.catch(() => undefined);
    missing?.release();
    removeLoader();
    first.release();
  }
});

it("rebases a cross-page target subtree and later ticket in ticket order", async () => {
  const rejectedDelivery = deferred<DeliveryOutcome>();
  const moveDelivery = deferred<DeliveryOutcome>();
  const editDelivery = deferred<DeliveryOutcome>();
  const moved = block("moved", "moved", {
    children: [block("child", "child")],
  });
  const source = acquireOutlineSession("Replay source", [
    block("source-root", "source", { children: [moved] }),
  ]);
  const target = acquireOutlineSession("Replay target", [
    block("target-root", "target", { children: [] }),
  ]);
  source.applyLocal({
    id: "rejected-before-move", scope: ["page", "Replay source"],
    settled: Promise.resolve({ status: "persisted", pending: 3 }),
    delivered: rejectedDelivery.promise,
  }, [{ op: "update_text", uid: "source-root", text: "rejected text" }]);

  const detached = removeSubtree(source.getSnapshot().blocks, "moved");
  source.applyOptimistic(detached.tree);
  target.applyOptimistic(insertSubtree(
    target.getSnapshot().blocks, detached.node!, "target-root", 0,
  ));
  const move = {
    id: "later-cross-page-move",
    scope: ["page", "Replay source", "Replay target"],
    settled: Promise.resolve({ status: "persisted", pending: 3 }),
    delivered: moveDelivery.promise,
  } satisfies WriteTicket;
  const moveOps = [{
    op: "move" as const, uid: "moved", parent_uid: "target-root",
    order_idx: 0, page_title: "Replay target",
  }];
  trackActiveOutlineWrite(move, moveOps);
  attachActiveOutlineWriteReplay(move, "Replay target", [{
    type: "insert-subtree", node: detached.node!,
    parentUid: "target-root", orderIdx: 0,
  }]);
  target.applyLocal({
    id: "later-child-edit", scope: ["page", "Replay target"],
    settled: Promise.resolve({ status: "persisted", pending: 3 }),
    delivered: editDelivery.promise,
  }, [{ op: "update_text", uid: "child", text: "later child edit" }]);

  const removeSourceLoader = source.setAuthoritativeLoader("editable", async () => [
    block("source-root", "server repaired", { children: [moved] }),
  ]);
  const removeTargetLoader = target.setAuthoritativeLoader("editable", async () => [
    block("target-root", "target", { children: [] }),
  ]);
  try {
    rejectedDelivery.resolve({
      status: "failed", error: new Error("rejected before move"),
    });
    await rejectedDelivery.promise;
    await Promise.resolve();
    await repairActiveOutlineSessions();

    expect(source.getSnapshot().blocks[0].text).toBe("server repaired");
    expect(findNode(source.getSnapshot().blocks, "moved")).toBeNull();
    expect(findNode(target.getSnapshot().blocks, "moved")).toMatchObject({
      children: [expect.objectContaining({
        uid: "child", text: "later child edit",
      })],
    });
    expect(findNode(target.getSnapshot().blocks, "moved")?.order_idx).toBe(0);
  } finally {
    removeSourceLoader();
    removeTargetLoader();
    moveDelivery.resolve({ status: "delivered" });
    editDelivery.resolve({ status: "delivered" });
    await Promise.all([moveDelivery.promise, editDelivery.promise]);
    await Promise.resolve();
    source.release();
    target.release();
  }
});

// pkm-jk21: applyLocal records the write's replay itself and then hands the
// same ticket to write tracking. Tracking must announce that write with the
// ops it just applied, never with an empty replay, or a repair rebase drops
// the local edit for any ticket the delivery registry has not pre-tracked.
it("rebases a local write tracked only through applyLocal", async () => {
  const delivered = deferred<DeliveryOutcome>();
  const session = acquireOutlineSession("Self-tracked replay", [
    block("u1", "server"),
  ]);
  session.applyLocal({
    id: "self-tracked", scope: ["page", "Self-tracked replay"],
    settled: Promise.resolve({ status: "persisted", pending: 1 }),
    delivered: delivered.promise,
  }, [update("local edit")]);
  const removeLoader = session.setAuthoritativeLoader(
    "editable", async () => [block("u1", "server")],
  );
  try {
    await repairActiveOutlineSessions();

    expect(session.getSnapshot().blocks[0].text).toBe("local edit");
  } finally {
    removeLoader();
    delivered.resolve({ status: "delivered" });
    await delivered.promise;
    await Promise.resolve();
    session.release();
  }
});

/** Settle a write on `title` so its settlement effect asks the session for an
 * authoritative read — the production path that elects a registered loader. */
async function settleWriteOn(
  session: ReturnType<typeof acquireOutlineSession>,
  title: string,
  id: string,
): Promise<void> {
  const delivered = deferred<DeliveryOutcome>();
  session.applyLocal({
    id, scope: ["page", title],
    settled: Promise.resolve({ status: "persisted", pending: 1 }),
    delivered: delivered.promise,
  }, [update(`edit for ${id}`)]);
  delivered.resolve({ status: "delivered" });
  await delivered.promise;
  await Promise.resolve();
}

it("elects the page loader over an editable one whatever the mount order", async () => {
  const title = "Loader precedence";
  const pageLoad = vi.fn(async () => [block("u1", "page loader")]);
  const editableLoad = vi.fn(async () => [block("u1", "editable loader")]);
  const first = acquireOutlineSession(title, [block("u1", "old")]);
  const second = acquireOutlineSession(title, null);
  const removePage = first.setAuthoritativeLoader("page", pageLoad);
  // Registered last, so "last mounted wins" would have elected this one.
  const removeEditable = second.setAuthoritativeLoader(
    "editable", editableLoad,
  );

  await settleWriteOn(first, title, "precedence-write");

  await vi.waitFor(() => expect(pageLoad).toHaveBeenCalledTimes(1));
  expect(editableLoad).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(first.getSnapshot().blocks[0].text).toBe("page loader");
  });
  removeEditable();
  removePage();
  second.release();
  first.release();
});

it("falls back through day to editable as higher-precedence loaders go away", async () => {
  const title = "Loader fallback";
  const dayLoad = vi.fn(async () => [block("u1", "day loader")]);
  const editableLoad = vi.fn(async () => [block("u1", "editable loader")]);
  const session = acquireOutlineSession(title, [block("u1", "old")]);
  const removeDay = session.setAuthoritativeLoader("day", dayLoad);
  // Registered after the day loader, so registration order would elect it.
  const removeEditable = session.setAuthoritativeLoader(
    "editable", editableLoad,
  );

  await settleWriteOn(session, title, "fallback-day");
  await vi.waitFor(() => expect(dayLoad).toHaveBeenCalledTimes(1));
  expect(editableLoad).not.toHaveBeenCalled();

  removeDay();
  await settleWriteOn(session, title, "fallback-editable");

  await vi.waitFor(() => expect(editableLoad).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => {
    expect(session.getSnapshot().blocks[0].text).toBe("editable loader");
  });
  removeEditable();
  session.release();
});

it("elects the newest loader of the winning kind", async () => {
  const title = "Loader same kind";
  const older = vi.fn(async () => [block("u1", "older page")]);
  const newer = vi.fn(async () => [block("u1", "newer page")]);
  const session = acquireOutlineSession(title, [block("u1", "old")]);
  const removeOlder = session.setAuthoritativeLoader("page", older);
  const removeNewer = session.setAuthoritativeLoader("page", newer);

  await settleWriteOn(session, title, "same-kind-write");

  await vi.waitFor(() => expect(newer).toHaveBeenCalledTimes(1));
  expect(older).not.toHaveBeenCalled();
  removeNewer();
  removeOlder();
  session.release();
});

it("repairs through the elected loader, not the last one registered", async () => {
  const title = "Repair precedence";
  const pageLoad = vi.fn(async () => [block("u1", "page repaired")]);
  const editableLoad = vi.fn(async () => [block("u1", "editable repaired")]);
  const session = acquireOutlineSession(title, [block("u1", "optimistic")]);
  const removePage = session.setAuthoritativeLoader("page", pageLoad);
  const removeEditable = session.setAuthoritativeLoader(
    "editable", editableLoad,
  );
  try {
    await repairActiveOutlineSessions();

    expect(pageLoad).toHaveBeenCalledTimes(1);
    expect(editableLoad).not.toHaveBeenCalled();
    expect(session.getSnapshot().blocks[0].text).toBe("page repaired");
  } finally {
    removeEditable();
    removePage();
    session.release();
  }
});

it("peekOutlineSession returns a handle only for live sessions", () => {
  expect(peekOutlineSession("Peek Test")).toBeNull();
  const handle = acquireOutlineSession("Peek Test", []);
  const peeked = peekOutlineSession("Peek Test");
  expect(peeked).not.toBeNull();
  expect(peeked!.getSnapshot()).toEqual(handle.getSnapshot());
  peeked!.release();
  handle.release();
  expect(peekOutlineSession("Peek Test")).toBeNull(); // released -> evicted
});
