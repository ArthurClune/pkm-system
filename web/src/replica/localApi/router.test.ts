// @vitest-environment node
// Edge cases beyond the parity fixture (which pins happy-path responses):
// error statuses, daily auto-creation, the POST create-page path and its
// enqueued op, and unmatched routes reporting handled:false.
import { beforeEach, describe, expect, test } from "vitest";
import { titleForDate } from "../daily";
import { openTestDb, type TestDb } from "../testDb";
import { handleLocalApi, type LocalApiResult } from "./router";

const NOW = 1752403200000; // 2026-07-13 (mid-day UTC, same day in local time)

let t: TestDb;
beforeEach(async () => {
  t = await openTestDb();
});

function call(method: string, path: string, body?: unknown,
              deps?: { newBatchId(): string }): LocalApiResult {
  return handleLocalApi(t.db, { method, path, body, nowMs: NOW }, deps);
}

function expectStatus(result: LocalApiResult, status: number): unknown {
  expect(result.handled).toBe(true);
  if (!result.handled) throw new Error("unreachable");
  expect(result.status).toBe(status);
  return result.body;
}

describe("unmatched routes", () => {
  test("unknown paths report handled:false", () => {
    expect(call("GET", "/api/query?expr=x")).toEqual({ handled: false });
    expect(call("DELETE", "/api/page/X")).toEqual({ handled: false });
  });

  test("POST /api/pages without deps is not handled", () => {
    expect(call("POST", "/api/pages", { title: "X" }))
      .toEqual({ handled: false });
  });
});

describe("error statuses", () => {
  test("missing page 404s", () => {
    expectStatus(call("GET", "/api/page/No%20Such%20Page"), 404);
  });

  test("unlinked for a missing page 404s", () => {
    expectStatus(call("GET", "/api/unlinked?title=No%20Such%20Page"), 404);
  });

  test("journal with a malformed before date 400s", () => {
    expectStatus(call("GET", "/api/journal?before=yesterday"), 400);
  });

  test("block-refs rejects more than 50 uids", () => {
    const uids = Array.from({ length: 51 }, (_, i) => `uid_ok${i}`).join(",");
    expectStatus(call("GET", `/api/block-refs?uids=${uids}`), 422);
  });

  test("block-refs rejects malformed uids", () => {
    expectStatus(call("GET", "/api/block-refs?uids=bad!uid"), 422);
  });

  test("create page with a blank title 422s", () => {
    const deps = { newBatchId: () => "b1" };
    expectStatus(call("POST", "/api/pages", { title: "   " }, deps), 422);
    expectStatus(call("POST", "/api/pages", {}, deps), 422);
  });
});

describe("daily auto-creation", () => {
  test("today's page materializes locally on GET without being pushed", () => {
    const title = titleForDate(new Date(NOW));
    const body = expectStatus(
      call("GET", `/api/page/${encodeURIComponent(title)}`), 200,
    ) as { page: { id: number; title: string } };
    expect(body.page.title).toBe(title);
    expect(body.page.id).toBeLessThan(0); // local negative id
    expect(t.db.select("SELECT * FROM pending_ops")).toEqual([]);
  });

  test("journal without before includes an auto-created today", () => {
    const title = titleForDate(new Date(NOW));
    const body = expectStatus(call("GET", "/api/journal?days=1"), 200) as {
      days: { title: string; exists: boolean; blocks: unknown[] }[];
    };
    expect(body.days).toHaveLength(1);
    expect(body.days[0]).toMatchObject({ title, exists: true });
  });

  test("journal with a valid before lists absent days as exists:false", () => {
    const body = expectStatus(
      call("GET", "/api/journal?before=2026-07-10&days=2"), 200) as {
      days: { date: string; exists: boolean }[];
    };
    expect(body.days.map((d) => d.date)).toEqual(["2026-07-09", "2026-07-08"]);
    expect(body.days.every((d) => !d.exists)).toBe(true);
  });
});

describe("titles", () => {
  test("empty query returns no titles", () => {
    expect(expectStatus(call("GET", "/api/titles?q="), 200))
      .toEqual({ titles: [] });
    expect(expectStatus(call("GET", "/api/titles"), 200))
      .toEqual({ titles: [] });
  });

  test("LIKE metacharacters in the query are escaped", () => {
    t.db.exec("INSERT INTO pages(id, title) VALUES (1, '100% Done')");
    t.db.exec("INSERT INTO pages(id, title) VALUES (2, '100x Done')");
    expect(expectStatus(call("GET", "/api/titles?q=100%25"), 200))
      .toEqual({ titles: ["100% Done"] });
  });

  test("prefix matches rank before substring matches", () => {
    t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'A Note')");
    t.db.exec("INSERT INTO pages(id, title) VALUES (2, 'Note')");
    expect(expectStatus(call("GET", "/api/titles?q=Note"), 200))
      .toEqual({ titles: ["Note", "A Note"] });
  });
});

describe("create page", () => {
  test("creates a local negative-id page and enqueues create_page", () => {
    const body = expectStatus(
      call("POST", "/api/pages", { title: "  Fresh Page  " },
           { newBatchId: () => "batch-1" }), 200,
    ) as { id: number; title: string };
    expect(body.title).toBe("Fresh Page");
    expect(body.id).toBeLessThan(0);
    const rows = t.db.select<{ batch_id: string; ops_json: string }>(
      "SELECT batch_id, ops_json FROM pending_ops");
    expect(rows).toHaveLength(1);
    expect(rows[0].batch_id).toBe("batch-1");
    expect(JSON.parse(rows[0].ops_json)).toEqual(
      [{ op: "create_page", page_title: "Fresh Page" }]);
  });
});
