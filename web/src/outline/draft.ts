// pattern: Functional Core
// The editor's pending draft: the text typed into one block, the text it was
// typed over, and the text op it flushes.
import type { BlockUid, CanonicalTitle } from "../api/brands";
import type { BlockNode } from "../api/payloads";
import type { UpdateTextOp } from "../api/ops";
import { sha256Hex } from "../replica/sha256";
import { findNode } from "./tree";

/** An editor draft: the text typed into one block, and the text that block
 * held when typing started (`null` when the tree lacked the block then). */
export interface PendingDraft {
  uid: BlockUid;
  text: string;
  base: string | null;
}

/** The text an editor showed for a block when its user typed over it. It can
 * differ from the tree's text: a remote batch reaches the tree before the
 * textarea adopts it, and a dirty textarea never adopts it at all. */
export interface ShownText {
  uid: BlockUid;
  base: string;
}

/** Record a draft change. The base is captured on the draft's first change
 * and kept across later keystrokes, even when a remote batch has since
 * changed the tree under it; a change to a different block starts over. A
 * new draft's base is the text the editor showed for that block when one is
 * known, since that is the text the user typed over; the tree's text is the
 * fallback. */
export function captureDraft(
  prev: PendingDraft | null,
  uid: BlockUid,
  text: string,
  blocks: BlockNode[],
  shown: ShownText | null = null,
): PendingDraft {
  if (prev?.uid === uid) return { uid, text, base: prev.base };
  if (shown?.uid === uid) return { uid, text, base: shown.base };
  return { uid, text, base: findNode(blocks, uid)?.text ?? null };
}

/** The text op a draft flushes. It carries the hash of the text the draft was
 * typed over (its base), not of whatever the tree holds now, so a remote edit
 * that landed under the draft forks a conflict copy instead of being
 * overwritten. It ships even when the block has left this tree (a remote
 * delete or cross-page move): the server applies it wherever the block now
 * lives, and lands an edit to a deleted block on today's daily note. Empty
 * only when nothing changed (the text equals the base) or the tree already
 * holds the text. A draft with no base carries just page_title, and
 * stampBaseTextHashes hashes it as it would any op. */
export function pendingTextOps(
  pending: PendingDraft | null,
  blocks: BlockNode[],
  pageTitle: CanonicalTitle,
): UpdateTextOp[] {
  if (!pending) return [];
  const { uid, text, base } = pending;
  if (text === base) return [];
  const node = findNode(blocks, uid);
  if (node && node.text === text) return [];
  return [{
    op: "update_text", uid, text,
    ...(base !== null ? { base_text_hash: sha256Hex(base) } : {}),
    page_title: pageTitle,
  }];
}
