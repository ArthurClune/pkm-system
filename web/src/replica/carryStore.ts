// pattern: Imperative Shell
// The carry: a second small database in the replica's file pool that holds
// the pending queue while a damaged replica file is replaced. It is written
// and committed before the damaged file is unlinked, so from then until the
// new file has imported the rows there is always one durable copy. The file
// itself is reached through an injected opener, so this is tested against
// real sqlite-wasm in Node and the worker supplies the pool-backed one.

import type { ReplicaDb } from "./db";
import { type DurablePendingRow, importPendingRows } from "./queue";

/** The carry file as the host provides it. */
export interface CarryFiles {
  /** Whether the carry file is present in the pool. */
  exists(): boolean;
  /** Open (creating if absent) the carry file. */
  open(): { db: ReplicaDb; close(): void };
  /** Delete the carry file and its journal. */
  unlink(): void;
}

export interface CarryStore {
  exists(): boolean;
  /** Replace the carry's contents with `rows`, committed before returning. */
  write(rows: readonly DurablePendingRow[]): void;
  /** The carried rows by id; none when the table never committed. */
  read(): DurablePendingRow[];
  discard(): void;
}

const CREATE_PENDING_OPS =
  "CREATE TABLE IF NOT EXISTS pending_ops(" +
  "id INTEGER PRIMARY KEY, batch_id TEXT NOT NULL, ops_json TEXT NOT NULL," +
  " poisoned INTEGER NOT NULL DEFAULT 0, error TEXT)";

export function createCarryStore(files: CarryFiles): CarryStore {
  const withCarry = <T>(fn: (db: ReplicaDb) => T): T => {
    const handle = files.open();
    try {
      return fn(handle.db);
    } finally {
      handle.close();
    }
  };
  return {
    exists: () => files.exists(),
    write(rows) {
      withCarry((db) => {
        db.transaction(() => {
          db.exec(CREATE_PENDING_OPS);
          db.exec("DELETE FROM pending_ops");
          importPendingRows(db, rows);
        });
      });
    },
    read() {
      return withCarry((db) => {
        const table = db.select(
          "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='pending_ops'");
        if (table.length === 0) return [];
        return db.select<DurablePendingRow>(
          "SELECT id, batch_id, ops_json, poisoned, error" +
          " FROM pending_ops ORDER BY id");
      });
    },
    discard() {
      files.unlink();
    },
  };
}
