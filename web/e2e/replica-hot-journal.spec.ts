// A replica worker killed partway through a write leaves a rollback journal
// in the OPFS SAH pool. The next open of that file must play the journal
// back, so the database holds only what was committed. The pool VFS reports
// a RESERVED lock only when a file it has open on that path holds one,
// which is what lets SQLite recognise a killed worker's journal as hot
// (web/patches/@sqlite.org__sqlite-wasm@*.patch).
//
// The tool worker (sahpool-tool.ts) stands in for a replica worker: it opens
// the app's pool, writes, and is terminated mid-transaction. It runs on
// /healthz, which is same-origin (same OPFS) but boots no SPA and spawns no
// replica worker.
import { type Page } from "@playwright/test";
import { REPLICA_FILE, journalOf } from "../src/replica/poolCapacity";
import { expect, test } from "./fixtures";
import { startSahpoolTool } from "./sahpool-tool";

// no PWA service worker may intercept the host page or the app
test.use({ serviceWorkers: "block" });

const PASSWORD = "e2e-pw";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", PASSWORD);
  await page.click("text=log in");
  await page.waitForURL("**/");
}

const CREATE_PROBE =
  "CREATE TABLE e2e_probe(id INTEGER PRIMARY KEY, v TEXT NOT NULL, pad TEXT NOT NULL)";
// about 26 pages of 4 KiB; 'committed' and 'uncommitd' are the same length,
// so torn pages keep their structure and read without SQLITE_CORRUPT
const SEED_PROBE =
  "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200) "
  + "INSERT INTO e2e_probe SELECT i, 'committed', hex(zeroblob(250)) FROM n";
// an uncommitted UPDATE whose tiny page cache forces a spill of changed
// pages into the database file before any COMMIT
const TEAR = ["PRAGMA cache_size=2", "BEGIN", "UPDATE e2e_probe SET v = 'uncommitd'"];

test("the app rolls back a replica transaction a killed worker left, on its next open", async ({ page, context }) => {
  await page.goto("/healthz");
  const writer = await startSahpoolTool(page);
  await writer.open("a", REPLICA_FILE);
  for (const sql of [CREATE_PROBE, SEED_PROBE, ...TEAR]) await writer.exec("a", sql);
  await writer.kill();

  const inspector = await startSahpoolTool(page);
  expect(await inspector.files()).toContain(journalOf(REPLICA_FILE));
  await inspector.release();

  // The app's own open reads the file and then writes to it (schema install,
  // bootstrap) before it marks the replica ready. A journal it failed to
  // play back would be reused and deleted by that first commit, making the
  // spilled pages permanent, so what the reader sees below is the app's work.
  const app = await context.newPage();
  await login(app);
  await app.waitForFunction(() => performance.getEntriesByName("pkm:replica-ready").length > 0);
  await app.close();

  const reader = await startSahpoolTool(page);
  await reader.open("a", REPLICA_FILE);
  expect(await reader.exec("a", "SELECT v, count(*) AS n FROM e2e_probe GROUP BY v"))
    .toEqual([{ v: "committed", n: 200 }]);
  expect(await reader.exec("a", "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  expect(await reader.files()).not.toContain(journalOf(REPLICA_FILE));
  await reader.release();
});

// A read on a second connection must not take a live writer's journal for a
// killed worker's: playing it back would undo pages underneath the writer.
test("a second connection in the same worker leaves a live writer's journal alone", async ({ page }) => {
  const file = "/e2e-two-connections.sqlite3";
  await page.goto("/healthz");
  const tool = await startSahpoolTool(page);
  await tool.open("a", file);
  for (const sql of [CREATE_PROBE, SEED_PROBE, ...TEAR]) await tool.exec("a", sql);

  await tool.open("b", file);
  expect(await tool.exec("b", "SELECT count(*) AS n FROM e2e_probe")).toEqual([{ n: 200 }]);
  expect(await tool.files()).toContain(journalOf(file));

  await tool.exec("a", "COMMIT");
  expect(await tool.exec("b", "SELECT v, count(*) AS n FROM e2e_probe GROUP BY v"))
    .toEqual([{ v: "uncommitd", n: 200 }]);
  expect(await tool.exec("b", "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  await tool.release();
});

// A file created and filled in one transaction (the carry's case) that is cut
// short rolls back to an empty database, not to a torn one.
test("a first transaction on a fresh file, cut short, leaves an empty database", async ({ page }) => {
  const file = "/e2e-fresh.sqlite3";
  await page.goto("/healthz");
  const writer = await startSahpoolTool(page);
  await writer.open("a", file);
  for (const sql of ["PRAGMA cache_size=2", "BEGIN", CREATE_PROBE, SEED_PROBE]) {
    await writer.exec("a", sql);
  }
  await writer.kill();

  const reader = await startSahpoolTool(page);
  expect(await reader.files()).toContain(journalOf(file));
  await reader.open("a", file);
  expect(await reader.exec("a", "SELECT count(*) AS n FROM sqlite_master")).toEqual([{ n: 0 }]);
  expect(await reader.files()).not.toContain(journalOf(file));
  await reader.release();
});
