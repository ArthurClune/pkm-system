// pattern: Functional Core
// The editor's pending draft: the text typed into one block, the text it was
// typed over, and the text op it flushes.
import type { BlockUid, CanonicalTitle } from "../api/brands";
import type { BlockNode } from "../api/payloads";
import type { UpdateTextOp } from "../api/ops";
import { sha256Hex } from "../replica/sha256";
import { findNode } from "./tree";

/** An editor draft: the text typed into one block, and the text its
 * textarea showed when typing started, which the user typed over. That can
 * differ from the tree's text: a remote batch reaches the tree before the
 * textarea adopts it, and a dirty textarea never adopts it at all. */
export interface PendingDraft {
  uid: BlockUid;
  text: string;
  base: string;
}

/** A draft opened on the text its textarea showed: `base` and `text` both. */
export function openDraft(uid: BlockUid, shown: string): PendingDraft {
  return { uid, text: shown, base: shown };
}

/** The text op a draft flushes. It carries the hash of the text the draft was
 * typed over (its base), not of whatever the tree holds now, so a remote edit
 * that landed under the draft forks a conflict copy instead of being
 * overwritten. It ships even when the block has left this tree (a remote
 * delete or cross-page move): the server applies it wherever the block now
 * lives, and lands an edit to a deleted block on today's daily note. Empty
 * only when nothing changed (the text equals the base) or the tree already
 * holds the text. */
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
    op: "update_text", uid, text, base_text_hash: sha256Hex(base),
    page_title: pageTitle,
  }];
}
