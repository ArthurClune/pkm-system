// pattern: Functional Core
// What the ops property draws: a start state of three outline pages, the
// batch that seeds it on the server, raw op batches and whole examples.
//
// A raw batch is drawn as drafts whose choosers are naturals and named
// variations (a parent that is missing, a cycle, a stale hash), never uids.
// resolveRaw turns them into ops against the server's graph as it stands
// when the batch runs, so a draft means the same thing whatever earlier
// steps did, and a shrink never produces a draft that cannot resolve.
//
// Only the pool pages' own blocks are ever named: the reset's Proptest and
// Second pages stay untouched, and rows the server minted (conflict headers,
// rescued texts) are outside what the property compares.
import fc from "fast-check";
import type { BlockUid, OrderIdx, Sha256Hex } from "../../api/brands";
import type { BlockOp, SetViewTypeOp } from "../../api/ops";
import type { BlockNode } from "../../api/payloads";
import { sha256Hex } from "../../replica/sha256";
import { subtreeHash } from "../../replica/subtreeHash";
import {
  BLOCK_TEXT, commandArb, depthsFor, gapArb, nest, type Command, type Slot,
} from "../outline/arbitraries";
import type { NormalGraph } from "../sync/normalise";

export const OPS_PAGES = ["Outline Props", "Ops Two", "Ops Three"] as const;
/** The pages plus one that never exists at the start, so a create or a move
 * can name a page the batch itself makes. No seed or draft text names it. */
export const TITLE_POOL = [...OPS_PAGES, "Ops Four"] as const;
export const UID_POOL: readonly string[] =
  Array.from({ length: 30 }, (_, i) => `opsb${String(i).padStart(2, "0")}`);

export type OpsPage = (typeof OPS_PAGES)[number];
export type PoolTitle = (typeof TITLE_POOL)[number];

/** Refused by both the server and enqueueBatch (`titleSyntaxReason`). */
export const FORBIDDEN_TITLES = ["Bad #title", "x [[y"] as const;

/** A parent no pool block can ever have: the fallback when every pool uid
 * is in the graph. Server-valid, so the op fails on the parent alone. */
const NO_SUCH_UID = "opsm00";

// Uids the property itself makes: the pool, raw creates and command mints.
const OWN_UID = /^ops[bcn]\d+$/;

const MAX_PAGE_BLOCKS = 10;
// Row depth index, roots at 0.
const MAX_DEPTH = 3;
const DEFAULT_PAGE: OpsPage = "Outline Props";

export interface StartState {
  pages: Record<OpsPage, BlockNode[]>;
}

const REF_TEXT: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom("[[Outline Props]]", "x [[Ops Two]]", "#[[Ops Three]]"),
  fc.nat(UID_POOL.length - 1).map((n) => `((${UID_POOL[n]}))`),
);

/** f7zv's texts, plus page and block refs about one time in four. */
export const TEXT: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: BLOCK_TEXT, weight: 3 },
  { arbitrary: REF_TEXT, weight: 1 },
);

const HEADING = fc.constantFrom<BlockNode["heading"]>(null, 1, 2, 3);

const blockSpecArb = fc.record({
  pick: fc.nat(),
  text: TEXT,
  first: fc.nat(3),
  gap: gapArb,
  collapsed: fc.integer({ min: 0, max: 3 }).map((n) => n === 0),
  heading: HEADING,
  viewType: fc.constantFrom<BlockNode["view_type"]>(null, "document", "numbered"),
});

// size "max": the default size caps generated arrays well below maxLength.
const pageSpecsArb = fc.array(blockSpecArb, { maxLength: MAX_PAGE_BLOCKS, size: "max" });

/** Pages in OPS_PAGES order; uids taken from the pool in that order, so no
 * uid is drawn twice. */
export const startStateArb: fc.Arbitrary<StartState> = fc
  .tuple(pageSpecsArb, pageSpecsArb, pageSpecsArb)
  .map((perPage) => {
    let next = 0;
    const pages = {} as Record<OpsPage, BlockNode[]>;
    OPS_PAGES.forEach((title, p) => {
      const specs = perPage[p];
      const depths = depthsFor(specs.map((s) => s.pick), MAX_DEPTH);
      pages[title] = nest<Slot & (typeof specs)[number], BlockNode>(
        specs.map((s, i) => ({ ...s, depth: depths[i] })),
        (s, siblings) => {
          const prev = siblings[siblings.length - 1];
          return {
            uid: UID_POOL[next++] as BlockUid,
            text: s.text,
            heading: s.heading,
            view_type: s.viewType,
            collapsed: s.collapsed,
            order_idx: (prev ? prev.order_idx + 1 + s.gap : s.first) as OrderIdx,
            created_at: null,
            updated_at: null,
            children: [],
          };
        },
      );
    });
    return { pages };
  });

/** The batch that recreates `s` on a freshly reset server: each page, then
 * each block parent-first and in ascending key order within its siblings,
 * so every create lands at its drawn key with nothing to shift; then the
 * collapsed flags, which a create cannot carry. */
export function seedOps(s: StartState): BlockOp[] {
  const creates: BlockOp[] = [];
  const collapses: BlockOp[] = [];
  for (const title of OPS_PAGES) {
    const walk = (nodes: readonly BlockNode[], parent: BlockUid | null): void => {
      for (const n of nodes) {
        creates.push({
          op: "create", uid: n.uid, page_title: title, parent_uid: parent,
          order_idx: n.order_idx, text: n.text,
          ...(n.heading !== null ? { heading: n.heading } : {}),
          ...(n.view_type !== null ? { view_type: n.view_type } : {}),
        });
        if (n.collapsed) collapses.push({ op: "set_collapsed", uid: n.uid, collapsed: true });
        walk(n.children, n.uid);
      }
    };
    walk(s.pages[title], null);
  }
  return [
    ...OPS_PAGES.map((title): BlockOp => ({ op: "create_page", page_title: title })),
    ...creates,
    ...collapses,
  ];
}

/** Where among the destination's siblings: key 0; an existing sibling's key;
 * a free key below the last sibling's; or past the last by `n % 3`. */
export type RawSlot = { at: "zero" } | { at: "sibling" | "gap" | "end"; n: number };

/** top: the top level (of the draft's page, else the block's own page).
 * same: the block's current parent (a move only). live: any live block,
 * on any pool page. cycle: the moved block itself or a descendant (a move
 * only). missing: a uid the graph does not hold. */
export type RawParent =
  | { to: "top" } | { to: "same" }
  | { to: "live" | "cycle" | "missing"; n: number };

/** live: a live block. gone: one this batch deleted, else a pool uid the
 * graph does not hold. first: the block the batch's first draft named. */
export type RawTarget = { of: "live" | "gone"; n: number } | { of: "first" };

/** none: hashless. match: the live text's (subtree's) hash. stale: a hash
 * the live text cannot have. */
export type RawHash = "none" | "match" | "stale";

export type RawDraft =
  | { kind: "create"; uid: RawTarget | null; parent: RawParent; page: string | null;
      slot: RawSlot; text: string; heading: BlockNode["heading"];
      view_type: BlockNode["view_type"] }
  | { kind: "move"; target: RawTarget; parent: RawParent; page: string | null; slot: RawSlot }
  | { kind: "update_text"; target: RawTarget; text: string; hash: RawHash }
  | { kind: "delete"; target: RawTarget; hash: RawHash }
  | { kind: "set_collapsed"; target: RawTarget; collapsed: boolean }
  | { kind: "set_heading"; target: RawTarget; heading: BlockNode["heading"] }
  | { kind: "set_view_type"; target: RawTarget; view_type: SetViewTypeOp["view_type"] }
  | { kind: "create_page"; page: string };

const choice = fc.nat(63);
const weighted = <T>(...arms: [number, fc.Arbitrary<T>][]): fc.Arbitrary<T> =>
  fc.oneof(...arms.map(([weight, arbitrary]) => ({ weight, arbitrary })));

const liveTarget: fc.Arbitrary<RawTarget> = choice.map((n) => ({ of: "live", n }));
// Now and then an edit of a block that is no longer there.
const editTarget: fc.Arbitrary<RawTarget> = weighted<RawTarget>(
  [9, liveTarget], [1, choice.map((n) => ({ of: "gone", n }))]);

const top = fc.constant<RawParent>({ to: "top" });
const parentOf = (to: "live" | "cycle" | "missing"): fc.Arbitrary<RawParent> =>
  choice.map((n) => ({ to, n }));
const moveParent: fc.Arbitrary<RawParent> = weighted<RawParent>(
  [2, fc.constant<RawParent>({ to: "same" })], [3, parentOf("live")], [2, top],
  [1, parentOf("cycle")], [1, parentOf("missing")]);
const createParent: fc.Arbitrary<RawParent> = weighted<RawParent>(
  [2, top], [3, parentOf("live")], [1, parentOf("missing")]);

const slot: fc.Arbitrary<RawSlot> = weighted<RawSlot>(
  [1, fc.constant<RawSlot>({ at: "zero" })],
  [2, choice.map((n): RawSlot => ({ at: "sibling", n }))],
  [1, choice.map((n): RawSlot => ({ at: "gap", n }))],
  [1, choice.map((n): RawSlot => ({ at: "end", n }))]);

const title = fc.constantFrom<string>(...TITLE_POOL);
// Null half the time: the parent's page for a create, the block's own page
// for a top-level move.
const pageOpt = fc.option(title, { nil: null, freq: 2 });
const hash = fc.constantFrom<RawHash>("none", "match", "stale");
// About one create in twenty reuses a live uid: a 400 for the whole batch.
const createUid = weighted<RawTarget | null>([19, fc.constant(null)], [1, liveTarget]);

const createDraft = (page: fc.Arbitrary<string | null>): fc.Arbitrary<RawDraft> => fc.record({
  kind: fc.constant("create" as const), uid: createUid, parent: createParent, page, slot,
  text: TEXT, heading: HEADING,
  view_type: fc.constantFrom<BlockNode["view_type"]>(null, "document", "numbered"),
});
const moveDraft = (target: fc.Arbitrary<RawTarget>, parent: fc.Arbitrary<RawParent>,
                   page: fc.Arbitrary<string | null>): fc.Arbitrary<RawDraft> =>
  fc.record({ kind: fc.constant("move" as const), target, parent, page, slot });

// Moves lead: they are what disturbs sibling keys.
export const rawDraftArb: fc.Arbitrary<RawDraft> = weighted<RawDraft>(
  [4, moveDraft(liveTarget, moveParent, pageOpt)],
  [3, createDraft(pageOpt)],
  [3, fc.record({ kind: fc.constant("update_text" as const), target: editTarget, text: TEXT, hash })],
  [2, fc.record({ kind: fc.constant("delete" as const), target: liveTarget, hash })],
  [1, fc.record({ kind: fc.constant("set_collapsed" as const), target: liveTarget,
                  collapsed: fc.boolean() })],
  [1, fc.record({ kind: fc.constant("set_heading" as const), target: liveTarget,
                  heading: HEADING })],
  [1, fc.record({ kind: fc.constant("set_view_type" as const), target: liveTarget,
                  view_type: fc.constantFrom<SetViewTypeOp["view_type"]>("document", "numbered") })],
  [1, fc.record({ kind: fc.constant("create_page" as const), page: title })],
);

/** A move of the block the batch's first draft named: two moves of one
 * block, or a create then a move. */
const twinArb = moveDraft(fc.constant<RawTarget>({ of: "first" }), moveParent, pageOpt);

const badTitle = fc.constantFrom<string>(...FORBIDDEN_TITLES);
/** A page title both sides refuse, on each op that carries one. */
const forbiddenArb: fc.Arbitrary<RawDraft> = fc.oneof(
  fc.record({ kind: fc.constant("create_page" as const), page: badTitle }),
  createDraft(badTitle),
  moveDraft(liveTarget, top, badTitle),
);

const MAX_BATCH = 6;

/** 1 to 6 drafts. About one batch in four ends with a twin move, and about
 * one in thirty with a forbidden title; each extra replaces a base draft
 * when the batch is full. */
export const rawBatchArb: fc.Arbitrary<RawDraft[]> = fc
  .record({
    base: fc.array(rawDraftArb, { minLength: 1, maxLength: MAX_BATCH }),
    twin: weighted<RawDraft | null>([3, fc.constant(null)], [1, twinArb]),
    bad: weighted<RawDraft | null>([29, fc.constant(null)], [1, forbiddenArb]),
  })
  .map(({ base, twin, bad }) => {
    const extras = [twin, bad].filter((d): d is RawDraft => d !== null);
    return [...base.slice(0, MAX_BATCH - extras.length), ...extras];
  });

/** A fresh create-uid supply: opsc00, opsc01, ... (two digits at least, so
 * every uid has the six characters UID_RE needs). */
export function rawUidMinter(): () => string {
  let n = 0;
  return () => `opsc${String(n++).padStart(2, "0")}`;
}

interface Row { page: string; parent: string | null; order: number; text: string }

/** The ops `drafts` stand for against `g`, the server's graph as the batch
 * runs, with `mint` supplying fresh create uids. The batch's own creates,
 * deletes, moves and text edits are tracked as far as picking targets,
 * siblings and hashes needs; keys are not shifted. Pure. */
export function resolveRaw(drafts: readonly RawDraft[], g: NormalGraph,
                           mint: () => string): BlockOp[] {
  const pool = new Set<string>(TITLE_POOL);
  const rows = new Map<string, Row>();
  for (const b of g.blocks) {
    if (pool.has(b.page) && OWN_UID.test(b.uid)) {
      rows.set(b.uid, { page: b.page, parent: b.parent_uid, order: b.order_idx, text: b.text });
    }
  }
  const inGraph = new Set(g.blocks.map((b) => b.uid));
  const outside = UID_POOL.filter((u) => !inGraph.has(u));
  const deleted: string[] = [];
  const deletedText = new Map<string, string>();
  let first: string | null = null;

  const at = <T>(xs: readonly T[], n: number): T => xs[n % xs.length];
  const missing = (n: number): string => (outside.length > 0 ? at(outside, n) : NO_SUCH_UID);
  const live = (n: number): string | null => {
    const uids = [...rows.keys()];
    return uids.length > 0 ? at(uids, n) : null;
  };
  const target = (t: RawTarget): string => {
    if (t.of === "first" && first !== null) return first;
    if (t.of === "gone") {
      if (deleted.length > 0) return at(deleted, t.n);
      if (outside.length > 0) return at(outside, t.n);
    }
    return live(t.of === "first" ? 0 : t.n) ?? missing(t.of === "first" ? 0 : t.n);
  };
  const childrenOf = (parent: string): string[] =>
    [...rows].filter(([, r]) => r.parent === parent).map(([u]) => u);
  const subtree = (uid: string): string[] =>
    [uid, ...childrenOf(uid).flatMap(subtree)];
  const keysUnder = (parent: string | null, page: string): number[] =>
    [...rows.values()]
      .filter((r) => (parent === null ? r.parent === null && r.page === page : r.parent === parent))
      .map((r) => r.order)
      .sort((a, b) => a - b);
  const place = (keys: readonly number[], s: RawSlot): OrderIdx => {
    const last = keys.length > 0 ? keys[keys.length - 1] : -1;
    switch (s.at) {
      case "zero":
        return 0 as OrderIdx;
      case "sibling":
        return (keys.length > 0 ? at(keys, s.n) : 0) as OrderIdx;
      case "gap": {
        const taken = new Set(keys);
        const free = Array.from({ length: Math.max(last, 0) }, (_, k) => k)
          .filter((k) => !taken.has(k));
        return (free.length > 0 ? at(free, s.n) : last + 1) as OrderIdx;
      }
      case "end":
        return (last + 1 + (s.n % 3)) as OrderIdx;
    }
  };
  const textOf = (uid: string): string => rows.get(uid)?.text ?? deletedText.get(uid) ?? "";
  const textHash = (uid: string, h: RawHash): Sha256Hex | null =>
    h === "none" ? null : sha256Hex(h === "match" ? textOf(uid) : `${textOf(uid)}~`);

  const ops: BlockOp[] = [];
  drafts.forEach((d, i) => {
    let subject: string | null = null;
    switch (d.kind) {
      case "create": {
        const uid = d.uid === null ? mint() : target(d.uid);
        const parent = d.parent.to === "live" || d.parent.to === "cycle"
          ? live(d.parent.n)
          : d.parent.to === "missing" ? missing(d.parent.n) : null;
        const parentRow = parent === null ? undefined : rows.get(parent);
        const page = d.page ?? parentRow?.page ?? DEFAULT_PAGE;
        const order = place(parentRow ? keysUnder(parent, page)
                            : parent === null ? keysUnder(null, page) : [], d.slot);
        ops.push({
          op: "create", uid: uid as BlockUid, page_title: page,
          parent_uid: parent as BlockUid | null, order_idx: order, text: d.text,
          ...(d.heading !== null ? { heading: d.heading } : {}),
          ...(d.view_type !== null ? { view_type: d.view_type } : {}),
        });
        if (d.uid === null) {
          rows.set(uid, { page: parentRow?.page ?? page, parent: parentRow ? parent : null,
                          order, text: d.text });
        }
        subject = uid;
        break;
      }
      case "move": {
        const uid = target(d.target);
        const row = rows.get(uid);
        const own = row?.page ?? DEFAULT_PAGE;
        let parent: string | null;
        let titled: string | null = null;
        switch (d.parent.to) {
          case "top": parent = null; titled = d.page; break;
          case "same": parent = row?.parent ?? null; break;
          case "live": parent = live(d.parent.n); break;
          case "cycle": parent = at(subtree(uid), d.parent.n); break;
          case "missing": parent = missing(d.parent.n); break;
        }
        const parentRow = parent === null ? undefined : rows.get(parent);
        const dest = parentRow?.page ?? titled ?? own;
        const order = place(parent === null ? keysUnder(null, dest)
                            : parentRow ? keysUnder(parent, dest) : [], d.slot);
        ops.push({
          op: "move", uid: uid as BlockUid, parent_uid: parent as BlockUid | null,
          order_idx: order, ...(titled !== null ? { page_title: titled } : {}),
        });
        const lands = parent === null || (parentRow !== undefined && !subtree(uid).includes(parent));
        if (row && lands) {
          row.parent = parent;
          row.order = order;
          for (const u of subtree(uid)) rows.get(u)!.page = dest;
        }
        subject = uid;
        break;
      }
      case "update_text": {
        const uid = target(d.target);
        const base = textHash(uid, d.hash);
        const page = rows.get(uid)?.page;
        // A hashed edit carries its block's page, as the editor stamps it.
        ops.push({
          op: "update_text", uid: uid as BlockUid, text: d.text,
          ...(base !== null ? { base_text_hash: base, ...(page ? { page_title: page } : {}) } : {}),
        });
        const row = rows.get(uid);
        if (row) row.text = d.text;
        subject = uid;
        break;
      }
      case "delete": {
        const uid = target(d.target);
        const gone = rows.has(uid) ? subtree(uid) : [];
        const base = d.hash === "none" ? null
          : d.hash === "match" ? subtreeHash(gone.map((u): [string, string] => [u, textOf(u)]))
          : sha256Hex(`${textOf(uid)}~`);
        ops.push({ op: "delete", uid: uid as BlockUid,
                   ...(base !== null ? { base_subtree_hash: base } : {}) });
        for (const u of gone) {
          deleted.push(u);
          deletedText.set(u, textOf(u));
          rows.delete(u);
        }
        subject = uid;
        break;
      }
      case "set_collapsed":
        subject = target(d.target);
        ops.push({ op: "set_collapsed", uid: subject as BlockUid, collapsed: d.collapsed });
        break;
      case "set_heading":
        subject = target(d.target);
        ops.push({ op: "set_heading", uid: subject as BlockUid, heading: d.heading });
        break;
      case "set_view_type":
        subject = target(d.target);
        ops.push({ op: "set_view_type", uid: subject as BlockUid, view_type: d.view_type });
        break;
      case "create_page":
        ops.push({ op: "create_page", page_title: d.page });
        break;
    }
    if (i === 0) first = subject;
  });
  return ops;
}

export type RawStep = { batch: RawDraft[]; other: RawDraft[] | null };

export type Example =
  | { start: StartState; kind: "raw"; steps: RawStep[] }
  | { start: StartState; kind: "command"; commands: Command[] };

/** `other` is another device's batch, run before this one is posted. */
const rawStepArb: fc.Arbitrary<RawStep> = fc.record({
  batch: rawBatchArb,
  other: fc.option(rawBatchArb, { nil: null, freq: 2 }),
});

/** Raw examples about 3 in 5: 1 to 3 raw steps, or 1 to 5 outline commands. */
export const exampleArb: fc.Arbitrary<Example> = weighted<Example>(
  [3, fc.record({
    start: startStateArb, kind: fc.constant("raw" as const),
    steps: fc.array(rawStepArb, { minLength: 1, maxLength: 3 }),
  })],
  [2, fc.record({
    start: startStateArb, kind: fc.constant("command" as const),
    commands: fc.array(commandArb, { minLength: 1, maxLength: 5 }),
  })],
);
