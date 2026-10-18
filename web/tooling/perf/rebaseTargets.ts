// pattern: Functional Core
// The rebase scenario's fixed workload, derived from the fixture snapshot:
// which blocks of the big page the pending queue and the peer's windows
// touch, and the ops they send. Deterministic from the snapshot alone, so a
// branch and its merge base measure the same queue over the same windows.
import type { BlockUid, OrderIdx } from "../../src/api/brands";
import type { BlockOp, CreateOp } from "../../src/api/ops";
import { parseBlockUid } from "../../src/ids";
import { FIRST_ORDER_IDX, orderIdxAfter, orderIdxPlus } from "../../src/outline/orderIdx";
import type { Snapshot, SyncBlock } from "../../src/replica/apply";
import { newBatchId } from "../../src/uid";

export interface Targets {
  /** Deleted by the pending queue, with a subtree of about 20 blocks. */
  deleteRoot: BlockUid;
  /** Eight blocks the pending queue edits; the overlap window edits the
   * first. */
  editUids: BlockUid[];
  /** Three blocks the pending queue moves under moveParent. */
  moveUids: BlockUid[];
  moveParent: BlockUid;
  /** The pending queue creates children here; the overlap window moves
   * overlapMoveUid here. */
  createParent: BlockUid;
  windowEditUid: BlockUid;
  pasteParent: BlockUid;
  overlapMoveUid: BlockUid;
}

export interface Batch {
  batchId: ReturnType<typeof newBatchId>;
  ops: BlockOp[];
}

const DELETE_SUBTREE = 21;
const MIN_DELETE_SUBTREE = 5;
const PENDING_CREATES = 10;
const PASTE_CREATES = 50;

const byUid = (a: SyncBlock, b: SyncBlock): number =>
  a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;

const seq = (prefix: string, i: number): BlockUid => {
  const raw = `${prefix}${String(i).padStart(2, "0")}`;
  const uid = parseBlockUid(raw);
  if (uid === null) throw new Error(`rebase scenario: ${raw} is not a block uid`);
  return uid;
};

interface PageTree {
  title: string;
  blocks: SyncBlock[];
  byUid: Map<BlockUid, SyncBlock>;
  children: Map<BlockUid | null, SyncBlock[]>;
}

function pageTree(snapshot: Snapshot, title: string): PageTree {
  const page = snapshot.pages.find((p) => p.title === title);
  if (!page) throw new Error(`rebase scenario: no page titled ${JSON.stringify(title)}`);
  const blocks = snapshot.blocks.filter((b) => b.page_id === page.id);
  const children = new Map<BlockUid | null, SyncBlock[]>();
  for (const b of blocks) {
    const list = children.get(b.parent_uid) ?? [];
    list.push(b);
    children.set(b.parent_uid, list);
  }
  return { title, blocks, byUid: new Map(blocks.map((b) => [b.uid, b])), children };
}

function treeOf(snapshot: Snapshot, uid: BlockUid): PageTree {
  const block = snapshot.blocks.find((b) => b.uid === uid);
  const page = block && snapshot.pages.find((p) => p.id === block.page_id);
  if (!page) throw new Error(`rebase scenario: block ${uid} is not in the snapshot`);
  return pageTree(snapshot, page.title);
}

/** `uid` and every block below it. */
function subtree(tree: PageTree, uid: BlockUid): Set<BlockUid> {
  const out = new Set<BlockUid>();
  const stack = [uid];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    out.add(next);
    for (const c of tree.children.get(next) ?? []) stack.push(c.uid);
  }
  return out;
}

/** Whether `ancestor` is `uid` or above it. */
function holds(tree: PageTree, ancestor: BlockUid, uid: BlockUid): boolean {
  for (let at: BlockUid | null = uid; at !== null; at = tree.byUid.get(at)?.parent_uid ?? null) {
    if (at === ancestor) return true;
  }
  return false;
}

/** The order index after `parent`'s current last child. */
function appendIdx(tree: PageTree, parent: BlockUid): OrderIdx {
  const kids = tree.children.get(parent) ?? [];
  return kids.length === 0 ? FIRST_ORDER_IDX
    : orderIdxAfter(kids.reduce((max, c) => (c.order_idx > max ? c.order_idx : max), kids[0].order_idx));
}

export function pickTargets(snapshot: Snapshot, pageTitle: string): Targets {
  const tree = pageTree(snapshot, pageTitle);
  const sorted = [...tree.blocks].sort(byUid);

  let root: { uid: BlockUid; size: number } | null = null;
  for (const b of sorted) {
    const size = subtree(tree, b.uid).size;
    if (size < MIN_DELETE_SUBTREE) continue;
    // strictly closer only: on a tie the smaller uid, seen first, stays
    if (root === null ||
        Math.abs(size - DELETE_SUBTREE) < Math.abs(root.size - DELETE_SUBTREE)) {
      root = { uid: b.uid, size };
    }
  }
  if (root === null) {
    throw new Error(`rebase scenario: no block on ${pageTitle} has a subtree of ${MIN_DELETE_SUBTREE}`);
  }
  const deleted = subtree(tree, root.uid);
  const pool = sorted.map((b) => b.uid).filter((uid) => !deleted.has(uid));

  const take = (role: string, ok: (uid: BlockUid) => boolean = () => true): BlockUid => {
    const at = pool.findIndex(ok);
    if (at < 0) throw new Error(`rebase scenario: ${pageTitle} runs out of blocks for ${role}`);
    return pool.splice(at, 1)[0];
  };
  const editUids = Array.from({ length: 8 }, () => take("editUids"));
  const moveUids = Array.from({ length: 3 }, () => take("moveUids"));
  // a parent below a moved block would move with it, and moving a block
  // under its own descendant is a cycle
  const notUnderMoves = (uid: BlockUid): boolean => !moveUids.some((m) => holds(tree, m, uid));
  const moveParent = take("moveParent", notUnderMoves);
  const createParent = take("createParent", notUnderMoves);
  const windowEditUid = take("windowEditUid");
  const pasteParent = take("pasteParent");
  const overlapMoveUid = take("overlapMoveUid", (uid) => !holds(tree, uid, createParent));
  return {
    deleteRoot: root.uid, editUids, moveUids, moveParent, createParent,
    windowEditUid, pasteParent, overlapMoveUid,
  };
}

const textOf = (tree: PageTree, uid: BlockUid): string => {
  const block = tree.byUid.get(uid);
  if (!block) throw new Error(`rebase scenario: block ${uid} is not on ${tree.title}`);
  return block.text;
};

const edit = (tree: PageTree, uid: BlockUid, suffix: string): BlockOp =>
  ({ op: "update_text", uid, text: `${textOf(tree, uid)}${suffix}` });

const creates = (tree: PageTree, parent: BlockUid, n: number, makeUid: (i: number) => BlockUid,
                 text: (i: number) => string, firstIdx: OrderIdx): CreateOp[] =>
  Array.from({ length: n }, (_, k) => ({
    op: "create", uid: makeUid(k + 1), page_title: tree.title,
    parent_uid: parent, order_idx: orderIdxPlus(firstIdx, k), text: text(k + 1),
  }));

const batch = (ops: BlockOp[]): Batch => ({ batchId: newBatchId(), ops });

/** The local queue, in enqueue order. No base hashes: enqueue fills them. */
export function pendingBatches(t: Targets, snapshot: Snapshot): Batch[] {
  const tree = treeOf(snapshot, t.deleteRoot);
  const createIdx = orderIdxPlus(FIRST_ORDER_IDX, (tree.children.get(t.createParent) ?? []).length + 1);
  const moveIdx = appendIdx(tree, t.moveParent);
  return [
    batch(creates(tree, t.createParent, PENDING_CREATES, (i) => seq("perfrebc", i),
                        (i) => `perf rebase create ${i}`, createIdx)),
    batch(t.editUids.slice(0, 4).map((uid) => edit(tree, uid, " (pending edit)"))),
    batch(t.moveUids.map((uid, k) => ({
      op: "move", uid, parent_uid: t.moveParent, order_idx: orderIdxPlus(moveIdx, k),
    }))),
    batch(t.editUids.slice(4, 8).map((uid) => edit(tree, uid, " (pending edit)"))),
    batch([{ op: "delete", uid: t.deleteRoot }]),
    batch([{ op: "update_text", uid: seq("perfrebc", 1),
                   text: "perf rebase create 1, edited" }]),
  ];
}

/** The peer's three batches, one feed window each. */
export function windowBatches(t: Targets, snapshot: Snapshot): Batch[] {
  const tree = treeOf(snapshot, t.deleteRoot);
  return [
    batch([edit(tree, t.windowEditUid, " (peer edit)")]),
    batch(creates(tree, t.pasteParent, PASTE_CREATES, (i) => seq("perfrebp", i),
                        (i) => `perf rebase paste ${i}`, appendIdx(tree, t.pasteParent))),
    batch([
      edit(tree, t.editUids[0], " (peer overlap)"),
      { op: "move", uid: t.overlapMoveUid, parent_uid: t.createParent,
        order_idx: appendIdx(tree, t.createParent) },
    ]),
  ];
}
