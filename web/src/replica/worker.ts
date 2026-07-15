/// <reference lib="webworker" />
// pattern: Imperative Shell
// The replica worker: owns the sqlite-wasm database on the opfs-sahpool
// VFS (no COOP/COEP needed — spec section 3) and serves the RPC surface.
// Browser-only glue, excluded from unit coverage; all logic lives in the
// modules it wires together (workerHandlers/apply/queue/localApi), which
// are tested against real sqlite-wasm in Node.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { type Oo1DbLike, type ReplicaDb, wrapSqlite } from "./db";
import { serveRpc, toPortLike } from "./rpc";
import { buildHandlers } from "./workerHandlers";

const DB_FILE = "/pkm-replica.sqlite3";

interface PoolUtil {
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

async function openDb(): Promise<ReplicaDb> {
  sqlite3 ??= (await sqlite3InitModule()) as unknown as NonNullable<typeof sqlite3>;
  pool ??= await sqlite3!.installOpfsSAHPoolVfs({ name: "pkm-replica" });
  rawDb = new pool.OpfsSAHPoolDb(DB_FILE);
  return pragmas(wrapSqlite(rawDb));
}

function closeDb(): void {
  rawDb?.close();
  rawDb = null;
}

serveRpc(toPortLike(self as unknown as { postMessage(msg: unknown): void; onmessage: unknown }),
         buildHandlers({ openDb, closeDb }));
