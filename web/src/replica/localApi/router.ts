// pattern: Imperative Shell
// The offline shim's route table (spec section 4): matches the requests
// the app makes and serves them from the replica with the same OpenAPI
// shapes the server returns. Unmatched routes report handled:false — the
// caller surfaces a clear online-only error. Runs inside the worker.

import type { BatchId, BlockUid, CanonicalTitle,
              SidebarEntryId } from "../../api/brands";
import type { BlockRefsPayload, SidebarNavEntry, SidebarNavPayload,
              TitlesPayload } from "../../api/payloads";
import { parseBlockUid } from "../../ids";
import type { ReplicaDb } from "../db";
import { getOrCreateLocalPage } from "../localOps";
import { canonicalTitle } from "../meta";
import { enqueueBatch } from "../queue";
import { titleSyntaxReason } from "../titles";
import { journalPayload } from "./journal";
import { blockBacklinks, currentWorkPayload, fetchPage, pagePayload,
         unlinked } from "./pages";
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

const ok = (body: unknown): LocalApiResult =>
  ({ handled: true, status: 200, body });
const err = (status: number, detail: string): LocalApiResult =>
  ({ handled: true, status, body: { detail } });
const NOT_HANDLED: LocalApiResult = { handled: false };

/** Fresh batch ids for shim-enqueued ops (create_page). */
export interface LocalApiDeps {
  newBatchId(): BatchId;
}

export function handleLocalApi(db: ReplicaDb, req: LocalApiRequest,
                               deps: LocalApiDeps): LocalApiResult {
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
    return ok(titlesPayload(db, q.get("q") ?? "", Number(q.get("limit") ?? 10)));
  }
  if (method === "GET" && path === "/api/block-refs") {
    const requested = (q.get("uids") ?? "").split(",").filter((u) => u.length > 0);
    if (requested.length > 50) return err(422, "too many uids");
    const wanted: BlockUid[] = [];
    for (const raw of requested) {
      const uid = parseBlockUid(raw);
      if (uid === null) return err(422, `malformed uid: '${raw}'`);
      wanted.push(uid);
    }
    return ok(blockRefsPayload(db, wanted));
  }
  if (method === "GET" && path === "/api/sidebar") {
    return ok(sidebarPayload(db));
  }
  if (method === "GET" && path === "/api/search") {
    const exact = q.get("exact") === "1" || q.get("exact") === "true";
    return ok(searchPayload(db, q.get("q") ?? "",
                            Number(q.get("limit") ?? 20), exact));
  }
  if (method === "POST" && path === "/api/pages") {
    const title = canonicalTitle(
      db, String((req.body as { title?: unknown })?.title ?? ""));
    if (title.trim().length === 0) return err(422, "title must not be blank");
    if (titleSyntaxReason(title) !== null) {
      return err(422, `unsupported page-title syntax: ${JSON.stringify(title)}`);
    }
    // local negative id now; the durable create_page op carries the title
    // to the server (get_or_create there — spec section 1)
    getOrCreateLocalPage(db, title, req.nowMs);
    enqueueBatch(db, [{ op: "create_page", page_title: title }], req.nowMs,
                 deps.newBatchId());
    return ok(fetchPage(db, title));
  }
  const blockBacklinksMatch = /^\/api\/block\/([^/]+)\/backlinks$/.exec(path);
  if (method === "GET" && blockBacklinksMatch) {
    const raw = decodeURIComponent(blockBacklinksMatch[1]);
    const uid = parseBlockUid(raw);
    if (uid === null) return err(422, `malformed uid: '${raw}'`);
    const body = blockBacklinks(db, uid);
    return body === null ? err(404, "block not found") : ok(body);
  }
  return NOT_HANDLED;
}

export function blockRefsPayload(db: ReplicaDb,
                                 uids: BlockUid[]): BlockRefsPayload {
  return { block_ref_texts: resolveRefUids(db, uids) };
}

export function sidebarPayload(db: ReplicaDb): SidebarNavPayload {
  // mapped, not asserted -- see the note on PageRow in pages.ts
  const rows = db.select<{ id: SidebarEntryId; title: CanonicalTitle }>(
    "SELECT id, title FROM sidebar_entries ORDER BY order_idx");
  return { entries: rows.map((row): SidebarNavEntry => ({
    id: row.id, title: row.title })) };
}

export function titlesPayload(db: ReplicaDb, qStr: string,
                              limit: number): TitlesPayload {
  const lim = Math.max(1, Math.min(limit, 50));
  const needle = qStr.trim();
  if (needle.length === 0) return { titles: [] };
  const esc = needle.replaceAll("\\", "\\\\").replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  const rows = db.select<{ title: CanonicalTitle }>(
    `SELECT title FROM pages
      WHERE title LIKE ? ESCAPE '\\'
      ORDER BY (CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END),
               length(title), title
      LIMIT ?`, [`%${esc}%`, `${esc}%`, lim]);
  return { titles: rows.map((r) => r.title) };
}
