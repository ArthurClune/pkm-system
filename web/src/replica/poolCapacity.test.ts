import { describe, expect, it, vi } from "vitest";
import { MIN_POOL_CAPACITY, ensureMinimumCapacity } from "./poolCapacity";

function fakePool(capacity: number, addCapacity = vi.fn(async (n: number) => {
  capacity += n;
  return capacity;
})) {
  return {
    getCapacity: () => capacity,
    addCapacity,
  };
}

describe("ensureMinimumCapacity", () => {
  it("leaves a healthy pool untouched", async () => {
    const add = vi.fn(async () => MIN_POOL_CAPACITY);
    const pool = fakePool(MIN_POOL_CAPACITY, add);
    await expect(ensureMinimumCapacity(pool)).resolves.toBe(MIN_POOL_CAPACITY);
    expect(add).not.toHaveBeenCalled();
  });

  it("tops a starved pool up to the minimum in one call", async () => {
    // The observed pkm-ndcu failure: installOpfsSAHPoolVfs raced a sibling
    // worker and returned a pool holding a single access handle. The database
    // file claims it, leaving no slot for SQLite's rollback journal, so every
    // write transaction fails with SQLITE_CANTOPEN.
    const add = vi.fn(async () => MIN_POOL_CAPACITY);
    const pool = fakePool(1, add);
    await expect(ensureMinimumCapacity(pool)).resolves.toBe(MIN_POOL_CAPACITY);
    expect(add).toHaveBeenCalledWith(MIN_POOL_CAPACITY - 1);
  });

  it("tops up an empty pool", async () => {
    const add = vi.fn(async () => MIN_POOL_CAPACITY);
    const pool = fakePool(0, add);
    await ensureMinimumCapacity(pool);
    expect(add).toHaveBeenCalledWith(MIN_POOL_CAPACITY);
  });

  it("honours an explicit minimum", async () => {
    const add = vi.fn(async () => 3);
    const pool = fakePool(2, add);
    await expect(ensureMinimumCapacity(pool, 3)).resolves.toBe(3);
    expect(add).toHaveBeenCalledWith(1);
  });

  it("propagates an addCapacity failure so the open can retry or degrade", async () => {
    const boom = new Error("Access Handles cannot be created");
    const pool = fakePool(1, vi.fn(async () => { throw boom; }));
    await expect(ensureMinimumCapacity(pool)).rejects.toBe(boom);
  });

  it("reserves room beyond the database file itself", () => {
    // One slot holds /pkm-replica.sqlite3; SQLite needs at least one more for
    // the rollback journal, and temp files can want more still.
    expect(MIN_POOL_CAPACITY).toBeGreaterThanOrEqual(2);
  });
});
