// pattern: Imperative Shell
// Offline /api/search (pkm-blz2): the same FTS5 MATCH expressions, rank
// ordering and snippet() call as routes_search.py, over the replica's
// self-maintaining local index.

import type { SearchBlockHit, SearchPageHit,
              SearchPayload } from "../../api/payloads";
import type { ReplicaDb } from "../db";
import { escapeFtsQuery } from "./fts";

export function searchPayload(db: ReplicaDb, q: string,
                              limit: number, exact = false): SearchPayload {
  const lim = Math.max(1, Math.min(limit, 100));
  if (q.trim().length === 0) return { pages: [], blocks: [] };
  const match = escapeFtsQuery(q, exact);
  // mapped, not asserted -- see the note on PageRow in pages.ts
  const pages = db.select<{ id: number; title: string }>(
    `SELECT p.id, p.title FROM pages_fts f
      JOIN pages p ON p.id = f.rowid
     WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?`, [match, lim]);
  const blocks = db.select<{ uid: string; page_title: string;
                             snippet: string }>(
    `SELECT b.uid, p.title AS page_title,
            snippet(blocks_fts, 0, '<mark>', '</mark>', '…', 16) AS snippet
       FROM blocks_fts f
       JOIN blocks b ON b.rowid = f.rowid
       JOIN pages p ON p.id = b.page_id
      WHERE blocks_fts MATCH ? ORDER BY rank LIMIT ?`, [match, lim]);
  return {
    pages: pages.map((row): SearchPageHit => ({
      id: row.id, title: row.title })),
    blocks: blocks.map((row): SearchBlockHit => ({
      uid: row.uid, page_title: row.page_title, snippet: row.snippet })),
  };
}
