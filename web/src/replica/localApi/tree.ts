// pattern: Imperative Shell
// Ports of server tree.py (flat rows -> nested tree, ((ref)) collection)
// and the transitive block-ref resolver from routes_pages.py.

import type { ReplicaDb } from "../db";
import { extractRefs } from "../refs";

export interface BlockRow {
  uid: string;
  parent_uid: string | null;
  order_idx: number;
  text: string;
  heading: number | null;
  collapsed: number;
  created_at: number | null;
  updated_at: number | null;
}

export const BLOCK_COLS =
  "uid, parent_uid, order_idx, text, heading, collapsed," +
  " created_at, updated_at";

export interface BlockNodeOut {
  uid: string;
  text: string;
  heading: number | null;
  collapsed: boolean;
  order_idx: number;
  created_at: number | null;
  updated_at: number | null;
  children: BlockNodeOut[];
}

export function buildTree(rows: BlockRow[]): BlockNodeOut[] {
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
  const nodes = (parent: string | null): BlockNodeOut[] => {
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

export type BlockRefTexts = Record<string, { text: string; page_title: string }>;

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

/** Breadcrumb trails: root-first ancestor texts per start uid. */
export function fetchAncestors(db: ReplicaDb,
                               uids: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (uids.length === 0) return out;
  const marks = uids.map(() => "?").join(",");
  const rows = db.select<{ start_uid: string; text: string; depth: number }>(
    `WITH RECURSIVE anc(start_uid, uid, parent_uid, text, depth) AS (
       SELECT uid, uid, parent_uid, text, 0 FROM blocks
        WHERE uid IN (${marks})
       UNION ALL
       SELECT a.start_uid, b.uid, b.parent_uid, b.text, a.depth + 1
         FROM anc a JOIN blocks b ON b.uid = a.parent_uid
        WHERE a.depth < 100
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
