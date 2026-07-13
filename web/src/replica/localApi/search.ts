// pattern: Imperative Shell
// Offline /api/search (pkm-blz2): the same FTS5 MATCH expressions, rank
// ordering and snippet() call as routes_search.py, over the replica's
// self-maintaining local index.

import type { ReplicaDb } from "../db";
import { escapeFtsQuery } from "./fts";

export function searchPayload(db: ReplicaDb, q: string,
                              limit: number): unknown {
  const lim = Math.max(1, Math.min(limit, 100));
  if (q.trim().length === 0) return { pages: [], blocks: [] };
  const match = escapeFtsQuery(q);
  const pages = db.select(
    `SELECT p.id, p.title FROM pages_fts f
      JOIN pages p ON p.id = f.rowid
     WHERE pages_fts MATCH ? ORDER BY rank LIMIT ?`, [match, lim]);
  const blocks = db.select(
    `SELECT b.uid, p.title AS page_title,
            snippet(blocks_fts, 0, '<mark>', '</mark>', '…', 16) AS snippet
       FROM blocks_fts f
       JOIN blocks b ON b.rowid = f.rowid
       JOIN pages p ON p.id = b.page_id
      WHERE blocks_fts MATCH ? ORDER BY rank LIMIT ?`, [match, lim]);
  return { pages, blocks };
}
