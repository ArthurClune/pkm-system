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
import type { OrderIdx } from "../../api/brands";
import type { Snapshot } from "../../replica/apply";
import type { ReplicaDb } from "../../replica/db";
import { sha256Hex } from "../../replica/sha256";

/** `key` and `parentKey` are block uids, or the positional names
 * canonicaliseMintedUids gives the ones the server minted, which are not
 * uids. */
export interface NormalBlock {
  key: string;
  page: string;
  parentKey: string | null;
  order_idx: OrderIdx;
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
  /** Sorted by key. */
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

const byKey = (a: NormalBlock, b: NormalBlock): number =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

const pageName = (titles: ReadonlyMap<number, string>, id: number): string =>
  titles.get(id) ?? `?page ${id}`;

export function fromSnapshot(s: Snapshot, opts: NormaliseOptions = {}): NormalGraph {
  const titles = new Map<number, string>(s.pages.map((p) => [p.id, p.title]));
  const blocks = s.blocks.map((b): NormalBlock => ({
    key: b.uid,
    page: pageName(titles, b.page_id),
    parentKey: b.parent_uid,
    order_idx: b.order_idx,
    text: b.text,
    heading: b.heading,
    collapsed: b.collapsed,
    view_type: b.view_type,
    refs: b.refs.map((r) => `${r.kind}:${pageName(titles, r.target_page_id)}`).sort(),
    ...(opts.timestamps ? { stamps: stamp(b.created_at, b.updated_at) } : {}),
  })).sort(byKey);
  return {
    pages: s.pages.map((p) => p.title).sort(),
    blocks,
    ...(opts.timestamps
      ? { pageStamps: Object.fromEntries(
          s.pages.map((p) => [p.title, stamp(p.created_at, p.updated_at)])) }
      : {}),
  };
}


/** The replica's graph tables, without timestamps. A row naming a page the
 * replica does not hold reads as `?page N` through `pageName`, as in
 * fromSnapshot: the placeholder is made here, never selected into a key. */
export function fromReplica(db: ReplicaDb): NormalGraph {
  const titles = new Map<number, string>(
    db.select("SELECT id AS page_id, title FROM pages", ["page_id", "title"])
      .map((p) => [p.page_id, p.title]));
  const refs = new Map<string, string[]>();
  for (const r of db.select(
    "SELECT src_block_uid, target_page_id, kind AS ref_kind FROM refs",
    ["src_block_uid", "target_page_id", "ref_kind"])) {
    const list = refs.get(r.src_block_uid) ?? [];
    list.push(`${r.ref_kind}:${pageName(titles, r.target_page_id)}`);
    refs.set(r.src_block_uid, list);
  }
  const blocks = db.select(
    "SELECT uid, page_id, parent_uid, order_idx, text, heading, collapsed, view_type" +
    " FROM blocks",
    ["uid", "page_id", "parent_uid", "order_idx", "text", "heading", "collapsed", "view_type"],
  ).map((b): NormalBlock => ({
    key: b.uid,
    page: pageName(titles, b.page_id),
    parentKey: b.parent_uid,
    order_idx: b.order_idx,
    text: b.text,
    heading: b.heading,
    collapsed: b.collapsed,
    view_type: b.view_type,
    refs: (refs.get(b.uid) ?? []).sort(),
  })).sort(byKey);
  return { pages: [...titles.values()].sort(), blocks };
}

const FIELDS = ["page", "parentKey", "order_idx", "text", "heading", "collapsed",
                "view_type", "refs", "stamps"] as const;

const show = (v: unknown): string => JSON.stringify(v) ?? "undefined";

/** Texts longer than this are named in a difference by length and hash. */
const LONG_TEXT = 200;

/** Whether two field values differ. A string is compared as itself, which
 * for an equal pair costs nothing like serialising the megabyte texts the
 * limits draw, as every comparison in a step otherwise would. */
export const fieldsDiffer = (a: unknown, b: unknown): boolean =>
  typeof a === "string" && typeof b === "string" ? a !== b : show(a) !== show(b);

/** A field value as a difference shows it: a long text by its length and
 * hash, where printing it would be a megabyte to one line. */
export const showField = (v: unknown): string =>
  typeof v === "string" && v.length > LONG_TEXT
    ? `<${v.length} UTF-16 units, sha256 ${sha256Hex(v).slice(0, 16)}>`
    : show(v);

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
  const ba = new Map(a.blocks.map((x) => [x.key, x]));
  const bb = new Map(b.blocks.map((x) => [x.key, x]));
  for (const uid of [...new Set([...ba.keys(), ...bb.keys()])].sort()) {
    const x = ba.get(uid);
    const y = bb.get(uid);
    if (!y) { lines.push(`block ${uid}: only in ${na}`); continue; }
    if (!x) { lines.push(`block ${uid}: only in ${nb}`); continue; }
    for (const f of FIELDS) {
      if (fieldsDiffer(x[f], y[f])) {
        lines.push(`block ${uid}: ${f} ${showField(x[f])} (${na})` +
                   ` vs ${showField(y[f])} (${nb})`);
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
    const named: Record<string, unknown> = { ...op };
    for (const field of ["uid", "parent_uid"]) {
      const value = named[field];
      if (typeof value === "string") uids.add(value);
    }
  }
  return uids;
}

/** Renames every block uid not in `known` -- the uids the server mints at
 * random for conflict headers, landed entries and the copies of a diverged
 * delete -- to a name built from its position: its parent's name (or
 * `[page]` at the top level) and its position, as `~[Page]/20/0`. Two runs
 * that minted different uids for the same blocks then compare equal, and
 * any difference in those blocks still shows. Positions shared by more than
 * one minted block are told apart by text, as `#1`, `#2`. The rename covers
 * parentKey and any mention of the uid in text. */
export function canonicaliseMintedUids(g: NormalGraph,
                                       known: ReadonlySet<string>): NormalGraph {
  const blocks = new Map(g.blocks.map((b) => [b.key, b]));
  const names = new Map<string, string>();
  const nameOf = (key: string, seen: ReadonlySet<string>): string => {
    const b = blocks.get(key);
    if (known.has(key) || !b || seen.has(key)) return key;
    const cached = names.get(key);
    if (cached !== undefined) return cached;
    const parent = b.parentKey === null
      ? `~[${b.page}]`
      : nameOf(b.parentKey, new Set([...seen, key]));
    const name = `${parent.startsWith("~") ? parent : `~${parent}`}/${b.order_idx}`;
    names.set(key, name);
    return name;
  };
  const minted = g.blocks.filter((b) => !known.has(b.key));
  for (const b of minted) nameOf(b.key, new Set());
  // Two minted blocks at one position: tell them apart by text.
  const groups = new Map<string, NormalBlock[]>();
  for (const b of minted) {
    const name = names.get(b.key) ?? b.key;
    groups.set(name, [...(groups.get(name) ?? []), b]);
  }
  for (const [name, group] of groups) {
    if (group.length < 2) continue;
    [...group].sort((x, y) => (x.text < y.text ? -1 : x.text > y.text ? 1 : 0))
      .forEach((b, i) => names.set(b.key, `${name}#${i + 1}`));
  }
  const rename = (key: string | null): string | null =>
    key === null ? null : names.get(key) ?? key;
  const renameText = (text: string): string =>
    [...names].reduce((t, [from, to]) => t.split(from).join(to), text);
  return {
    ...g,
    blocks: g.blocks.map((b) => ({
      ...b,
      key: rename(b.key) ?? b.key,
      parentKey: rename(b.parentKey),
      text: renameText(b.text),
    })).sort(byKey),
  };
}
