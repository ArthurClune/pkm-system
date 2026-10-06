// @vitest-environment node
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describe, expect, test } from "vitest";
import {
  aliases, fullScans, installCounter, plannable, PROGRESS_N,
  type Oo1Exec, type Sqlite3Like,
} from "./sqlcount";

const TABLES = new Set(["blocks", "pages", "refs"]);

describe("plannable", () => {
  test("only DML and select", () => {
    expect(plannable("SELECT 1")).toBe(true);
    expect(plannable("  with x as (select 1) select * from x")).toBe(true);
    expect(plannable("UPDATE blocks SET text='a' WHERE uid='b'")).toBe(true);
    expect(plannable("-- TRIGGER blocks_fts_ai")).toBe(false);
    expect(plannable("PRAGMA foreign_keys=ON")).toBe(false);
    expect(plannable("BEGIN")).toBe(false);
  });
});

describe("fullScans", () => {
  test("ignores indexed, virtual and cte rows", () => {
    const details = ["SCAN blocks", "SCAN pages USING INDEX idx_x", "SEARCH refs USING INDEX r (b=?)",
      "SCAN blocks_fts VIRTUAL TABLE INDEX 0:M1", "SCAN chain", "SCAN CONSTANT ROW",
      "SCAN refs USING COVERING INDEX r2"];
    expect(fullScans(details, TABLES)).toEqual(["SCAN blocks"]);
  });

  test("resolves aliased rows", () => {
    const details = ["SCAN b", "SCAN p USING INDEX idx_p", "SCAN a", "SEARCH r USING INDEX r (src=?)"];
    const names = new Map([["b", "blocks"], ["p", "pages"], ["a", "anc"], ["r", "refs"]]);
    expect(fullScans(details, TABLES, names)).toEqual(["SCAN b"]);
  });
});

describe("aliases", () => {
  test("maps from and join aliases to tables", () => {
    const sql = "WITH RECURSIVE anc(uid) AS (SELECT uid FROM blocks WHERE uid='x') "
      + "SELECT b.uid FROM blocks b JOIN pages AS p ON p.title = b.page_title "
      + "LEFT JOIN refs r ON r.src = b.uid JOIN anc a ON a.uid = b.uid "
      + "WHERE b.text LIKE '%x%'";
    expect(aliases(sql)).toEqual(new Map([["b", "blocks"], ["p", "pages"], ["r", "refs"], ["a", "anc"]]));
  });

  test("skips keywords after unaliased tables", () => {
    const sql = "SELECT * FROM blocks WHERE uid IN (SELECT uid FROM refs JOIN pages ON 1) ORDER BY 1";
    expect(aliases(sql).size).toBe(0);
  });

  test("keeps the next aliased table after an unaliased one", () => {
    const sql = "SELECT * FROM blocks JOIN pages p ON p.title = blocks.page_title";
    expect(aliases(sql)).toEqual(new Map([["p", "pages"]]));
  });
});

async function memoryDb(): Promise<{ sqlite3: Sqlite3Like; raw: Oo1Exec & { pointer: number } }> {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage",
    { value: undefined, configurable: true, writable: true });
  try {
    const sqlite3 = await sqlite3InitModule();
    const raw = new sqlite3.oo1.DB(":memory:");
    return { sqlite3: sqlite3 as unknown as Sqlite3Like, raw: raw as unknown as Oo1Exec & { pointer: number } };
  } finally {
    if (saved) Object.defineProperty(globalThis, "localStorage", saved);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

describe("installCounter", () => {
  test("measure counts top-level and trigger statements inside fn only", async () => {
    const { sqlite3, raw } = await memoryDb();
    raw.exec("CREATE TABLE t(a); CREATE TABLE log(a);"
      + "CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN INSERT INTO log VALUES (new.a); END;");
    raw.exec("INSERT INTO t VALUES (0)");
    const c = installCounter(sqlite3, raw);
    const { counts } = await c.measure(() => {
      raw.exec("INSERT INTO t VALUES (1)");
      raw.exec("INSERT INTO t VALUES (2)");
    });
    expect(counts.statements).toBe(2);
    // per firing: the "-- TRIGGER t_ai" line and the "-- INSERT INTO log ..." body line
    expect(counts.trigger_statements).toBe(4);
    c.uninstall();
  });

  test("measure returns fn's result and resets between runs", async () => {
    const { sqlite3, raw } = await memoryDb();
    const c = installCounter(sqlite3, raw);
    const a = await c.measure(async () => { raw.exec("SELECT 1"); return 7; });
    const b = await c.measure(() => 8);
    expect(a.result).toBe(7);
    expect(a.counts.statements).toBe(1);
    expect(b.result).toBe(8);
    expect(b.counts.statements).toBe(0);
    c.uninstall();
  });

  test("measure ticks the progress handler on heavy work", async () => {
    const { sqlite3, raw } = await memoryDb();
    const c = installCounter(sqlite3, raw);
    const { counts } = await c.measure(() => {
      raw.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 200000) SELECT count(*) FROM n");
    });
    expect(PROGRESS_N).toBe(1000);
    expect(counts.vm_steps_k).toBeGreaterThan(10);
    c.uninstall();
  });

  test("full_scans counts an unindexed read of a real table, not an indexed one", async () => {
    const { sqlite3, raw } = await memoryDb();
    raw.exec("CREATE TABLE t(a, b); CREATE INDEX t_a ON t(a);");
    const c = installCounter(sqlite3, raw);
    const scan = await c.measure(() => { raw.exec("SELECT * FROM t WHERE b = 1"); });
    const idx = await c.measure(() => { raw.exec("SELECT * FROM t WHERE a = 1"); });
    expect(scan.counts.full_scans).toBe(1);
    expect(idx.counts.full_scans).toBe(0);
    c.uninstall();
  });

  test("full_scans resolves aliases and ignores virtual tables", async () => {
    const { sqlite3, raw } = await memoryDb();
    raw.exec("CREATE TABLE t(a, b); CREATE VIRTUAL TABLE v USING fts5(x);");
    const c = installCounter(sqlite3, raw);
    const aliased = await c.measure(() => { raw.exec("SELECT x.a FROM t x WHERE x.b = 1"); });
    const virt = await c.measure(() => { raw.exec("SELECT * FROM v WHERE v MATCH 'a'"); });
    expect(aliased.counts.full_scans).toBe(1);
    expect(virt.counts.full_scans).toBe(0);
    c.uninstall();
  });

  test("a traced statement EXPLAIN QUERY PLAN cannot plan throws", async () => {
    const { sqlite3, raw } = await memoryDb();
    raw.exec("CREATE TABLE t(a)");
    const c = installCounter(sqlite3, raw);
    // the table a traced statement reads is gone by the time it is planned
    await expect(c.measure(() => {
      raw.exec("CREATE TABLE w(a)");
      raw.exec("SELECT * FROM w");
      raw.exec("DROP TABLE w");
    })).rejects.toThrow(/no such table/);
    c.uninstall();
  });
});
