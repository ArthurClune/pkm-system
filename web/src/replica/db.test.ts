// @vitest-environment node
import { describe, expect, test } from "vitest";
import { openTestDb } from "./testDb";
import { CLIENT_DDL, SCHEMA_VERSION, installSchema } from "./clientSchema";
import { getMeta, setMeta } from "./meta";
import { sha256Hex } from "./sha256";

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
    // printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' | shasum -a 256
    expect(sha256Hex("a".repeat(56))).toBe(
      "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a");
  });
});

describe("wrapSqlite + installSchema", () => {
  test("select round-trips typed rows", async () => {
    const t = await openTestDb();
    t.db.exec("INSERT INTO pages(id, title) VALUES (?, ?)", [1, "AI"]);
    expect(t.db.select("SELECT id, title FROM pages")).toEqual(
      [{ id: 1, title: "AI" }]);
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
    const names = t.db.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'")
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
    const names = t.db.select<{ name: string }>(
      "SELECT name FROM sqlite_master").map((r) => r.name);
    expect(names).not.toContain("changes");
    expect(names).not.toContain("applied_batches");
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
