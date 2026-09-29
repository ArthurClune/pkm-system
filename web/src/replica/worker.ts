/// <reference lib="webworker" />
// pattern: Imperative Shell
// The replica worker: owns the sqlite-wasm database on the opfs-sahpool
// VFS (no COOP/COEP needed — spec section 3) and serves the RPC surface.
// Browser-only glue, excluded from unit coverage; all logic lives in the
// modules it wires together (workerHandlers/apply/queue/localApi), which
// are tested against real sqlite-wasm in Node.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { type Oo1DbLike, type ReplicaDb, wrapSqlite } from "./db";
import { openWithRetry, SAH_POOL_INSTALL_OPTIONS } from "./openRetry";
import { type CarryFiles, createCarryStore } from "./carryStore";
import { CARRY_FILE, ensureMinimumCapacity, journalOf, REPLICA_FILE,
         type CapacityPool } from "./poolCapacity";
import { serveRpc, toPortLike } from "./rpc";
import { buildHandlers } from "./workerHandlers";

interface SahPoolOptions {
  name: string;
  /** Drop a memoised install failure instead of replaying it — see
   * SAH_POOL_INSTALL_OPTIONS. */
  forceReinitIfPreviouslyFailed: boolean;
}

interface PoolUtil extends CapacityPool {
  OpfsSAHPoolDb: new (filename: string) => Oo1DbLike & { close(): void };
  unlink(filename: string): boolean;
  /** The names of the files the pool holds, open or not. */
  getFileNames(): string[];
}

let sqlite3: {
  installOpfsSAHPoolVfs(opts: SahPoolOptions): Promise<PoolUtil>;
} | null = null;
let pool: PoolUtil | null = null;
let rawDb: (Oo1DbLike & { close(): void }) | null = null;

function pragmas(db: ReplicaDb): ReplicaDb {
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA recursive_triggers=ON");
  return db;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function openDb(): Promise<ReplicaDb> {
  sqlite3 ??= (await sqlite3InitModule()) as unknown as NonNullable<typeof sqlite3>;
  // A page reload/navigation can spawn this worker before the previous one
  // has released the OPFS SAH pool; retry through that transient contention
  // (pkm-c9hp) instead of surfacing it as a spurious "server rejected"
  // desync that wipes the active outline. The install options are what let a
  // retry be a real second attempt rather than a replay of the memoised
  // failure (pkm-wi25) — see SAH_POOL_INSTALL_OPTIONS.
  return openWithRetry(async () => {
    pool ??= await sqlite3!.installOpfsSAHPoolVfs({ ...SAH_POOL_INSTALL_OPTIONS });
    // The same navigation race can also let the install SUCCEED with a pool
    // too small to hold both the database and its rollback journal, which
    // makes every write fail with SQLITE_CANTOPEN forever (pkm-ndcu). Grow it
    // back before opening the database.
    await ensureMinimumCapacity(pool);
    rawDb = new pool.OpfsSAHPoolDb(REPLICA_FILE);
    return pragmas(wrapSqlite(rawDb));
  }, { sleep });
}

function closeDb(): void {
  rawDb?.close();
  rawDb = null;
}

function discardDbFile(): void {
  closeDb();
  // The journal too: it describes only this file, and every pool file,
  // open or not, claims a slot until it is unlinked.
  pool?.unlink(journalOf(REPLICA_FILE));
  pool?.unlink(REPLICA_FILE);
}

/** The carry as a second database in the same pool. Every carry call comes
 * from a handler that has already opened the replica, so the pool is
 * installed by then; the pool normalises names to URL pathnames, which keep
 * the leading slash, so the listing matches CARRY_FILE as written. */
const carryFiles: CarryFiles = {
  exists: () => pool?.getFileNames().includes(CARRY_FILE) ?? false,
  open() {
    if (pool === null) throw new Error("replica pool not installed");
    const raw = new pool.OpfsSAHPoolDb(CARRY_FILE);
    return { db: wrapSqlite(raw), close: () => { raw.close(); } };
  },
  unlink() {
    // its journal too, which describes only this file (see discardDbFile)
    pool?.unlink(journalOf(CARRY_FILE));
    pool?.unlink(CARRY_FILE);
  },
};

serveRpc(toPortLike(self as unknown as { postMessage(msg: unknown): void; onmessage: unknown }),
         buildHandlers({
           openDb, closeDb, discardDbFile, carry: createCarryStore(carryFiles),
         }));
