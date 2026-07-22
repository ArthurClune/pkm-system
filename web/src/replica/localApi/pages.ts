// pattern: Imperative Shell
// Offline /api/page and /api/unlinked handlers — ports of the
// routes_pages.py read paths over the replica. Daily pages auto-create
// LOCALLY (negative id, no push): the server re-creates them on any
// online visit, and a daily page with content pushes via its block ops'
// page_title anyway (spec section 1).

import { titleForDate } from "../daily";
import type { ReplicaDb } from "../db";
import { getOrCreateLocalPage } from "../localOps";
import { phraseQuery } from "./fts";
import { BLOCK_COLS, type BlockRow, blockRefTexts, buildTree,
         fetchAncestors } from "./tree";

interface PageRow {
  id: number;
  title: string;
  created_at: number | null;
  updated_at: number | null;
}

const fetchPage = (db: ReplicaDb, title: string): PageRow | null => {
  const rows = db.select<PageRow>(
    "SELECT id, title, created_at, updated_at FROM pages WHERE title = ?",
    [title]);
  return rows.length > 0 ? rows[0] : null;
};

interface BacklinkRow {
  uid: string;
  text: string;
  src_page_id: number;
  src_page_title: string;
}

const HOUR_MS = 60 * 60 * 1000;
const CURRENT_WORK_SECTIONS = [
  { id: "last-24-hours", title: "Last 24 hours", minAge: 0,
    maxAge: 24 * HOUR_MS },
  { id: "24-to-48-hours", title: "24–48 hours", minAge: 24 * HOUR_MS,
    maxAge: 48 * HOUR_MS },
  { id: "48-hours-to-7-days", title: "48 hours–7 days", minAge: 48 * HOUR_MS,
    maxAge: 7 * 24 * HOUR_MS },
] as const;

function backlinks(db: ReplicaDb, pageId: number, offset: number,
                   limit: number) {
  const total = Number(db.select<{ n: number }>(
    `SELECT count(DISTINCT b.page_id) AS n FROM refs r
      JOIN blocks b ON b.uid = r.src_block_uid
     WHERE r.target_page_id = ?`, [pageId])[0].n);
  const pageIds = db.select<{ page_id: number }>(
    `SELECT DISTINCT b.page_id FROM refs r
      JOIN blocks b ON b.uid = r.src_block_uid
      JOIN pages p ON p.id = b.page_id
     WHERE r.target_page_id = ?
     ORDER BY p.updated_at DESC NULLS LAST, p.title
     LIMIT ? OFFSET ?`, [pageId, limit, offset]).map((r) => r.page_id);
  if (pageIds.length === 0) return { groups: [], total, texts: [] };
  const marks = pageIds.map(() => "?").join(",");
  const rows = db.select<BacklinkRow>(
    `SELECT b.uid, b.text, p.id AS src_page_id, p.title AS src_page_title
       FROM refs r
       JOIN blocks b ON b.uid = r.src_block_uid
       JOIN pages p ON p.id = b.page_id
      WHERE r.target_page_id = ? AND b.page_id IN (${marks})
      ORDER BY p.updated_at DESC NULLS LAST, p.title, b.uid`,
    [pageId, ...pageIds]);
  const ancestors = fetchAncestors(db, rows.map((r) => r.uid));
  const groups: { page_id: number; page_title: string;
                  items: { uid: string; text: string; breadcrumbs: string[] }[] }[] = [];
  const index = new Map<number, (typeof groups)[number]>();
  for (const r of rows) {
    let group = index.get(r.src_page_id);
    if (!group) {
      group = { page_id: r.src_page_id, page_title: r.src_page_title,
                items: [] };
      index.set(r.src_page_id, group);
      groups.push(group);
    }
    group.items.push({ uid: r.uid, text: r.text,
                       breadcrumbs: ancestors.get(r.uid) ?? [] });
  }
  return { groups, total, texts: rows.map((r) => r.text) };
}

/** null = page not found (and not a daily title): the caller 404s. */
export function pagePayload(db: ReplicaDb, title: string, blOffset: number,
                            blLimit: number, nowMs: number): unknown | null {
  const limit = Math.max(1, Math.min(blLimit, 100));
  let page = fetchPage(db, title);
  if (page === null) {
    // Mirror of the server rule (bean pkm-fy52): only TODAY auto-creates
    // on read; other daily titles 404 like normal pages.
    if (title !== titleForDate(new Date(nowMs))) return null;
    getOrCreateLocalPage(db, title, nowMs); // local only, no push
    page = fetchPage(db, title);
    if (page === null) return null; // unreachable
  }
  const blocks = db.select<BlockRow>(
    `SELECT ${BLOCK_COLS} FROM blocks WHERE page_id = ?`, [page.id]);
  const bl = backlinks(db, page.id, blOffset, limit);
  return {
    page,
    blocks: buildTree(blocks),
    backlinks: { groups: bl.groups, total_pages: bl.total,
                 offset: blOffset, limit },
    block_ref_texts: blockRefTexts(
      db, [...blocks.map((r) => r.text), ...bl.texts]),
  };
}

export function unlinked(db: ReplicaDb, title: string, limit: number,
                         offset: number): unknown | null {
  const lim = Math.max(1, Math.min(limit, 100));
  const page = fetchPage(db, title);
  if (page === null) return null;
  const where = `FROM blocks_fts f
                 JOIN blocks b ON b.rowid = f.rowid
                 JOIN pages p ON p.id = b.page_id
                WHERE blocks_fts MATCH ? AND b.page_id != ?
                  AND NOT EXISTS (SELECT 1 FROM refs r
                                   WHERE r.src_block_uid = b.uid
                                     AND r.target_page_id = ?)`;
  const params = [phraseQuery(title), page.id, page.id];
  const total = Number(db.select<{ n: number }>(
    `SELECT count(*) AS n ${where}`, params)[0].n);
  const rows = db.select<{ uid: string; text: string; page_id: number;
                           page_title: string }>(
    `SELECT b.uid, b.text, p.id AS page_id, p.title AS page_title
     ${where} ORDER BY p.title, b.uid LIMIT ? OFFSET ?`,
    [...params, lim, offset]);
  const groups: { page_id: number; page_title: string;
                  items: { uid: string; text: string }[] }[] = [];
  const index = new Map<number, (typeof groups)[number]>();
  for (const r of rows) {
    let group = index.get(r.page_id);
    if (!group) {
      group = { page_id: r.page_id, page_title: r.page_title, items: [] };
      index.set(r.page_id, group);
      groups.push(group);
    }
    group.items.push({ uid: r.uid, text: r.text });
  }
  return { groups, total };
}

export function currentWorkPayload(db: ReplicaDb, nowMs: number): unknown {
  return {
    sections: CURRENT_WORK_SECTIONS.map((section) => {
      const newerThan = nowMs - section.maxAge;
      const olderThan = nowMs - section.minAge;
      const lowerOperator = section.maxAge === 7 * 24 * HOUR_MS ? ">=" : ">";
      return {
        id: section.id,
        title: section.title,
        pages: db.select(
          `SELECT id, title, updated_at FROM pages
             WHERE updated_at IS NOT NULL
               AND updated_at ${lowerOperator} ?
               AND updated_at <= ?
             ORDER BY updated_at DESC, title`,
          [newerThan, olderThan],
        ),
      };
    }),
  };
}

export { fetchPage };
