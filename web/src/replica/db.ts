// pattern: Imperative Shell
// Narrow interface over a sqlite-wasm oo1 DB so every module that touches
// replica SQL is testable against a real in-memory database in Node.

export type SqlValue = string | number | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface ReplicaDb {
  exec(sql: string, params?: SqlValue[]): void;
  select<T = Row>(sql: string, params?: SqlValue[]): T[];
  /** BEGIN/COMMIT with ROLLBACK on throw; nested calls join the outer
   * transaction (SQLite has no nested BEGIN). */
  transaction<T>(fn: () => T): T;
}

/** The slice of sqlite-wasm's oo1.DB that the wrapper needs. */
export interface Oo1DbLike {
  exec(opts: { sql: string; bind?: SqlValue[] }): unknown;
  selectObjects(sql: string, bind?: SqlValue[]): Row[];
}

/** ROLLBACK TO a savepoint after a failure the caller absorbs. If SQLite has
 * already rolled back the whole transaction (SQLITE_CORRUPT, IOERR, FULL),
 * the savepoint went with it; `cause` is then the error to raise, not "no
 * such savepoint", so recovery can still classify it (pkm-h1c6). */
export function rollbackToSavepoint(
  db: ReplicaDb, name: string, cause?: unknown,
): void {
  try {
    db.exec(`ROLLBACK TO ${name}`);
  } catch (rollbackError: unknown) {
    throw cause ?? rollbackError;
  }
}

export function wrapSqlite(raw: Oo1DbLike): ReplicaDb {
  let inTxn = false;
  const db: ReplicaDb = {
    exec(sql, params) {
      raw.exec(params ? { sql, bind: params } : { sql });
    },
    select<T>(sql: string, params?: SqlValue[]) {
      return raw.selectObjects(sql, params) as T[];
    },
    transaction<T>(fn: () => T): T {
      if (inTxn) return fn();
      db.exec("BEGIN");
      inTxn = true;
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        // SQLite has already rolled back on some errors (SQLITE_CORRUPT,
        // IOERR, FULL), so this ROLLBACK can fail with "no transaction is
        // active". The error that caused it is the one the caller must see:
        // recovery classifies on it (pkm-h1c6).
        try {
          db.exec("ROLLBACK");
        } catch (rollbackError: unknown) {
          console.warn("replica: ROLLBACK after a failed transaction", rollbackError);
        }
        throw e;
      } finally {
        inTxn = false;
      }
    },
  };
  return db;
}
