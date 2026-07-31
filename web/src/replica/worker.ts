/// <reference lib="webworker" />
// pattern: Imperative Shell
// The replica worker: owns the sqlite-wasm database on the opfs-sahpool
// VFS (no COOP/COEP needed — spec section 3) and serves the RPC surface.
// Browser-only glue, excluded from unit coverage; all logic lives in the
// modules it wires together (workerHandlers/apply/queue/localApi), which
// are tested against real sqlite-wasm in Node.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { type Oo1DbLike, type ReplicaDb, wrapSqlite } from "./db";
import { openWithRetry } from "./openRetry";
import { ensureMinimumCapacity, type CapacityPool } from "./poolCapacity";
import { serveRpc, toPortLike } from "./rpc";
import { buildHandlers } from "./workerHandlers";

const DB_FILE = "/pkm-replica.sqlite3";

interface PoolUtil extends CapacityPool {
  OpfsSAHPoolDb: new (filename: string) => Oo1DbLike & { close(): void };
}

let sqlite3: { installOpfsSAHPoolVfs(opts: { name: string }): Promise<PoolUtil> } | null = null;
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
  // desync that wipes the active outline.
  return openWithRetry(async () => {
    pool ??= await sqlite3!.installOpfsSAHPoolVfs({ name: "pkm-replica" });
    // The same navigation race can also let the install SUCCEED with a pool
    // too small to hold both the database and its rollback journal, which
    // makes every write fail with SQLITE_CANTOPEN forever (pkm-ndcu). Grow it
    // back before opening the database.
    await ensureMinimumCapacity(pool);
    rawDb = new pool.OpfsSAHPoolDb(DB_FILE);
    return pragmas(wrapSqlite(rawDb));
  }, { sleep });
}

function closeDb(): void {
  rawDb?.close();
  rawDb = null;
}

serveRpc(toPortLike(self as unknown as { postMessage(msg: unknown): void; onmessage: unknown }),
         buildHandlers({ openDb, closeDb }));
