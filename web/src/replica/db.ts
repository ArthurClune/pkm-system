// pattern: Imperative Shell
// Narrow interface over a sqlite-wasm oo1 DB so every module that touches
// replica SQL is testable against a real in-memory database in Node.

import type { Columns } from "./columns.gen";
import { rowCheckMessage, rowProblems } from "./rowCheck";

export type SqlValue = string | number | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface ReplicaDb {
  exec(sql: string, params?: SqlValue[]): void;
  /** Rows carrying exactly the named `Columns` keys; with the row check on
   * a column that is not a key, or a value that does not fit it, throws. */
  select<K extends keyof Columns = never>(sql: string, params?: SqlValue[]): Pick<Columns, K>[];
  /** Raw, unchecked rows under SQLite's own column names. Production code
   * reads the catalog through the helpers below, never through this. */
  introspect(sql: string, params?: SqlValue[]): Row[];
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
 * such savepoint", so recovery can still classify it. */
export function rollbackToSavepoint(
  db: ReplicaDb, name: string, cause?: unknown,
): void {
  try {
    db.exec(`ROLLBACK TO ${name}`);
  } catch (rollbackError: unknown) {
    throw cause ?? rollbackError;
  }
}

/** Each violation of `PRAGMA foreign_key_check` as one identity string
 * (table, rowid, parent, fkid), so two checks can be compared. */
export const foreignKeyViolations = (db: ReplicaDb): string[] =>
  db.introspect("PRAGMA foreign_key_check")
    .map((v) => JSON.stringify([v.table, v.rowid, v.parent, v.fkid]));

export const quickCheck = (db: ReplicaDb): string[] =>
  db.introspect("PRAGMA quick_check(5)").map((r) => String(r.quick_check));

export const sqliteVersion = (db: ReplicaDb): string =>
  String(db.introspect("SELECT sqlite_version() AS v")[0].v);

/** Names of the user-owned catalog objects of one kind, by name; `virtual`
 * is the virtual tables, `table` every user table. */
export function catalogNames(
  db: ReplicaDb, kind: "trigger" | "view" | "index" | "table" | "virtual",
): string[] {
  const where = kind === "virtual"
    ? "type = 'table' AND upper(sql) LIKE 'CREATE VIRTUAL TABLE%'"
    : kind === "index" ? "type = 'index' AND sql IS NOT NULL"
    : `type = '${kind}'`;
  return db.introspect(
    `SELECT name FROM sqlite_master WHERE ${where}` +
    " AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((r) => String(r.name));
}

export interface WrapOptions {
  /** `false` skips the row check, which otherwise runs under test. */
  checkRows?: boolean;
}

/** The row check exists only in test mode: the mode test folds to a constant
 * at build time, so the production worker bundle drops `rowCheck` and the
 * generated vocabulary behind it. */
const ROW_CHECK = import.meta.env.MODE === "test"
  ? { rowProblems, rowCheckMessage }
  : null;

export function wrapSqlite(raw: Oo1DbLike, opts: WrapOptions = {}): ReplicaDb {
  const rowCheck = opts.checkRows === false ? null : ROW_CHECK;
  let inTxn = false;
  const db: ReplicaDb = {
    exec(sql, params) {
      raw.exec(params ? { sql, bind: params } : { sql });
    },
    select<K extends keyof Columns = never>(sql: string, params?: SqlValue[]) {
      const rows = raw.selectObjects(sql, params);
      if (rowCheck !== null) {
        for (const row of rows) {
          const problems = rowCheck.rowProblems(row);
          if (problems.length > 0) {
            throw new Error(rowCheck.rowCheckMessage(sql, problems));
          }
        }
      }
      return rows as unknown as Pick<Columns, K>[];
    },
    introspect(sql: string, params?: SqlValue[]) {
      return raw.selectObjects(sql, params);
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
        // recovery classifies on it.
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
