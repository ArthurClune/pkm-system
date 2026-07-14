// pattern: Imperative Shell
// The offline shim's route table (spec section 4): matches the requests
// the app makes and serves them from the replica with the same OpenAPI
// shapes the server returns. Unmatched routes report handled:false — the
// caller surfaces a clear online-only error. Runs inside the worker.

import { titleForDate } from "../daily";
import type { ReplicaDb } from "../db";
import { getOrCreateLocalPage } from "../localOps";
import { enqueueBatch } from "../queue";
import { escapeFtsQuery } from "./fts";
import { journalPayload } from "./journal";
import { currentWorkPayload, fetchPage, pagePayload, unlinked } from "./pages";
import { searchPayload } from "./search";
import { resolveRefUids } from "./tree";

export interface LocalApiRequest {
  method: string;
  path: string; // path + query string, as passed to apiFetch
  body?: unknown;
  nowMs: number;
}

export type LocalApiResult =
  | { handled: false }
  | { handled: true; status: number; body: unknown };

const UID_RE = /^[a-zA-Z0-9_-]{6,32}$/;

const ok = (body: unknown): LocalApiResult =>
  ({ handled: true, status: 200, body });
const err = (status: number, detail: string): LocalApiResult =>
  ({ handled: true, status, body: { detail } });
const NOT_HANDLED: LocalApiResult = { handled: false };

/** Fresh batch ids for shim-enqueued ops (create_page). */
export interface LocalApiDeps {
  newBatchId(): string;
}

export function handleLocalApi(db: ReplicaDb, req: LocalApiRequest,
                               deps?: LocalApiDeps): LocalApiResult {
  const url = new URL(req.path, "http://replica.local");
  const q = url.searchParams;
  const path = url.pathname;
  const method = req.method.toUpperCase();

  if (method === "GET" && path.startsWith("/api/page/")) {
    const title = decodeURIComponent(path.slice("/api/page/".length));
    const body = pagePayload(db, title,
                             Number(q.get("bl_offset") ?? 0),
                             Number(q.get("bl_limit") ?? 20), req.nowMs);
    return body === null ? err(404, "page not found") : ok(body);
  }
  if (method === "GET" && path === "/api/unlinked") {
    const body = unlinked(db, q.get("title") ?? "",
                          Number(q.get("limit") ?? 20),
                          Number(q.get("offset") ?? 0));
    return body === null ? err(404, "page not found") : ok(body);
  }
  if (method === "GET" && path === "/api/journal") {
    const body = journalPayload(db, q.get("before"),
                                Number(q.get("days") ?? 7), req.nowMs);
    return body === null ? err(400, "invalid before date") : ok(body);
  }
  if (method === "GET" && path === "/api/current-work") {
    return ok(currentWorkPayload(db, req.nowMs));
  }
  if (method === "GET" && path === "/api/titles") {
    return ok(titles(db, q.get("q") ?? "", Number(q.get("limit") ?? 10)));
  }
  if (method === "GET" && path === "/api/block-refs") {
    const wanted = (q.get("uids") ?? "").split(",").filter((u) => u.length > 0);
    if (wanted.length > 50) return err(422, "too many uids");
    for (const uid of wanted) {
      if (!UID_RE.test(uid)) return err(422, `malformed uid: '${uid}'`);
    }
    return ok({ block_ref_texts: resolveRefUids(db, wanted) });
  }
  if (method === "GET" && path === "/api/sidebar") {
    return ok({ entries: db.select(
      "SELECT id, title FROM sidebar_entries ORDER BY order_idx") });
  }
  if (method === "GET" && path === "/api/search") {
    return ok(searchPayload(db, q.get("q") ?? "",
                            Number(q.get("limit") ?? 20)));
  }
  if (method === "POST" && path === "/api/pages" && deps) {
    const title = String((req.body as { title?: unknown })?.title ?? "").trim();
    if (title.length === 0) return err(422, "title must not be blank");
    // local negative id now; the durable create_page op carries the title
    // to the server (get_or_create there — spec section 1)
    getOrCreateLocalPage(db, title, req.nowMs);
    enqueueBatch(db, [{ op: "create_page", page_title: title }], req.nowMs,
                 deps.newBatchId());
    return ok(fetchPage(db, title));
  }
  return NOT_HANDLED;
}

function titles(db: ReplicaDb, qStr: string, limit: number): unknown {
  const lim = Math.max(1, Math.min(limit, 50));
  const needle = qStr.trim();
  if (needle.length === 0) return { titles: [] };
  const esc = needle.replaceAll("\\", "\\\\").replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  const rows = db.select<{ title: string }>(
    `SELECT title FROM pages
      WHERE title LIKE ? ESCAPE '\\'
      ORDER BY (CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END),
               length(title), title
      LIMIT ?`, [`%${esc}%`, `${esc}%`, lim]);
  return { titles: rows.map((r) => r.title) };
}

export { escapeFtsQuery, titleForDate };
