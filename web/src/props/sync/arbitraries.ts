// pattern: Functional Core
// What an Edit enqueues. fc.commands draws every command before the run, so
// an Edit carries op drafts (a kind, indices into the uid pool and the title
// pool, an order key, a text) and resolves them against the model only when
// it runs: indices pick from whatever the pool holds by then, and a create
// takes the client's next fresh uid. Resolution is a pure function of the
// drafts and the model, so a seed and path replay the same ops.
//
// The pool is every seed block but pt_seed_6, then page Second's blocks,
// plus every uid an Edit has created. pt_seed_6 is never a target or a
// parent, so it stays live on the server for the whole example and a
// BadBatch's create of it is always a 400. A client creates only from its
// own fresh uids, each at most once, so no Edit can meet a legitimate 400.
//
// Page titles come from a fixed pool that renames never change: a Rename
// moves a title from one page to another, so a drawn title may name the
// page it named at the start, another page, or no page at all, when the
// server get_or_creates one under it.
import fc from "fast-check";
import type { BlockUid, OrderIdx } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import type { SyncModel } from "./model";

export const SEED_PAGE = "Proptest";
export const SEED_UIDS = ["pt_seed_1", "pt_seed_2", "pt_seed_3",
                          "pt_seed_4", "pt_seed_5", "pt_seed_6"] as const;
/** Live for the whole example: BadBatch creates it. */
export const BAD_UID = "pt_seed_6";
export const SECOND_PAGE = "Second";
export const SECOND_UIDS = ["pt_sec_1", "pt_sec_2", "pt_sec_3"] as const;
/** The seed blocks but BAD_UID, then Second's: a fixed scenario's pool
 * index of a seed block does not move when a page is added. */
export const EDIT_TARGETS: readonly string[] =
  [...SEED_UIDS.filter((u) => u !== BAD_UID), ...SECOND_UIDS];
/** The titles a create, a titled move or a Rename names: the two seeded
 * pages, then two that start out missing. No daily title, so every Rename
 * the server refuses is refused for a reason the generator meant. */
export const PAGE_TITLES = [SEED_PAGE, SECOND_PAGE, "Third", "Fourth"] as const;

/** The title pool's entry `i` names (mod its size). */
export const pageTitle = (i: number): string => PAGE_TITLES[i % PAGE_TITLES.length];

export type OpKind = "update_text" | "move" | "delete" | "set_collapsed" | "create";

export interface OpDraft {
  kind: OpKind;
  /** Index (mod the pool's size) of the op's uid; unused by a create. */
  target: number;
  /** Index of the parent for a create or move; null is top level. */
  parent: number | null;
  /** Index into PAGE_TITLES, or null. A create's page_title is the title
   * this names, Proptest when null; a top-level move carries it as its
   * page_title, and a null leaves the move on the block's own page. Only a
   * top-level create or move is placed by its title. */
  page: number | null;
  orderIdx: number;
  text: string;
  collapsed: boolean;
}

// The server suite's calibrated ratio: the pool is narrow, so a create is
// drawn a quarter as often as each other kind. The common kinds come first,
// so a shrink moves toward them.
const kind: fc.Arbitrary<OpKind> = fc.oneof(
  { arbitrary: fc.constant<OpKind>("update_text"), weight: 4 },
  { arbitrary: fc.constant<OpKind>("move"), weight: 4 },
  { arbitrary: fc.constant<OpKind>("delete"), weight: 4 },
  { arbitrary: fc.constant<OpKind>("set_collapsed"), weight: 4 },
  { arbitrary: fc.constant<OpKind>("create"), weight: 1 },
);

const WORDS = ["apple", "river", "note", "plan", "draft"];

/** Up to three tokens: words, page links, a tag. A link to Second is the
 * one a Rename of Second rewrites. */
export const text: fc.Arbitrary<string> = fc
  .array(fc.oneof(fc.constantFrom(...WORDS), fc.constant("[[Alpha]]"),
                  fc.constant("#Beta"), fc.constant("[[Second]]")), { maxLength: 3 })
  .map((tokens) => tokens.join(" "));

export const opDraft: fc.Arbitrary<OpDraft> = fc.record({
  kind,
  target: fc.nat({ max: 63 }),
  // Top level about one time in three, as the server suite draws parents.
  parent: fc.option(fc.nat({ max: 63 }), { nil: null, freq: 3 }),
  // Null half the time, which shrinks toward a create on Proptest and a
  // move that stays on its page.
  page: fc.option(fc.nat({ max: PAGE_TITLES.length - 1 }), { nil: null, freq: 2 }),
  // The seed's keys are 0, 10 .. 50: this reaches before, between and after.
  orderIdx: fc.nat({ max: 70 }),
  text,
  collapsed: fc.boolean(),
});

/** 1-4 ops. */
export const editDrafts: fc.Arbitrary<OpDraft[]> =
  fc.array(opDraft, { minLength: 1, maxLength: 4 });

/** Edit targets as the model stands: the seed blocks but pt_seed_6, then
 * Second's, then the created uids. */
export function targetPool(model: Pick<SyncModel, "createdUids">): string[] {
  return [...EDIT_TARGETS, ...model.createdUids];
}

/** The ops `drafts` stand for, given the pool and this client's unused
 * create uids, and the create uids they used up. A create with no fresh uid
 * left becomes an update_text of its target. */
export function resolveOps(drafts: readonly OpDraft[], pool: readonly string[],
                           fresh: readonly string[]): { ops: BlockOp[]; used: string[] } {
  const live = [...pool];
  const used: string[] = [];
  const pick = (i: number): BlockUid => live[i % live.length] as BlockUid;
  const ops = drafts.map((d): BlockOp => {
    const uid = pick(d.target);
    const parent = d.parent === null ? null : pick(d.parent);
    const order = d.orderIdx as OrderIdx;
    switch (d.kind) {
      case "create": {
        const next = fresh[used.length];
        if (next === undefined) return { op: "update_text", uid, text: d.text };
        used.push(next);
        live.push(next);
        return { op: "create", uid: next as BlockUid,
                 page_title: d.page === null ? SEED_PAGE : pageTitle(d.page),
                 parent_uid: parent, order_idx: order, text: d.text };
      }
      case "update_text":
        return { op: "update_text", uid, text: d.text };
      case "move":
        return parent === null && d.page !== null
          ? { op: "move", uid, parent_uid: null, order_idx: order,
              page_title: pageTitle(d.page) }
          : { op: "move", uid, parent_uid: parent, order_idx: order };
      case "delete":
        return { op: "delete", uid };
      case "set_collapsed":
        return { op: "set_collapsed", uid, collapsed: d.collapsed };
    }
  });
  return { ops, used };
}

/** An Edit's ops for `client` as the model stands. */
export function opsFor(model: SyncModel, client: string): fc.Arbitrary<BlockOp[]> {
  return editDrafts.map((drafts) =>
    resolveOps(drafts, targetPool(model), model.freshUids[client] ?? []).ops);
}

/** One op on one line, for a command transcript. */
export function showOp(op: BlockOp): string {
  switch (op.op) {
    case "create":
      return `create ${op.uid} under ${op.parent_uid ?? `top of ${op.page_title}`}` +
        ` at ${op.order_idx} ${JSON.stringify(op.text)}`;
    case "update_text":
      return `update_text ${op.uid} ${JSON.stringify(op.text)}`;
    case "move":
      return `move ${op.uid} under ${op.parent_uid ??
        (op.page_title ? `top of ${op.page_title}` : "top")} at ${op.order_idx}`;
    case "delete":
      return `delete ${op.uid}`;
    case "set_collapsed":
      return `set_collapsed ${op.uid} ${op.collapsed}`;
    default:
      return JSON.stringify(op);
  }
}

/** A draft as generated, before resolution: `#n` is a uid pool index, and
 * a page is named by the title it draws. */
export function showDraft(d: OpDraft): string {
  const top = (fallback: string): string =>
    d.page === null ? fallback : `top of ${pageTitle(d.page)}`;
  switch (d.kind) {
    case "create":
      return `create under ${d.parent === null ? top(`top of ${SEED_PAGE}`) : `#${d.parent}`}` +
        ` at ${d.orderIdx} ${JSON.stringify(d.text)}`;
    case "update_text":
      return `update_text #${d.target} ${JSON.stringify(d.text)}`;
    case "move":
      return `move #${d.target} under ${d.parent === null ? top("top") : `#${d.parent}`}` +
        ` at ${d.orderIdx}`;
    case "delete":
      return `delete #${d.target}`;
    case "set_collapsed":
      return `set_collapsed #${d.target} ${d.collapsed}`;
  }
}
