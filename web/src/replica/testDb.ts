// Test-only helper (coverage-excluded like src/test-helpers.ts): a real
// sqlite-wasm database in memory, wrapped and schema-installed, so replica
// modules are tested against the engine the browser runs.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { type ReplicaDb, type Oo1DbLike, wrapSqlite } from "./db";
import type { CarryFiles } from "./carryStore";
import { installSchema } from "./clientSchema";

interface Sqlite3Module {
  oo1: { DB: new (filename: string) => Oo1DbLike & { close(): void } };
}

let sqlite3: Sqlite3Module | null = null;

export interface TestDb {
  db: ReplicaDb;
  close(): void;
}

export async function openTestDb(): Promise<TestDb> {
  const t = await openRawTestDb();
  installSchema(t.db);
  return t;
}

/** Same, but without installing the schema — for code paths that must see
 * a brand-new empty database (worker init). */
export async function openRawTestDb(): Promise<TestDb> {
  sqlite3 ??= (await sqlite3InitModule()) as unknown as Sqlite3Module;
  const raw = new sqlite3.oo1.DB(":memory:");
  const db = wrapSqlite(raw);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA recursive_triggers=ON");
  return { db, close: () => raw.close() };
}

/** Carry files over one in-memory database. Content persists across opens,
 * as a file would; unlink really drops the table, so a discarded carry is
 * gone. `closes` counts close() calls. */
export function fakeCarryFiles(t: TestDb): CarryFiles & { closes: number } {
  let present = false;
  const files = {
    closes: 0,
    exists: () => present,
    open: () => {
      present = true;
      return { db: t.db, close: () => { files.closes += 1; } };
    },
    unlink: () => {
      present = false;
      t.db.exec("DROP TABLE IF EXISTS pending_ops");
    },
  };
  return files;
}

/** A database whose file-level structure is damaged: dropping a table walks
 * the broken freelist, so every logical rebuild fails the same way (the
 * 2026-09-28 iPad incident). Reads still work. */
export const withDamagedFreelist = (
  db: ReplicaDb, freesPages: RegExp = /^DROP /i, isDamaged = () => true,
): ReplicaDb => ({
  ...db,
  exec(sql, params) {
    if (isDamaged() && freesPages.test(sql)) {
      throw new Error(
        "SQLITE_CORRUPT: sqlite3 result code 11: database disk image is malformed");
    }
    db.exec(sql, params);
  },
  transaction: (fn) => db.transaction(fn),
});

/** `db`, except that the first exec whose SQL matches `statement` throws
 * `message`; every later call goes through. */
export function failingOnce(
  db: ReplicaDb, statement: RegExp, message: string,
): ReplicaDb {
  let failed = false;
  return {
    ...db,
    exec(sql, params) {
      if (!failed && statement.test(sql)) {
        failed = true;
        throw new Error(message);
      }
      db.exec(sql, params);
    },
    transaction: (fn) => db.transaction(fn),
  };
}
