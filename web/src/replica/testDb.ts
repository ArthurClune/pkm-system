// Test-only helper (coverage-excluded like src/test-helpers.ts): a real
// sqlite-wasm database in memory, wrapped and schema-installed, so replica
// modules are tested against the engine the browser runs.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { type ReplicaDb, type Oo1DbLike, type WrapOptions, wrapSqlite } from "./db";
import type { CarryFiles } from "./carryStore";
import { installSchema } from "./clientSchema";

interface Sqlite3Module {
  config: { warn: (...args: unknown[]) => void };
  capi: {
    sqlite3_progress_handler(db: number, nOps: number,
                             callback: (() => number) | 0, cbArg: 0): void;
  };
  oo1: {
    DB: new (filename: string) => Oo1DbLike & { close(): void; pointer: number };
  };
}

let sqlite3: Sqlite3Module | null = null;

export interface TestDb {
  db: ReplicaDb;
  close(): void;
  /** How many times SQLite's progress handler fired, every `every` VM
   * steps, while `fn` ran: work that grows with the rows a query visits,
   * and unlike a clock, the same on every run. */
  vmSteps(fn: () => void, every?: number): number;
}

/** The engine's bootstrap probes `localStorage` for its kvvfs backend; on
 * Node that getter prints an ExperimentalWarning to stderr. Hide the global
 * for the probe, then put back exactly what was there. */
async function initQuietly(): Promise<Sqlite3Module> {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage",
    { value: undefined, configurable: true, writable: true });
  try {
    return (await sqlite3InitModule()) as unknown as Sqlite3Module;
  } finally {
    if (saved) Object.defineProperty(globalThis, "localStorage", saved);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

/** `checkRows: false` is for a test whose premise is data the row check
 * rejects, such as a uid no wire op can carry; production runs without it. */
export async function openTestDb(opts: WrapOptions = {}): Promise<TestDb> {
  const t = await openRawTestDb(opts);
  installSchema(t.db);
  return t;
}

/** Same, but without installing the schema — for code paths that must see
 * a brand-new empty database (worker init). */
export async function openRawTestDb(opts: WrapOptions = {}): Promise<TestDb> {
  if (!sqlite3) {
    sqlite3 = await initQuietly();
    // The engine reports failed statements through config.warn, bound to
    // console.warn at init; looking console up per call lets a test's spy
    // see (and silence) the ones it provokes on purpose.
    sqlite3.config.warn = (...args) => console.warn(...args);
  }
  const engine = sqlite3;
  const raw = new engine.oo1.DB(":memory:");
  const db = wrapSqlite(raw, opts);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA recursive_triggers=ON");
  const vmSteps = (fn: () => void, every = 100): number => {
    let ticks = 0;
    engine.capi.sqlite3_progress_handler(raw.pointer, every, () => {
      ticks += 1;
      return 0;
    }, 0);
    try {
      fn();
    } finally {
      engine.capi.sqlite3_progress_handler(raw.pointer, 0, 0, 0);
    }
    return ticks;
  };
  return { db, close: () => raw.close(), vmSteps };
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
