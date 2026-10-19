// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { rollbackToSavepoint } from "./db";
import { openTestDb } from "./testDb";
import { CLIENT_DDL, SCHEMA_VERSION, installSchema } from "./clientSchema";
import { getMeta, setMeta } from "./meta";
import { sha256Hex } from "./sha256";

// Deliberate engine failures log through console.warn (the engine's own
// "sqlite3_step() rc= ..." lines via testDb.ts, plus the wrapper's); each test
// that provokes one spies and asserts it.
const quietWarn = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("sha256Hex", () => {
  test("matches known vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("hashes UTF-8 bytes, not UTF-16 units", () => {
    // printf 'héllo' | shasum -a 256
    expect(sha256Hex("héllo")).toBe(
      "3c48591d8d098a4538f5e013dfcf406e948eac4d3277b10bf614e295d6068179");
  });

  test("handles messages spanning the 55/56-byte padding boundary", () => {
    // printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' |
    // shasum -a 256
    expect(sha256Hex("a".repeat(56))).toBe(
      "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a");
  });
});

describe("wrapSqlite + installSchema", () => {
  test("select round-trips typed rows", async () => {
    const t = await openTestDb();
    t.db.exec("INSERT INTO pages(id, title) VALUES (?, ?)", [1, "AI"]);
    expect(t.db.select("SELECT id AS page_id, title FROM pages")).toEqual(
      [{ page_id: 1, title: "AI" }]);
    t.close();
  });

  test("select with the check on throws on SELECT text AS uid", async () => {
    const t = await openTestDb();
    t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'AI')");
    expect(() => t.db.select("SELECT title AS uid FROM pages"))
      .toThrow(/row check failed.*uid: "AI" is not a valid BlockUid/);
    expect(() => t.db.select("SELECT id FROM pages"))
      .toThrow(/id: not a registered row key/);
    t.close();
  });

  test("select names Columns keys and nothing else", async () => {
    const t = await openTestDb();
    // @ts-expect-error no key named, so no column is typed
    expect(t.db.select("SELECT 1 AS n")[0].n).toBe(1);
    // @ts-expect-error "nope" is not a Columns key
    expect(() => t.db.select<"nope">("SELECT 1 AS nope")).toThrow(/nope/);
    expect(t.db.select<"n">("SELECT 1 AS n")[0].n).toBe(1);
    t.close();
  });

  test("introspect returns the engine's own columns unchecked", async () => {
    const t = await openTestDb();
    expect(t.db.introspect("PRAGMA table_info(pages)")[0]).toHaveProperty("name");
    t.close();
  });

  test("introspect refuses a brand column under the row check", async () => {
    const t = await openTestDb();
    // Refused on the column, so an empty result is refused too.
    expect(() => t.db.introspect("SELECT uid FROM blocks"))
      .toThrow('uid carries BlockUid: read it with select<"uid">');
    // A raw name that a table's column maps to a branded key.
    expect(() => t.db.introspect("SELECT id FROM pages"))
      .toThrow(/^id carries PageId or PendingRowId or SidebarEntryId: .*select/);
    t.close();
  });

  test("introspect allows catalog columns", async () => {
    const t = await openTestDb();
    expect(t.db.introspect("PRAGMA quick_check")).toEqual([{ quick_check: "ok" }]);
    expect(t.db.introspect("SELECT uid AS u FROM blocks")).toEqual([]);
    t.close();
  });

  test("introspect refuses only under the row check", async () => {
    const t = await openTestDb({ checkRows: false });
    t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'AI')");
    t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)"
      + " VALUES ('tuid-a', 1, NULL, 0, 'x')");
    expect(t.db.introspect("SELECT uid FROM blocks")).toEqual([{ uid: "tuid-a" }]);
    expect(t.db.introspect("SELECT id FROM pages")).toEqual([{ id: 1 }]);
    t.close();
  });

  test("transaction rolls back on throw and commits on success", async () => {
    const t = await openTestDb();
    expect(() => t.db.transaction(() => {
      t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'AI')");
      throw new Error("boom");
    })).toThrow("boom");
    expect(t.db.select("SELECT COUNT(*) AS n FROM pages")).toEqual([{ n: 0 }]);
    t.db.transaction(() => {
      t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'AI')");
    });
    expect(t.db.select("SELECT COUNT(*) AS n FROM pages")).toEqual([{ n: 1 }]);
    t.close();
  });

  test("an engine auto-rollback does not replace the original error", async () => {
    // SQLite rolls the transaction back itself on SQLITE_CORRUPT/IOERR/FULL;
    // the wrapper's own ROLLBACK then fails with "no transaction is active".
    // The caller must still see the error that caused it.
    const t = await openTestDb();
    const warn = quietWarn();
    expect(() => t.db.transaction(() => {
      t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'AI')");
      t.db.exec("ROLLBACK");
      throw new Error("SQLITE_CORRUPT: database disk image is malformed");
    })).toThrow("SQLITE_CORRUPT");
    expect(warn).toHaveBeenCalledWith(
      "replica: ROLLBACK after a failed transaction",
      expect.objectContaining({ message: expect.stringContaining("no transaction is active") as unknown }));
    expect(warn).toHaveBeenCalledWith(
      "sqlite3_step() rc=", 1, "SQLITE_ERROR", "SQL =", "ROLLBACK");
    expect(t.db.select("SELECT COUNT(*) AS n FROM pages")).toEqual([{ n: 0 }]);
    t.db.transaction(() => {
      t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'AI')");
    });
    expect(t.db.select("SELECT COUNT(*) AS n FROM pages")).toEqual([{ n: 1 }]);
    t.close();
  });

  test("rollbackToSavepoint raises the cause when the engine already rolled back", async () => {
    const t = await openTestDb();
    const warn = quietWarn();
    const cause = new Error("SQLITE_CORRUPT: database disk image is malformed");
    expect(() => t.db.transaction(() => {
      t.db.exec("SAVEPOINT sp");
      t.db.exec("ROLLBACK");
      rollbackToSavepoint(t.db, "sp", cause);
    })).toThrow(cause);
    expect(warn).toHaveBeenCalledWith(
      "sqlite3_step() rc=", 1, "SQLITE_ERROR", "SQL =", "ROLLBACK TO sp");
    expect(warn).toHaveBeenCalledWith(
      "sqlite3_step() rc=", 1, "SQLITE_ERROR", "SQL =", "ROLLBACK");
    t.db.transaction(() => {
      t.db.exec("SAVEPOINT sp");
      t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'AI')");
      rollbackToSavepoint(t.db, "sp", cause);
      t.db.exec("RELEASE sp");
    });
    expect(t.db.select("SELECT COUNT(*) AS n FROM pages")).toEqual([{ n: 0 }]);
    t.close();
  });

  test("nested transaction joins the outer one", async () => {
    const t = await openTestDb();
    t.db.transaction(() => {
      t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'AI')");
      t.db.transaction(() => {
        t.db.exec("INSERT INTO pages(id, title) VALUES (2, 'ML')");
      });
    });
    expect(t.db.select("SELECT COUNT(*) AS n FROM pages")).toEqual([{ n: 2 }]);
    t.close();
  });

  test("installs base + client tables with working FTS triggers", async () => {
    const t = await openTestDb();
    const names = (t.db.introspect(
      "SELECT name FROM sqlite_master WHERE type = 'table'") as { name: string }[])
      .map((r) => r.name);
    for (const table of ["pages", "blocks", "refs", "sidebar_entries",
                         "sync_client_meta", "pending_ops"]) {
      expect(names).toContain(table);
    }
    t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'P')");
    t.db.exec(
      "INSERT INTO blocks(uid, page_id, order_idx, text) VALUES" +
      " ('uid_aaa111', 1, 0, 'searchable attention text')");
    expect(t.db.select(
      "SELECT b.uid FROM blocks b JOIN blocks_fts f ON f.rowid = b.rowid" +
      " WHERE blocks_fts MATCH 'attention'")).toEqual([{ uid: "uid_aaa111" }]);
    t.close();
  });

  test("does not install server-only journal tables", async () => {
    const t = await openTestDb();
    const names = (t.db.introspect(
      "SELECT name FROM sqlite_master") as { name: string }[]).map((r) => r.name);
    expect(names).not.toContain("changes");
    expect(names).not.toContain("applied_batches");
    t.close();
  });

  test("installSchema creates replay_log, replay_log_refs and replay_batches with their indexes", async () => {
    const t = await openTestDb();
    const names = (t.db.introspect(
      "SELECT name FROM sqlite_master") as { name: string }[]).map((r) => r.name);
    for (const n of ["replay_log", "replay_log_refs", "replay_batches",
                     "idx_replay_log_key", "idx_replay_log_refs_log"]) {
      expect(names).toContain(n);
    }
    expect(names).not.toContain("effect_ledger");
    t.close();
  });

  test("is idempotent and stamps a schema version", async () => {
    const t = await openTestDb();
    installSchema(t.db); // second run must be a no-op
    expect(getMeta(t.db, "schema_version")).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(sha256Hex(
      (await import("./baseSchema.gen")).BASE_SCHEMA + CLIENT_DDL));
    t.close();
  });
});

describe("meta", () => {
  test("get returns null when unset, set upserts", async () => {
    const t = await openTestDb();
    expect(getMeta(t.db, "cursor")).toBeNull();
    setMeta(t.db, "cursor", "42");
    setMeta(t.db, "cursor", "43");
    expect(getMeta(t.db, "cursor")).toBe("43");
    t.close();
  });
});

describe("the row check outside test mode", () => {
  const badRows = { exec: () => undefined, selectObjects: () => [{ nope: 1 }] };

  test("is on under test and throws on a bad row", async () => {
    const { wrapSqlite } = await import("./db");
    expect(() => wrapSqlite(badRows).select("SELECT 1 AS nope"))
      .toThrow(/not a registered row key/);
  });

  test("is not built into a production module, so a bad row passes", async () => {
    vi.stubEnv("MODE", "production");
    vi.resetModules();
    const { wrapSqlite } = await import("./db");
    expect(wrapSqlite(badRows).select("SELECT 1 AS nope")).toEqual([{ nope: 1 }]);
    vi.resetModules();
  });

  test("is not built into a production module, so introspect reads a brand column", async () => {
    vi.stubEnv("MODE", "production");
    vi.resetModules();
    const { wrapSqlite } = await import("./db");
    const uidRows = { exec: () => undefined, selectObjects: () => [{ uid: "x" }] };
    expect(wrapSqlite(uidRows).introspect("SELECT uid FROM blocks")).toEqual([{ uid: "x" }]);
    vi.resetModules();
  });
});
