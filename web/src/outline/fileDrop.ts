// pattern: Functional Core
// What a drop of files from outside the app, or an upload into the block
// being edited, means: which files can become blocks, and the ops that place
// one block per upload.
import type { BlockUid, CanonicalTitle } from "../api/brands";
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import type { DropTarget } from "./dnd";
import type { EditResult } from "./edits";
import { orderIdxAfter, orderIdxAfterLast, orderIdxPlus } from "./orderIdx";
import { applyOps, findNode, locate } from "./tree";

/** Images and PDFs are what the asset store renders as blocks. */
export function isUploadableType(type: string): boolean {
  return type.startsWith("image/") || type === "application/pdf";
}

/** Whether a drag in flight carries something droppable, from
 * `dataTransfer.items` (the only view of a drag's contents before the drop:
 * `files` is empty until then, but each item's kind and type are listed).
 * A browser that lists no items at all, or lists a file with an empty type
 * (WebKit does during dragover), gives no basis to refuse, so the drag is
 * accepted and the drop-time filter reports anything unsuitable by name. */
export function uploadableDrag(items: { kind: string; type: string }[]): boolean {
  if (items.length === 0) return true;
  return items.some((i) => i.kind === "file" && (i.type === "" || isUploadableType(i.type)));
}

/** The dropped files split by `file.type`, each side in drop order. */
export function partitionUploadable(files: File[]):
    { accepted: File[]; rejected: File[] } {
  const accepted: File[] = [];
  const rejected: File[] = [];
  for (const f of files) (isUploadableType(f.type) ? accepted : rejected).push(f);
  return { accepted, rejected };
}

export interface FileDropPlan {
  result: EditResult;
  /** The target's parent was gone by the time the uploads finished, so the
   * blocks went to the end of the page instead. */
  fellBack: boolean;
  firstUid: BlockUid | null;
}

/** One create op per text, at consecutive slots from the drop target (each
 * create inserts before whatever now sits at its order_idx, so the run keeps
 * its order). `uids` is index-aligned with `texts`. Focus is never moved. */
export function planFileDropBlocks(blocks: BlockNode[], pageTitle: CanonicalTitle,
                                   target: DropTarget, texts: string[],
                                   uids: BlockUid[]): FileDropPlan {
  const fellBack = target.parent_uid !== null
    && findNode(blocks, target.parent_uid) === null;
  const parent = fellBack ? null : target.parent_uid;
  const base = fellBack ? orderIdxAfterLast(blocks) : target.order_idx;
  const ops: BlockOp[] = texts.map((text, k) => ({
    op: "create", uid: uids[k], page_title: pageTitle, parent_uid: parent,
    order_idx: orderIdxPlus(base, k), text }));
  return {
    result: { blocks: applyOps(blocks, ops, pageTitle), ops, focus: null },
    fellBack,
    firstUid: uids[0] ?? null,
  };
}

/** Where the uploads of `/upload`, a paste or a drop onto the block `uid`
 * land: each text becomes its own sibling after that block (after its whole
 * subtree), never spliced into its text. A block that is empty or only
 * whitespace takes `texts[0]` itself, and the rest follow as siblings; then
 * `firstUid` is `uid`, `uids[0]` goes unused, and the caret moves to the end
 * of the filled text only when that block still owns focus (`focusedUid`).
 * With the block gone (`fellBack`) the blocks go to the end of the page.
 * `uids` is index-aligned with `texts`. */
export function planUploadBlocks(blocks: BlockNode[], pageTitle: CanonicalTitle,
                                 uid: BlockUid, texts: string[], uids: BlockUid[],
                                 focusedUid: BlockUid | null): FileDropPlan {
  const located = locate(blocks, uid);
  if (located === null) {
    const plan = planFileDropBlocks(blocks, pageTitle,
      { parent_uid: null, order_idx: orderIdxAfterLast(blocks), page_title: pageTitle },
      texts, uids);
    return { ...plan, fellBack: true };
  }
  const { node, parent } = located;
  const fill = node.text.trim() === "" && texts.length > 0;
  const rest = fill ? 1 : 0;
  const plan = planFileDropBlocks(blocks, pageTitle,
    { parent_uid: parent?.uid ?? null, order_idx: orderIdxAfter(node.order_idx),
      page_title: pageTitle },
    texts.slice(rest), uids.slice(rest));
  if (!fill) return plan;
  const ops: BlockOp[] = [{ op: "update_text", uid, text: texts[0] }, ...plan.result.ops];
  return {
    result: {
      blocks: applyOps(blocks, ops, pageTitle),
      ops,
      focus: focusedUid === uid ? { uid, cursor: texts[0].length } : null,
    },
    fellBack: false,
    firstUid: uid,
  };
}

/** The upload banner text for a drop: failed uploads (as `name: reason`) in
 * the wording /upload uses, plus the files that were never uploaded because
 * they are not images or PDFs. Null when nothing went wrong. */
export function fileDropNotice(failures: string[], rejected: string[]): string | null {
  const parts: string[] = [];
  if (failures.length > 0) {
    parts.push(failures.length === 1
      ? `Upload failed — ${failures[0]}`
      : `${failures.length} uploads failed — ${failures.join("; ")}`);
  }
  if (rejected.length > 0) {
    parts.push(`Not uploaded, only images and PDFs can be dropped — ${rejected.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(". ") : null;
}
