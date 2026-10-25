// pattern: Imperative Shell
// Ports of server tree.py (flat rows -> nested tree, ((ref)) collection)
// and the transitive block-ref resolver from routes_pages.py.

import type { BlockUid } from "../../api/brands";
import type { BlockNode, PagePayload } from "../../api/payloads";
import type { Columns } from "../columns.gen";
import type { ReplicaDb } from "../db";
import { extractRefs } from "../refs";

/** A blocks-table row, NOT a response shape: `collapsed` is sqlite's 0/1,
 * `heading` is the raw stored column (see storedHeading below), and there
 * is no children list yet. buildTree turns these into the generated
 * BlockNode the server sends. */
export type BlockRow = Pick<Columns, "uid" | "parent_uid" | "order_idx"
  | "text" | "heading" | "view_type" | "collapsed" | "created_at"
  | "updated_at">;

export const BLOCK_COLS =
  "uid, parent_uid, order_idx, text, heading, collapsed," +
  " created_at, updated_at, view_type";

/** Roam's export writes a 0 for "no heading"; older imports stored it as-is
 * (server/src/pkm/contracts/responses.py's StoredHeading coerces it on every
 * fresh read, but a replica synced before that fix may still hold a stale
 * 0 locally until that block's row changes again). 0 means the same thing
 * null means everywhere else a heading is read, so it is normalized here
 * too -- this is the one place a raw blocks.heading column turns into the
 * BlockNode shape the rest of the app reads. */
function storedHeading(value: number | null): BlockNode["heading"] {
  // Nothing validates the column beyond this: a replica row holding
  // anything other than 0/1/2/3/null would already be as unvalidated as
  // it is today, upstream of this fix.
  return value === 0 ? null : (value as BlockNode["heading"]);
}

export function buildTree(rows: BlockRow[]): BlockNode[] {
  const known = new Set(rows.map((r) => r.uid));
  const byParent = new Map<BlockUid | null, BlockRow[]>();
  for (const r of rows) {
    const parent = r.parent_uid !== null && known.has(r.parent_uid)
      ? r.parent_uid : null;
    const list = byParent.get(parent);
    if (list) list.push(r);
    else byParent.set(parent, [r]);
  }
  const byIdx = (a: BlockRow, b: BlockRow) => a.order_idx - b.order_idx;
  const nodes = (parent: BlockUid | null): BlockNode[] => {
    const items = byParent.get(parent) ?? [];
    let children: BlockRow[];
    if (parent === null) {
      // normal roots first, then orphans (blocks whose parent is missing)
      const normal = items.filter((r) => r.parent_uid === null).sort(byIdx);
      const orphans = items.filter((r) => r.parent_uid !== null).sort(byIdx);
      children = [...normal, ...orphans];
    } else {
      children = [...items].sort(byIdx);
    }
    return children.map((r) => ({
      uid: r.uid,
      text: r.text,
      heading: storedHeading(r.heading),
      view_type: r.view_type,
      collapsed: r.collapsed !== 0,
      order_idx: r.order_idx,
      created_at: r.created_at,
      updated_at: r.updated_at,
      children: nodes(r.uid),
    }));
  };
  return nodes(null);
}

export function collectBlockRefUids(texts: string[]): BlockUid[] {
  const seen = new Set<BlockUid>();
  const out: BlockUid[] = [];
  for (const text of texts) {
    for (const uid of extractRefs(text).blockRefs) {
      if (!seen.has(uid)) {
        seen.add(uid);
        out.push(uid);
      }
    }
  }
  return out;
}

export type BlockRefTexts = PagePayload["block_ref_texts"];

/** Resolve ((refs)) transitively — a referenced block's own text may embed
 * further ((refs)); the seen set terminates cycles. */
export function resolveRefUids(db: ReplicaDb, uids: BlockUid[]): BlockRefTexts {
  const out: BlockRefTexts = {};
  const seen = new Set<BlockUid>();
  let pending = uids;
  for (;;) {
    const fresh = pending.filter((u) => !seen.has(u));
    if (fresh.length === 0) return out;
    fresh.forEach((u) => seen.add(u));
    const marks = fresh.map(() => "?").join(",");
    const rows = db.select(
      `SELECT b.uid, b.text, p.title AS page_title FROM blocks b
        JOIN pages p ON p.id = b.page_id WHERE b.uid IN (${marks})`, ["uid", "text", "page_title"], fresh);
    for (const r of rows) {
      out[r.uid] = { text: r.text, page_title: r.page_title };
    }
    pending = collectBlockRefUids(rows.map((r) => r.text));
  }
}

export function blockRefTexts(db: ReplicaDb, texts: string[]): BlockRefTexts {
  return resolveRefUids(db, collectBlockRefUids(texts));
}

/** Incoming ((ref)) count per uid, nonzero entries only: one
 * GROUP BY against idx_block_refs_target. Source rows CASCADE with their
 * block, so every counted row has a live source. */
export function blockRefCounts(db: ReplicaDb,
                               uids: BlockUid[]): Record<string, number> {
  if (uids.length === 0) return {};
  const marks = uids.map(() => "?").join(",");
  const out: Record<string, number> = {};
  for (const r of db.select(
    `SELECT target_block_uid, count(*) AS n FROM block_refs
      WHERE target_block_uid IN (${marks})
      GROUP BY target_block_uid`, ["n", "target_block_uid"], uids)) {
    out[r.target_block_uid] = Number(r.n);
  }
  return out;
}

/** Each start's breadcrumb trail, root first, from `uid -> [parent_uid,
 * text]`: the parent links followed up to a uid missing from `blocks` or
 * one already on the trail (the start counts), so a corrupt parent cycle
 * ends rather than repeating. Starts with no ancestor in `blocks` are
 * absent. Mirrors server tree.ancestor_texts. */
export function ancestorTexts(
  starts: readonly BlockUid[],
  blocks: ReadonlyMap<BlockUid, readonly [BlockUid | null, string]>,
): Map<BlockUid, string[]> {
  const out = new Map<BlockUid, string[]>();
  for (const start of new Set(starts)) {
    const first = blocks.get(start);
    if (!first) continue;
    const seen = new Set<BlockUid>([start]);
    const trail: string[] = [];
    let parent = first[0];
    while (parent !== null && !seen.has(parent)) {
      const row = blocks.get(parent);
      if (!row) break;
      seen.add(parent);
      trail.push(row[1]);
      parent = row[0];
    }
    if (trail.length > 0) out.set(start, trail.reverse());
  }
  return out;
}

/** Breadcrumb trails: root-first ancestor texts per start uid. Mirrors
 * routes_pages._fetch_ancestors: the CTE holds `uid` alone and joins with
 * UNION, which queues a row only once, so each distinct ancestor is read
 * once and a corrupt parent cycle ends the walk. It must never carry a
 * per-row path string: one row per (start, ancestor), each copying an
 * O(depth) string, made breadcrumbs cost O(depth^3). */
export function fetchAncestors(db: ReplicaDb,
                               uids: BlockUid[]): Map<BlockUid, string[]> {
  if (uids.length === 0) return new Map();
  const marks = uids.map(() => "?").join(",");
  const blocks = new Map<BlockUid, readonly [BlockUid | null, string]>();
  for (const r of db.select(
    `WITH RECURSIVE anc(uid) AS (
       SELECT uid FROM blocks WHERE uid IN (${marks})
       UNION
       SELECT b.parent_uid FROM anc a JOIN blocks b ON b.uid = a.uid
        WHERE b.parent_uid IS NOT NULL
     )
     SELECT b.uid, b.parent_uid, b.text
       FROM anc JOIN blocks b ON b.uid = anc.uid`,
    ["uid", "parent_uid", "text"], uids)) {
    blocks.set(r.uid, [r.parent_uid, r.text]);
  }
  return ancestorTexts(uids, blocks);
}
