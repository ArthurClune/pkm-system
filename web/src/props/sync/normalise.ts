// pattern: Functional Core
// The sync oracle's common form for a graph, so a replica and the server's
// snapshot (or two snapshots) compare like with like:
//   - pages and ref targets by title, never by id: a replica's offline-made
//     page has a local negative id until the feed reconciles it, and two
//     servers can number the same pages differently;
//   - timestamps only on request: a replica's optimistic writes stamp the
//     client's clock and the feed may never overwrite them, but a serial
//     replay under the same frozen server clock reproduces them exactly;
//   - refs as `kind:title`, sorted, per block;
//   - only the graph tables (pages, blocks, refs): sidebar and block_refs
//     are outside what sync is checked for here.
// fromReplica reads through the handle it is given and writes nothing.
import type { Snapshot } from "../../replica/apply";
import type { ReplicaDb } from "../../replica/db";

export interface NormalBlock {
  uid: string;
  page: string;
  parent_uid: string | null;
  order_idx: number;
  text: string;
  heading: number | null;
  collapsed: number;
  view_type: string | null;
  /** `kind:target title`, sorted. */
  refs: string[];
  /** `created_at/updated_at`, present only when timestamps were asked for. */
  stamps?: string;
}

export interface NormalGraph {
  /** Sorted titles. */
  pages: string[];
  /** Sorted by uid. */
  blocks: NormalBlock[];
  /** Title -> `created_at/updated_at`, present only when timestamps were
   * asked for. */
  pageStamps?: Record<string, string>;
}

export interface NormaliseOptions {
  timestamps?: boolean;
}

const stamp = (created: number | null | undefined,
               updated: number | null | undefined): string =>
  `${created ?? "null"}/${updated ?? "null"}`;

const byUid = (a: NormalBlock, b: NormalBlock): number =>
  a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;

const pageName = (titles: ReadonlyMap<number, string>, id: number): string =>
  titles.get(id) ?? `?page ${id}`;

export function fromSnapshot(s: Snapshot, opts: NormaliseOptions = {}): NormalGraph {
  const titles = new Map<number, string>(s.pages.map((p) => [p.id, p.title]));
  const blocks = s.blocks.map((b): NormalBlock => ({
    uid: b.uid,
    page: pageName(titles, b.page_id),
    parent_uid: b.parent_uid,
    order_idx: b.order_idx,
    text: b.text,
    heading: b.heading,
    collapsed: b.collapsed,
    view_type: b.view_type,
    refs: b.refs.map((r) => `${r.kind}:${pageName(titles, r.target_page_id)}`).sort(),
    ...(opts.timestamps ? { stamps: stamp(b.created_at, b.updated_at) } : {}),
  })).sort(byUid);
  return {
    pages: s.pages.map((p) => p.title).sort(),
    blocks,
    ...(opts.timestamps
      ? { pageStamps: Object.fromEntries(
          s.pages.map((p) => [p.title, stamp(p.created_at, p.updated_at)])) }
      : {}),
  };
}

interface BlockRow {
  uid: string;
  page: string | null;
  page_id: number;
  parent_uid: string | null;
  order_idx: number;
  text: string;
  heading: number | null;
  collapsed: number;
  view_type: string | null;
}

/** The replica's graph tables, without timestamps. */
export function fromReplica(db: ReplicaDb): NormalGraph {
  const pages = db.select<{ title: string }>("SELECT title FROM pages")
    .map((p) => p.title).sort();
  const refs = new Map<string, string[]>();
  for (const r of db.select<{ uid: string; kind: string; title: string | null;
                               target: number }>(
    "SELECT r.src_block_uid AS uid, r.kind, p.title, r.target_page_id AS target" +
    " FROM refs r LEFT JOIN pages p ON p.id = r.target_page_id")) {
    const list = refs.get(r.uid) ?? [];
    list.push(`${r.kind}:${r.title ?? `?page ${r.target}`}`);
    refs.set(r.uid, list);
  }
  const blocks = db.select<BlockRow>(
    "SELECT b.uid, p.title AS page, b.page_id, b.parent_uid, b.order_idx," +
    " b.text, b.heading, b.collapsed, b.view_type" +
    " FROM blocks b LEFT JOIN pages p ON p.id = b.page_id",
  ).map((b): NormalBlock => ({
    uid: b.uid,
    page: b.page ?? `?page ${b.page_id}`,
    parent_uid: b.parent_uid,
    order_idx: b.order_idx,
    text: b.text,
    heading: b.heading,
    collapsed: b.collapsed,
    view_type: b.view_type,
    refs: (refs.get(b.uid) ?? []).sort(),
  })).sort(byUid);
  return { pages, blocks };
}

const FIELDS = ["page", "parent_uid", "order_idx", "text", "heading", "collapsed",
                "view_type", "refs", "stamps"] as const;

const show = (v: unknown): string => JSON.stringify(v) ?? "undefined";

/** null when equal; otherwise one line per differing page or block field,
 * naming the uid (or title) and both values. Nothing is left out. */
export function diffGraphs(a: NormalGraph, b: NormalGraph,
                           names: readonly [string, string] = ["a", "b"]): string | null {
  const [na, nb] = names;
  const lines: string[] = [];
  const pa = new Set(a.pages);
  const pb = new Set(b.pages);
  for (const t of [...new Set([...a.pages, ...b.pages])].sort()) {
    if (!pb.has(t)) lines.push(`page ${t}: only in ${na}`);
    else if (!pa.has(t)) lines.push(`page ${t}: only in ${nb}`);
    else if (a.pageStamps?.[t] !== b.pageStamps?.[t]) {
      lines.push(`page ${t}: stamps ${show(a.pageStamps?.[t])} (${na})` +
                 ` vs ${show(b.pageStamps?.[t])} (${nb})`);
    }
  }
  const ba = new Map(a.blocks.map((x) => [x.uid, x]));
  const bb = new Map(b.blocks.map((x) => [x.uid, x]));
  for (const uid of [...new Set([...ba.keys(), ...bb.keys()])].sort()) {
    const x = ba.get(uid);
    const y = bb.get(uid);
    if (!y) { lines.push(`block ${uid}: only in ${na}`); continue; }
    if (!x) { lines.push(`block ${uid}: only in ${nb}`); continue; }
    for (const f of FIELDS) {
      if (show(x[f]) !== show(y[f])) {
        lines.push(`block ${uid}: ${f} ${show(x[f])} (${na}) vs ${show(y[f])} (${nb})`);
      }
    }
  }
  return lines.length === 0 ? null : lines.join("\n");
}

/** Every uid and parent uid the ops in one POST /api/ops body name. */
export function opUids(body: string): Set<string> {
  const uids = new Set<string>();
  const parsed = JSON.parse(body) as { ops?: unknown };
  for (const op of Array.isArray(parsed.ops) ? parsed.ops as unknown[] : []) {
    if (!op || typeof op !== "object") continue;
    const { uid, parent_uid: parent } = op as { uid?: unknown; parent_uid?: unknown };
    if (typeof uid === "string") uids.add(uid);
    if (typeof parent === "string") uids.add(parent);
  }
  return uids;
}

/** Renames every block uid not in `known` -- the uids the server mints at
 * random for conflict headers, landed entries and the copies of a diverged
 * delete -- to a name built from its position: its parent's name (or
 * `[page]` at the top level) and its order_idx, as `~[Page]/20/0`. Two runs
 * that minted different uids for the same blocks then compare equal, and
 * any difference in those blocks still shows. Positions shared by more than
 * one minted block are told apart by text, as `#1`, `#2`. The rename covers
 * parent_uid and any mention of the uid in text. */
export function canonicaliseMintedUids(g: NormalGraph,
                                       known: ReadonlySet<string>): NormalGraph {
  const blocks = new Map(g.blocks.map((b) => [b.uid, b]));
  const names = new Map<string, string>();
  const nameOf = (uid: string, seen: ReadonlySet<string>): string => {
    const b = blocks.get(uid);
    if (known.has(uid) || !b || seen.has(uid)) return uid;
    const cached = names.get(uid);
    if (cached !== undefined) return cached;
    const parent = b.parent_uid === null
      ? `~[${b.page}]`
      : nameOf(b.parent_uid, new Set([...seen, uid]));
    const name = `${parent.startsWith("~") ? parent : `~${parent}`}/${b.order_idx}`;
    names.set(uid, name);
    return name;
  };
  const minted = g.blocks.filter((b) => !known.has(b.uid));
  for (const b of minted) nameOf(b.uid, new Set());
  // Two minted blocks at one position: tell them apart by text.
  const groups = new Map<string, NormalBlock[]>();
  for (const b of minted) {
    const name = names.get(b.uid) ?? b.uid;
    groups.set(name, [...(groups.get(name) ?? []), b]);
  }
  for (const [name, group] of groups) {
    if (group.length < 2) continue;
    [...group].sort((x, y) => (x.text < y.text ? -1 : x.text > y.text ? 1 : 0))
      .forEach((b, i) => names.set(b.uid, `${name}#${i + 1}`));
  }
  const rename = (uid: string | null): string | null =>
    uid === null ? null : names.get(uid) ?? uid;
  const renameText = (text: string): string =>
    [...names].reduce((t, [from, to]) => t.split(from).join(to), text);
  return {
    ...g,
    blocks: g.blocks.map((b) => ({
      ...b,
      uid: rename(b.uid) ?? b.uid,
      parent_uid: rename(b.parent_uid),
      text: renameText(b.text),
    })).sort(byUid),
  };
}
