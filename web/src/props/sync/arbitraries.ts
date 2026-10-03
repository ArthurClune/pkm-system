// pattern: Functional Core
// What an Edit enqueues. fc.commands draws every command before the run, so
// an Edit carries op drafts (a kind, indices into the uid pool, an order
// key, a text) and resolves them against the model only when it runs:
// indices pick from whatever the pool holds by then, and a create takes the
// client's next fresh uid. Resolution is a pure function of the drafts and
// the model, so a seed and path replay the same ops.
//
// The pool is every seed block but pt_seed_6, plus every uid an Edit has
// created. pt_seed_6 is never a target or a parent, so it stays live on the
// server for the whole example and a BadBatch's create of it is always a
// 400. A client creates only from its own fresh uids, each at most once, so
// no Edit can meet a legitimate 400.
import fc from "fast-check";
import type { BlockUid, OrderIdx } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import type { SyncModel } from "./model";

export const SEED_PAGE = "Proptest";
export const SEED_UIDS = ["pt_seed_1", "pt_seed_2", "pt_seed_3",
                          "pt_seed_4", "pt_seed_5", "pt_seed_6"] as const;
/** Live for the whole example: BadBatch creates it. */
export const BAD_UID = "pt_seed_6";
export const EDIT_TARGETS: readonly string[] = SEED_UIDS.filter((u) => u !== BAD_UID);

export type OpKind = "update_text" | "move" | "delete" | "set_collapsed" | "create";

export interface OpDraft {
  kind: OpKind;
  /** Index (mod the pool's size) of the op's uid; unused by a create. */
  target: number;
  /** Index of the parent for a create or move; null is top level. */
  parent: number | null;
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

/** Up to three tokens: words, a page link, a tag. */
export const text: fc.Arbitrary<string> = fc
  .array(fc.oneof(fc.constantFrom(...WORDS), fc.constant("[[Alpha]]"),
                  fc.constant("#Beta")), { maxLength: 3 })
  .map((tokens) => tokens.join(" "));

export const opDraft: fc.Arbitrary<OpDraft> = fc.record({
  kind,
  target: fc.nat({ max: 63 }),
  // Top level about one time in three, as the server suite draws parents.
  parent: fc.option(fc.nat({ max: 63 }), { nil: null, freq: 3 }),
  // The seed's keys are 0, 10 .. 50: this reaches before, between and after.
  orderIdx: fc.nat({ max: 70 }),
  text,
  collapsed: fc.boolean(),
});

/** 1-4 ops. */
export const editDrafts: fc.Arbitrary<OpDraft[]> =
  fc.array(opDraft, { minLength: 1, maxLength: 4 });

/** Edit targets as the model stands: the seed blocks but pt_seed_6, then
 * the created uids. */
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
        return { op: "create", uid: next as BlockUid, page_title: SEED_PAGE,
                 parent_uid: parent, order_idx: order, text: d.text };
      }
      case "update_text":
        return { op: "update_text", uid, text: d.text };
      case "move":
        return { op: "move", uid, parent_uid: parent, order_idx: order };
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
      return `create ${op.uid} under ${op.parent_uid ?? "top"} at ${op.order_idx}` +
        ` ${JSON.stringify(op.text)}`;
    case "update_text":
      return `update_text ${op.uid} ${JSON.stringify(op.text)}`;
    case "move":
      return `move ${op.uid} under ${op.parent_uid ?? "top"} at ${op.order_idx}`;
    case "delete":
      return `delete ${op.uid}`;
    case "set_collapsed":
      return `set_collapsed ${op.uid} ${op.collapsed}`;
    default:
      return JSON.stringify(op);
  }
}

/** A draft as generated, before resolution: `#n` is a pool index. */
export function showDraft(d: OpDraft): string {
  const parent = d.parent === null ? "top" : `#${d.parent}`;
  switch (d.kind) {
    case "create":
      return `create under ${parent} at ${d.orderIdx} ${JSON.stringify(d.text)}`;
    case "update_text":
      return `update_text #${d.target} ${JSON.stringify(d.text)}`;
    case "move":
      return `move #${d.target} under ${parent} at ${d.orderIdx}`;
    case "delete":
      return `delete #${d.target}`;
    case "set_collapsed":
      return `set_collapsed #${d.target} ${d.collapsed}`;
  }
}
