// pattern: Functional Core
// What an edit command and an undo or redo replay become before anything is
// sent: the ops on the wire, the tree to show, the verdict, and for a
// command the history entry. useOutline.run and undoManager's dispatch paths
// execute these plans; the outline property runs the same functions.
import type { CanonicalTitle, Sha256Hex } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { stampBaseTextHashes, withoutStamps } from "./baseTextHash";
import { pendingTextOps, type PendingDraft } from "./draft";
import { editRefusal } from "./editRefusal";
import type { EditResult, FocusTarget } from "./edits";
import { historyAnchors, invertOps, resolveAnchors, type BatchAnchors,
         type HistoryEntry } from "./history";
import { applyOps, findNode } from "./tree";

/** `none`: the command planned no ops, so it was not judged, and a notice
 * already showing stays. `applied` clears one. */
export type CommandVerdict =
  | { kind: "none" }
  | { kind: "applied" }
  | { kind: "refused"; notice: string };

export interface PlannedCommand {
  verdict: CommandVerdict;
  /** `pre` with the draft's text ops applied: what the command ran on. */
  base: BlockNode[];
  /** The command's own ops; [] when refused. */
  ops: BlockOp[];
  /** The tree to show. */
  next: BlockNode[];
  /** Stamped against `pre`, the draft's text ops first; [] when nothing
   * ships. */
  wireOps: BlockOp[];
  /** Of the recorded batch against `pre`; null when it cannot be inverted
   * from this tree (a cross-page move); [] when nothing ships. */
  inverse: BlockOp[] | null;
  /** Set only when `inverse` is non-empty. */
  entry: HistoryEntry | null;
  /** The command's own focus; null when refused or when nothing ships. */
  focus: FocusTarget | null;
}

/** Flush `pending` into the command's batch: run `fn` on the tree the draft
 * leaves, judge its ops, and plan what ships and what history records. */
export function planCommand(
  pre: BlockNode[], pending: PendingDraft | null,
  fn: (base: BlockNode[]) => EditResult, pageTitle: CanonicalTitle,
  focusBefore: FocusTarget | null, freshAssets: readonly Sha256Hex[],
): PlannedCommand {
  // The draft ships even when its block has left the tree, and its hash is
  // of the text it was typed over, not of what the tree holds now.
  const textOps = pendingTextOps(pending, pre, pageTitle);
  // A draft whose block has left this tree still ships, but it cannot be
  // inverted here; leaving it out of the history entry keeps the rest of
  // the batch undoable, and a redo does not re-send it.
  const undoableTextOps = textOps.filter((op) => findNode(pre, op.uid));
  const base = textOps.length > 0 ? applyOps(pre, textOps, pageTitle) : pre;
  let result = fn(base);
  let verdict: CommandVerdict = { kind: "none" };
  // A command that would put a block past the depth cap, or store a text
  // past a text limit, applies none of its ops, but the draft's text ops
  // above still ship: they are what the user typed, and sent with the
  // command the server would refuse them too, since it refuses a batch
  // whole. Queued, that refusal would also drop the batch's other ops
  // (sync/rejection.ts), so the web never queues one.
  if (result.ops.length > 0) {
    const refusal = editRefusal(result.blocks, result.ops, textOps);
    if (refusal === null) {
      verdict = { kind: "applied" };
    } else {
      verdict = { kind: "refused", notice: refusal };
      result = { blocks: base, ops: [], focus: null };
    }
  }
  const ops = [...textOps, ...result.ops];
  const next = result.ops.length > 0 ? result.blocks : base;
  if (ops.length === 0) {
    return { verdict, base, ops: result.ops, next, wireOps: [], inverse: [],
             entry: null, focus: null };
  }
  // Conflict protection must not depend on the ops reaching the database:
  // the guards (base_text_hash on update_text, base_subtree_hash on
  // delete) are stamped here, against `pre` — the pre-flush tree the whole
  // batch grew from — because an online-only session's ops never reach
  // replica/queue.ts, the other choke point that stamps them.
  const wireOps = stampBaseTextHashes(pre, pageTitle, ops);
  // Undo history: record the batch with its inverse, computed against the
  // pre-flush tree the full batch (text ops + the command's) grew from.
  // Empty inverse = nothing undoable (collapse-only / create_page); null =
  // not invertible from this tree (cross-page move) — skip, history stays
  // best-effort.
  //
  // Deliberately the UNSTAMPED ops: a hash captured now is stale by the time
  // undo/redo replays the entry, and a stale hash lands a spurious
  // [[conflict]] header on the daily note. planReplay stamps at replay time
  // instead. The flushed text op arrives already stamped with the draft's
  // base, so its stamps are stripped here.
  //
  // Placement anchors are read off `pre` too, so a replay re-keys each
  // placement against the tree it lands on (see history.ts).
  const recorded = [...undoableTextOps.map(withoutStamps), ...result.ops];
  const inverse = invertOps(pre, pageTitle, recorded);
  const entry: HistoryEntry | null = inverse !== null && inverse.length > 0
    ? {
        pageTitle, ops: recorded, inverse,
        anchors: historyAnchors(pre, pageTitle, recorded, inverse),
        freshAssets,
        focusBefore,
        focusAfter: result.focus ?? focusBefore,
      }
    : null;
  return { verdict, base, ops: result.ops, next, wireOps, inverse, entry,
           focus: result.focus };
}

export interface PlannedReplay {
  refusal: string | null;
  /** Re-keyed against `live`; the batch itself when `live` is null. */
  resolved: BlockOp[];
  /** The tree `resolved` leaves; null when `live` is null. */
  next: BlockNode[] | null;
  /** Stamped against `live`, unstamped when `live` is null; [] when
   * refused. */
  wireOps: BlockOp[];
}

/** An undo or redo replay of a recorded batch onto `live`, the page's tree
 * as it is now, or null when it could not be read. */
export function planReplay(live: BlockNode[] | null, batch: readonly BlockOp[],
                           anchors: BatchAnchors,
                           pageTitle: CanonicalTitle): PlannedReplay {
  if (live === null) {
    // Without a tree the recorded keys are right only while nothing shifted
    // the page's keys since recording, and an online-only session never
    // fills the missing hashes in. The depth is left to the server; the
    // texts are judged, since that needs no tree.
    const refusal = editRefusal(null, batch, []);
    return { refusal, resolved: [...batch], next: null,
             wireOps: refusal === null ? [...batch] : [] };
  }
  // The hash must be taken against the tree as it is now, not as it was when
  // the entry was recorded, or a replay after any later edit would carry a
  // stale hash and land a spurious daily-note [[conflict]] header.
  // Placements are re-keyed against the same tree, before stamping, so the
  // hashes cover the ops that actually ship (history.ts states the anchor
  // rule).
  const resolved = resolveAnchors(live, pageTitle, batch, anchors);
  const next = applyOps(live, resolved, pageTitle);
  const refusal = editRefusal(next, resolved, []);
  return { refusal, resolved, next,
           wireOps: refusal === null
             ? stampBaseTextHashes(live, pageTitle, resolved) : [] };
}
