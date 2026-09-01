// pattern: Imperative Shell
// Offline /api/page and /api/unlinked handlers — ports of the
// routes_pages.py read paths over the replica. Daily pages auto-create
// LOCALLY (negative id, no push): the server re-creates them on any
// online visit, and a daily page with content pushes via its block ops'
// page_title anyway (spec section 1).

import type { BacklinkGroup, BlockBacklinksPayload, BlockGroup, CurrentWorkPage,
              CurrentWorkPayload, GroupsPayload, PageMeta,
              PagePayload } from "../../api/payloads";
import { titleForDate } from "../daily";
import type { ReplicaDb } from "../db";
import { getOrCreateLocalPage } from "../localOps";
import { plainSpaceTitleCanonicalizationActive } from "../meta";
import { canonicalizeTitle } from "../titles";
import { phraseQuery } from "./fts";
import { BLOCK_COLS, type BlockRow, blockRefCounts, blockRefTexts, buildTree,
         fetchAncestors } from "./tree";

// db.select<T> ASSERTS its type argument (`selectObjects(...) as T[]`), so
// handing it a generated model would check nothing. Every query that feeds a
// response therefore names a local row type and maps into a checked object
// literal: that map is what turns a renamed or added server-side field into
// a compile error here.
interface PageRow {
  id: number;
  title: string;
  created_at: number | null;
  updated_at: number | null;
}

const localTitle = (db: ReplicaDb, title: string): string =>
  canonicalizeTitle(title, plainSpaceTitleCanonicalizationActive(db));

const fetchPage = (db: ReplicaDb, title: string): PageMeta | null => {
  title = localTitle(db, title);
  const rows = db.select<PageRow>(
    "SELECT id, title, created_at, updated_at FROM pages WHERE title = ?",
    [title]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return { id: row.id, title: row.title, created_at: row.created_at,
           updated_at: row.updated_at };
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

/** Shared with the journal shim, which previews each day's references from
 * the same query rather than a page read per day (pkm-5fak). */
export function backlinks(db: ReplicaDb, pageId: number, offset: number,
                          limit: number):
    { groups: BacklinkGroup[]; total: number; texts: string[] } {
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
  const groups = groupBacklinkRows(
    rows, fetchAncestors(db, rows.map((r) => r.uid)));
  return { groups, total, texts: rows.map((r) => r.text) };
}

/** Rows arrive already ordered; grouping preserves first-seen page order. */
function groupBacklinkRows(rows: BacklinkRow[],
                           ancestors: Map<string, string[]>): BacklinkGroup[] {
  const groups: BacklinkGroup[] = [];
  const index = new Map<number, BacklinkGroup>();
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
  return groups;
}

/** null = block not found: the router 404s. */
export function blockBacklinks(db: ReplicaDb,
                               uid: string): BlockBacklinksPayload | null {
  const exists = db.select<{ one: number }>(
    "SELECT 1 AS one FROM blocks WHERE uid = ?", [uid]);
  if (exists.length === 0) return null;
  const rows = db.select<BacklinkRow>(
    `SELECT b.uid, b.text, p.id AS src_page_id, p.title AS src_page_title
       FROM block_refs r
       JOIN blocks b ON b.uid = r.src_block_uid
       JOIN pages p ON p.id = b.page_id
      WHERE r.target_block_uid = ?
      ORDER BY p.updated_at DESC NULLS LAST, p.title, b.uid`, [uid]);
  return { groups: groupBacklinkRows(
    rows, fetchAncestors(db, rows.map((r) => r.uid))) };
}

/** null = page not found (and not a daily title): the caller 404s. */
export function pagePayload(db: ReplicaDb, title: string, blOffset: number,
                            blLimit: number, nowMs: number): PagePayload | null {
  title = localTitle(db, title);
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
    block_ref_counts: blockRefCounts(db, blocks.map((r) => r.uid)),
  };
}

export function unlinked(db: ReplicaDb, title: string, limit: number,
                         offset: number): GroupsPayload | null {
  title = localTitle(db, title);
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
  const groups: BlockGroup[] = [];
  const index = new Map<number, BlockGroup>();
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

export function currentWorkPayload(db: ReplicaDb,
                                   nowMs: number): CurrentWorkPayload {
  return {
    sections: CURRENT_WORK_SECTIONS.map((section) => {
      const newerThan = nowMs - section.maxAge;
      const olderThan = nowMs - section.minAge;
      const lowerOperator = section.maxAge === 7 * 24 * HOUR_MS ? ">=" : ">";
      return {
        id: section.id,
        title: section.title,
        // the WHERE clause is what makes updated_at non-null here
        pages: db.select<{ id: number; title: string; updated_at: number }>(
          `SELECT id, title, updated_at FROM pages
             WHERE updated_at IS NOT NULL
               AND updated_at ${lowerOperator} ?
               AND updated_at <= ?
             ORDER BY updated_at DESC, title`,
          [newerThan, olderThan],
        ).map((row): CurrentWorkPage => ({
          id: row.id, title: row.title, updated_at: row.updated_at,
        })),
      };
    }),
  };
}

export { fetchPage };
