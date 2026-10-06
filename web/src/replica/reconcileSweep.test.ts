// @vitest-environment node
// dropStrandedLocalPages: each keep clause alone holds a negative-id page.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { titleForDate } from "./daily";
import { dropStrandedLocalPages } from "./reconcile";
import { openTestDb, type TestDb } from "./testDb";

const NOW = Date.UTC(2026, 9, 6, 12);
let t: TestDb;
beforeEach(async () => {
  t = await openTestDb();
  t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'Real'), (-50, 'Local')");
});
afterEach(() => { t.close(); });

const pageIds = () =>
  t.db.select<{ id: number }>("SELECT id FROM pages ORDER BY id").map((r) => r.id);
const sweep = () => dropStrandedLocalPages(t.db, NOW);

describe("dropStrandedLocalPages", () => {
  test("drops a negative page nothing keeps and leaves positive ids", () => {
    sweep();
    expect(pageIds()).toEqual([1]);
  });

  test("a replay_log row's pre_page_id keeps the page", () => {
    t.db.exec("INSERT INTO replay_log(batch_id, kind, key, pre_json, pre_page_id)" +
              " VALUES ('b', 'block', 'x', '{}', -50)");
    sweep();
    expect(pageIds()).toEqual([-50, 1]);
  });

  test("a page record keyed on the page keeps it", () => {
    t.db.exec("INSERT INTO replay_log(batch_id, kind, key, pre_json)" +
              " VALUES ('b', 'page', '-50', NULL)");
    sweep();
    expect(pageIds()).toEqual([-50, 1]);
  });

  test("a recorded ref to the page keeps it", () => {
    t.db.exec("INSERT INTO replay_log(id, batch_id, kind, key, pre_json, pre_page_id)" +
              " VALUES (7, 'b', 'block', 'x', '{}', 1)");
    t.db.exec("INSERT INTO replay_log_refs(log_id, target_page_id, kind)" +
              " VALUES (7, -50, 'link')");
    sweep();
    expect(pageIds()).toEqual([-50, 1]);
  });

  test("a block on the page keeps it", () => {
    t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
              " VALUES ('b1', -50, NULL, 0, 'x')");
    sweep();
    expect(pageIds()).toEqual([-50, 1]);
  });

  test("a ref to the page keeps it", () => {
    t.db.exec("INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
              " VALUES ('b1', 1, NULL, 0, 'x')");
    t.db.exec("INSERT INTO refs VALUES ('b1', -50, 'link')");
    sweep();
    expect(pageIds()).toEqual([-50, 1]);
  });

  test("a page record on another page does not keep it", () => {
    t.db.exec("INSERT INTO replay_log(batch_id, kind, key, pre_json)" +
              " VALUES ('b', 'page', '-5', NULL)");
    sweep();
    expect(pageIds()).toEqual([1]);
  });

  test("today's daily page is kept and another day's is dropped", () => {
    t.db.exec("INSERT INTO pages(id, title) VALUES (-60, ?), (-61, 'October 5th, 2026')",
              [titleForDate(new Date(NOW))]);
    sweep();
    expect(pageIds()).toEqual([-60, 1]);
  });
});
