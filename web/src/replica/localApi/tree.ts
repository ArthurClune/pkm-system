// pattern: Imperative Shell
// Ports of server tree.py (flat rows -> nested tree, ((ref)) collection)
// and the transitive block-ref resolver from routes_pages.py.

import type { BlockNode, PagePayload } from "../../api/payloads";
import type { ReplicaDb } from "../db";
import { extractRefs } from "../refs";

/** A blocks-table row, NOT a response shape: `collapsed` is sqlite's 0/1
 * and there is no children list yet. buildTree turns these into the
 * generated BlockNode the server sends. */
export interface BlockRow {
  uid: string;
  parent_uid: string | null;
  order_idx: number;
  text: string;
  heading: number | null;
  view_type: BlockNode["view_type"];
  collapsed: number;
  created_at: number | null;
  updated_at: number | null;
}

export const BLOCK_COLS =
  "uid, parent_uid, order_idx, text, heading, collapsed," +
  " created_at, updated_at, view_type";

export function buildTree(rows: BlockRow[]): BlockNode[] {
  const known = new Set(rows.map((r) => r.uid));
  const byParent = new Map<string | null, BlockRow[]>();
  for (const r of rows) {
    const parent = r.parent_uid !== null && known.has(r.parent_uid)
      ? r.parent_uid : null;
    const list = byParent.get(parent);
    if (list) list.push(r);
    else byParent.set(parent, [r]);
  }
  const byIdx = (a: BlockRow, b: BlockRow) => a.order_idx - b.order_idx;
  const nodes = (parent: string | null): BlockNode[] => {
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
      heading: r.heading,
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

export function collectBlockRefUids(texts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
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
export function resolveRefUids(db: ReplicaDb, uids: string[]): BlockRefTexts {
  const out: BlockRefTexts = {};
  const seen = new Set<string>();
  let pending = uids;
  for (;;) {
    const fresh = pending.filter((u) => !seen.has(u));
    if (fresh.length === 0) return out;
    fresh.forEach((u) => seen.add(u));
    const marks = fresh.map(() => "?").join(",");
    const rows = db.select<{ uid: string; text: string; page_title: string }>(
      `SELECT b.uid, b.text, p.title AS page_title FROM blocks b
        JOIN pages p ON p.id = b.page_id WHERE b.uid IN (${marks})`, fresh);
    for (const r of rows) {
      out[r.uid] = { text: r.text, page_title: r.page_title };
    }
    pending = collectBlockRefUids(rows.map((r) => r.text));
  }
}

export function blockRefTexts(db: ReplicaDb, texts: string[]): BlockRefTexts {
  return resolveRefUids(db, collectBlockRefUids(texts));
}

/** Incoming ((ref)) count per uid, nonzero entries only (pkm-d31f): one
 * GROUP BY against idx_block_refs_target. Source rows CASCADE with their
 * block, so every counted row has a live source. */
export function blockRefCounts(db: ReplicaDb,
                               uids: string[]): Record<string, number> {
  if (uids.length === 0) return {};
  const marks = uids.map(() => "?").join(",");
  const out: Record<string, number> = {};
  for (const r of db.select<{ target_block_uid: string; n: number }>(
    `SELECT target_block_uid, count(*) AS n FROM block_refs
      WHERE target_block_uid IN (${marks})
      GROUP BY target_block_uid`, uids)) {
    out[r.target_block_uid] = Number(r.n);
  }
  return out;
}

/** Breadcrumb trails: root-first ancestor texts per start uid. */
export function fetchAncestors(db: ReplicaDb,
                               uids: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (uids.length === 0) return out;
  const marks = uids.map(() => "?").join(",");
  const rows = db.select<{ start_uid: string; text: string; depth: number }>(
    `WITH RECURSIVE anc(start_uid, uid, parent_uid, text, depth, path) AS (
       SELECT uid, uid, parent_uid, text, 0, ',' || uid || ',' FROM blocks
        WHERE uid IN (${marks})
       UNION ALL
       SELECT a.start_uid, b.uid, b.parent_uid, b.text, a.depth + 1,
              a.path || b.uid || ','
         FROM anc a JOIN blocks b ON b.uid = a.parent_uid
        WHERE instr(a.path, ',' || b.uid || ',') = 0
     )
     SELECT start_uid, text, depth FROM anc WHERE depth > 0
      ORDER BY start_uid, depth DESC`, uids);
  for (const r of rows) { // depth DESC = root first
    const list = out.get(r.start_uid);
    if (list) list.push(r.text);
    else out.set(r.start_uid, [r.text]);
  }
  return out;
}
