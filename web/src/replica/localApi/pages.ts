// pattern: Imperative Shell
// Offline /api/page and /api/unlinked handlers — ports of the
// routes_pages.py read paths over the replica. Daily pages auto-create
// LOCALLY (negative id, no push): the server re-creates them on any
// online visit, and a daily page with content pushes via its block ops'
// page_title anyway (offline-editing-design.md §1).

import type { BlockUid, PageId } from "../../api/brands";
import type { BacklinkGroup, BlockBacklinksPayload, BlockGroup, CurrentWorkPage,
              CurrentWorkPayload, GroupsPayload, PageMeta,
              PagePayload } from "../../api/payloads";
import { titleForDate } from "../daily";
import type { Columns } from "../columns.gen";
import type { ReplicaDb } from "../db";
import { getOrCreateLocalPage } from "../localOps";
import { canonicalTitle } from "../meta";
import { phraseQuery } from "./fts";
import { type Ancestors, BLOCK_COLS, blockRefCounts, blockRefTexts,
         buildTree, fetchAncestors } from "./tree";

// db.select names `Columns` keys, so a row's types are the vocabulary's and
// the row check verifies them. Every query that feeds a response still maps
// into a checked object literal: that map is what turns a renamed or added
// server-side field into a compile error here.

const fetchPage = (db: ReplicaDb, requested: string): PageMeta | null => {
  const rows = db.select(
    "SELECT id AS page_id, title, created_at, updated_at FROM pages" +
    " WHERE title = ?", ["page_id", "title", "created_at", "updated_at"],
    [canonicalTitle(db, requested)]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return { id: row.page_id, title: row.title, created_at: row.created_at,
           updated_at: row.updated_at };
};

type BacklinkRow = Pick<Columns, "uid" | "text" | "src_page_id"
  | "src_page_title">;

/** responses.STALE_BUNDLE_CRUMB, pinned by shim_parity.json: what a bundle
 * built before `ancestors` shows as an item's whole trail. */
const STALE_BUNDLE_CRUMB = "…";

const HOUR_MS = 60 * 60 * 1000;
const CURRENT_WORK_SECTIONS = [
  { id: "last-24-hours", heading: "Last 24 hours", minAge: 0,
    maxAge: 24 * HOUR_MS },
  { id: "24-to-48-hours", heading: "24–48 hours", minAge: 24 * HOUR_MS,
    maxAge: 48 * HOUR_MS },
  { id: "48-hours-to-7-days", heading: "48 hours–7 days", minAge: 48 * HOUR_MS,
    maxAge: 7 * 24 * HOUR_MS },
] as const;

/** Shared with the journal shim, which previews each day's references from
 * the same query rather than a page read per day. A page's own
 * blocks are excluded even when they reference it, as the server's
 * `_backlinks` and unlinked references do. */
export function backlinks(db: ReplicaDb, pageId: PageId, offset: number,
                          limit: number):
    { groups: BacklinkGroup[]; total: number; texts: string[] } {
  const total = Number(db.select(
    `SELECT count(DISTINCT b.page_id) AS n FROM refs r
      JOIN blocks b ON b.uid = r.src_block_uid
     WHERE r.target_page_id = ? AND b.page_id != ?`, ["n"], [pageId, pageId])[0].n);
  const pageIds = db.select(
    `SELECT DISTINCT b.page_id FROM refs r
      JOIN blocks b ON b.uid = r.src_block_uid
      JOIN pages p ON p.id = b.page_id
     WHERE r.target_page_id = ? AND b.page_id != ?
     ORDER BY p.updated_at DESC NULLS LAST, p.title
     LIMIT ? OFFSET ?`, ["page_id"], [pageId, pageId, limit, offset]).map((r) => r.page_id);
  if (pageIds.length === 0) return { groups: [], total, texts: [] };
  const marks = pageIds.map(() => "?").join(",");
  const rows = db.select(
    `SELECT b.uid, b.text, p.id AS src_page_id, p.title AS src_page_title
       FROM refs r
       JOIN blocks b ON b.uid = r.src_block_uid
       JOIN pages p ON p.id = b.page_id
      WHERE r.target_page_id = ? AND b.page_id IN (${marks})
      ORDER BY p.updated_at DESC NULLS LAST, p.title, b.uid`, ["uid", "text", "src_page_id", "src_page_title"],
    [pageId, ...pageIds]);
  const groups = groupBacklinkRows(
    rows, fetchAncestors(db, rows.map((r) => r.uid)));
  return { groups, total, texts: rows.map((r) => r.text) };
}

/** Rows arrive already ordered; grouping preserves first-seen page order.
 * Each group lists its items' ancestor texts once and items name them by
 * position, numbered as server grouping.group_backlinks numbers them: items
 * in row order, each trail root first. Like the server, an empty trail or
 * list is left out, and `breadcrumbs` is the stale-bundle field. */
function groupBacklinkRows(rows: BacklinkRow[],
                           ancestors: Ancestors): BacklinkGroup[] {
  const groups: BacklinkGroup[] = [];
  const index = new Map<PageId,
    { group: BacklinkGroup; seen: Map<BlockUid, number> }>();
  for (const r of rows) {
    let entry = index.get(r.src_page_id);
    if (!entry) {
      entry = { group: { page_id: r.src_page_id, page_title: r.src_page_title,
                         items: [] }, seen: new Map() };
      index.set(r.src_page_id, entry);
      groups.push(entry.group);
    }
    const { group, seen } = entry;
    const trail = (ancestors.trails.get(r.uid) ?? []).map((uid) => {
      let at = seen.get(uid);
      if (at === undefined) {
        at = seen.size;
        seen.set(uid, at);
      }
      return at;
    });
    group.items.push(trail.length > 0
      ? { uid: r.uid, text: r.text, breadcrumbs: [STALE_BUNDLE_CRUMB],
          ancestors: trail }
      : { uid: r.uid, text: r.text, breadcrumbs: [] });
  }
  for (const { group, seen } of index.values()) {
    if (seen.size > 0) {
      group.ancestor_texts = [...seen.keys()].map((uid) =>
        ancestors.texts[uid]);
    }
  }
  return groups;
}

/** null = block not found: the router 404s. */
export function blockBacklinks(db: ReplicaDb,
                               uid: BlockUid): BlockBacklinksPayload | null {
  const exists = db.select(
    "SELECT 1 AS n FROM blocks WHERE uid = ?", ["n"], [uid]);
  if (exists.length === 0) return null;
  const rows = db.select(
    `SELECT b.uid, b.text, p.id AS src_page_id, p.title AS src_page_title
       FROM block_refs r
       JOIN blocks b ON b.uid = r.src_block_uid
       JOIN pages p ON p.id = b.page_id
      WHERE r.target_block_uid = ?
      ORDER BY p.updated_at DESC NULLS LAST, p.title, b.uid`, ["uid", "text", "src_page_id", "src_page_title"], [uid]);
  return { groups: groupBacklinkRows(
    rows, fetchAncestors(db, rows.map((r) => r.uid))) };
}

/** null = page not found (and not a daily title): the caller 404s. */
export function pagePayload(db: ReplicaDb, requested: string, blOffset: number,
                            blLimit: number, nowMs: number): PagePayload | null {
  const title = canonicalTitle(db, requested);
  const limit = Math.max(1, Math.min(blLimit, 100));
  let page = fetchPage(db, title);
  if (page === null) {
    // Mirror of the server rule: only TODAY auto-creates
    // on read; other daily titles 404 like normal pages.
    if (title !== titleForDate(new Date(nowMs))) return null;
    getOrCreateLocalPage(db, title, nowMs); // local only, no push
    page = fetchPage(db, title);
    if (page === null) return null; // unreachable
  }
  const blocks = db.select(
    `SELECT ${BLOCK_COLS} FROM blocks WHERE page_id = ?`,
      ["uid", "text", "parent_uid", "order_idx", "created_at", "updated_at", "heading", "view_type",
       "collapsed"], [page.id]);
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

export function unlinked(db: ReplicaDb, requested: string, limit: number,
                         offset: number): GroupsPayload | null {
  const title = canonicalTitle(db, requested);
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
  const total = Number(db.select(
    `SELECT count(*) AS n ${where}`, ["n"], params)[0].n);
  const rows = db.select(
    `SELECT b.uid, b.text, p.id AS page_id, p.title AS page_title
     ${where} ORDER BY p.title, b.uid LIMIT ? OFFSET ?`, ["uid", "text", "page_id", "page_title"],
    [...params, lim, offset]);
  const groups: BlockGroup[] = [];
  const index = new Map<PageId, BlockGroup>();
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
        heading: section.heading,
        // the WHERE clause is what makes the page's edit time non-null
        pages: db.select(
          `SELECT id AS page_id, title, updated_at AS edited_at FROM pages
             WHERE updated_at IS NOT NULL
               AND updated_at ${lowerOperator} ?
               AND updated_at <= ?
             ORDER BY updated_at DESC, title`, ["page_id", "title", "edited_at"],
          [newerThan, olderThan],
        ).map((row): CurrentWorkPage => ({
          id: row.page_id, title: row.title, updated_at: row.edited_at,
        })),
      };
    }),
  };
}

export { fetchPage };
