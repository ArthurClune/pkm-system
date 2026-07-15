import { expect, it, vi } from "vitest";
import type { DeliveryOutcome, WriteOutcome } from "../sync/opQueue";
import { block } from "../test-helpers";
import { acquireOutlineSession, trackActiveOutlineWrite } from "./outlineSessions";

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
  await Promise.resolve();

  expect(source.getSnapshot().blocks[0].text).toBe("new source");
  expect(target.getSnapshot().blocks[0].text).toBe("new target");
  source.release();
  target.release();
  other.release();
});
