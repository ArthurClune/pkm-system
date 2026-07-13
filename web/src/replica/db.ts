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
        db.exec("ROLLBACK");
        throw e;
      } finally {
        inTxn = false;
      }
    },
  };
  return db;
}
