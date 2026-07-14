// @vitest-environment node
// Shim parity (spec section 7): every recorded request in
// shared/fixtures/shim_parity.json must produce byte-identical JSON from
// the local handlers running over a replica loaded with the same seed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { openTestDb, type TestDb } from "../testDb";
import { handleLocalApi } from "./router";

interface Fixture {
  seed: {
    pages: [number, string, number | null, number | null][];
    blocks: [string, number, string | null, number, string, number | null,
             number, number | null, number | null][];
    refs: [string, number, string][];
    sidebar: [number, string, number][];
  };
  cases: { name: string; path: string; response: unknown }[];
}

const fixture = JSON.parse(readFileSync(
  join(__dirname, "../../../../shared/fixtures/shim_parity.json"), "utf-8"),
) as Fixture;

const IMPLEMENTED = (_name: string) => true; // search included (pkm-blz2)

let t: TestDb;
beforeAll(async () => {
  t = await openTestDb();
  for (const p of fixture.seed.pages) {
    t.db.exec("INSERT INTO pages VALUES (?,?,?,?)", p);
  }
  for (const b of fixture.seed.blocks) {
    t.db.exec(
      "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
      + " heading, collapsed, created_at, updated_at)"
      + " VALUES (?,?,?,?,?,?,?,?,?)", b);
  }
  for (const r of fixture.seed.refs) {
    t.db.exec("INSERT INTO refs VALUES (?,?,?)", r);
  }
  for (const s of fixture.seed.sidebar) {
    t.db.exec("INSERT INTO sidebar_entries VALUES (?,?,?)", s);
  }
});

describe("local API parity with the server routes", () => {
  for (const c of fixture.cases.filter((c) => IMPLEMENTED(c.name))) {
    test(c.name, () => {
      const result = handleLocalApi(t.db, {
        method: "GET", path: c.path, nowMs: 1752364800000, // 2026-07-13 UTC
      });
      expect(result.handled).toBe(true);
      if (result.handled) {
        expect(result.status).toBe(200);
        expect(result.body).toEqual(c.response);
      }
    });
  }
});
