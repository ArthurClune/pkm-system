// Test-only helper (coverage-excluded like src/test-helpers.ts): a real
// sqlite-wasm database in memory, wrapped and schema-installed, so replica
// modules are tested against the engine the browser runs.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { type ReplicaDb, type Oo1DbLike, wrapSqlite } from "./db";
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
  sqlite3 ??= (await sqlite3InitModule()) as unknown as Sqlite3Module;
  const raw = new sqlite3.oo1.DB(":memory:");
  const db = wrapSqlite(raw);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA recursive_triggers=ON");
  installSchema(db);
  return { db, close: () => raw.close() };
}
