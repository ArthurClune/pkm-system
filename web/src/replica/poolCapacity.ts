// pattern: Functional Core
// Keeping the replica's OPFS SAH pool big enough to write (pkm-ndcu).
//
// sqlite-wasm's opfs-sahpool VFS is a FIXED pool of pre-opened OPFS files:
// every file SQLite opens — the database AND its rollback journal and any
// temp file — must claim one slot. `installOpfsSAHPoolVfs` sizes that pool
// from whatever it finds in its opaque directory, and only falls back to
// `initialCapacity` (6) when it finds nothing at all:
//
//     isReady = reset().then(() =>
//       this.getCapacity() ? undefined : this.addCapacity(initialCapacity))
//
// So when a freshly spawned worker enumerates that directory while a sibling
// worker (the page it is replacing, mid-navigation) is still creating the
// pool files, it can legitimately succeed with a capacity of ONE. Opening
// /pkm-replica.sqlite3 then consumes the only slot, and the very first write
// transaction has nowhere to put its rollback journal:
//
//     xOpen: ... if (pool.getFileCount() < pool.getCapacity()) { ... }
//            else toss("SAH pool is full. Cannot create file", path)
//            catch (e) { return capi.SQLITE_CANTOPEN; }
//
// which surfaces to the caller as "SQLITE_CANTOPEN: sqlite3 result code 14:
// unable to open database file" — on EVERY write, for the life of that
// worker, because nothing grows the pool afterwards. Reads keep working, so
// the failure is invisible until the first edit.
//
// Topping the pool up straight after install closes that window. addCapacity
// creates fresh randomly-named files, so it never contends with handles the
// outgoing worker still holds.

/** The pool size sqlite-wasm itself defaults to. One slot holds the database,
 * the rest cover the rollback journal and temp files. */
export const MIN_POOL_CAPACITY = 6;

/** The slice of sqlite-wasm's pool-utility object this needs. */
export interface CapacityPool {
  getCapacity(): number;
  addCapacity(n: number): Promise<number>;
}

/** Grow `pool` to at least `min` slots, and resolve to its capacity. A
 * failure to grow is propagated rather than swallowed: the caller's open
 * retry can absorb transient OPFS contention, and a persistent failure must
 * fail the open so the app degrades to online-only rather than running on a
 * replica whose every write would throw. */
export async function ensureMinimumCapacity(
  pool: CapacityPool,
  min: number = MIN_POOL_CAPACITY,
): Promise<number> {
  const capacity = pool.getCapacity();
  return capacity >= min ? capacity : pool.addCapacity(min - capacity);
}

// The classifier that used to recognise this failure at the far end of the RPC
// is gone (pkm-s7af): the op queue retains every replica failure except one the
// replica reports as a rejection of the op, so a SQLITE_CANTOPEN write no
// longer needs identifying by message to survive.
