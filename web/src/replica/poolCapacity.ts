// pattern: Functional Core
// Keeping the replica's OPFS SAH pool big enough to write (pkm-ndcu).
//
// sqlite-wasm's opfs-sahpool VFS is a FIXED pool of pre-opened OPFS files:
// every file SQLite keeps in it — the database AND its rollback journal —
// must claim one slot (temp files stay in memory in this build, see
// MIN_POOL_CAPACITY). `installOpfsSAHPoolVfs` sizes that pool
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

export const REPLICA_FILE = "/pkm-replica.sqlite3";
/** The pending queue's durable copy while a damaged replica file is
 * replaced (see carryStore.ts). */
export const CARRY_FILE = "/pkm-replica-carry.sqlite3";
export const journalOf = (file: string): string => `${file}-journal`;

/** What the pool holds at once at the peak of a file replacement: the carry
 * and its journal are written while the damaged replica, and any journal a
 * killed worker left beside it, are still there. */
export const PEAK_POOL_FILES: readonly string[] = [
  REPLICA_FILE, journalOf(REPLICA_FILE), CARRY_FILE, journalOf(CARRY_FILE),
];

/** The pool size sqlite-wasm itself defaults to. Every persistent file, open
 * or not, claims a slot until it is unlinked. A rollback journal lives while
 * a write transaction is open; one a worker killed mid-write left lives until
 * the next open of its database plays it back. PEAK_POOL_FILES counts both
 * journals, so the peak never depends on that timing. This build keeps temp
 * files in memory (SQLITE_TEMP_STORE=2), so they claim none. Six slots
 * therefore cover PEAK_POOL_FILES with two to spare. */
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
