// pattern: Functional Core
// Drives the real outline commands from abstract descriptors and records undo
// history the way useOutline.run and undoManager do: a typed draft is held
// until the next command flushes it, joining that command's batch only under
// the FOLDS_DRAFT rule below (otherwise it lands as its own entry first), the
// batch's inverse is taken against the pre-flush tree, and undo or redo
// flushes the draft as its own entry before replaying anything.
import type { BlockUid } from "../../api/brands";
import type { BlockOp, SetViewTypeOp } from "../../api/ops";
import type { BlockNode } from "../../api/payloads";
import { withoutStamps } from "../../outline/baseTextHash";
import { selectedUids, selectionDragUids,
         type BlockSelection } from "../../outline/blockSelection";
import { allowedDepths, dropRows, resolveDrop, type DragSource,
         type DropPosition } from "../../outline/dnd";
import { backspaceAtStart, deleteSelection, indentBlock, indentSelection,
         moveBlocksTo, moveBlockDown, moveBlockUp, moveSelectionDown,
         moveSelectionUp, moveSubtreeDown, moveSubtreeUp, outdentBlock,
         outdentSelection, setCollapsed, setHeading, setViewType, splitBlock,
         type EditResult, type FocusTarget } from "../../outline/edits";
import { emptyHistory, historyAnchors, invertOps, recordEntry, resolveAnchors,
         takeRedo, takeUndo, type HistoryEntry,
         type HistoryState } from "../../outline/history";
import { captureDraft, pendingTextOps, validateOutlineFocus,
         type PendingDraft } from "../../outline/outlineState";
import { isOutlinePaste, planOutlinePaste,
         type PastedNode } from "../../outline/paste";
import { applyOps, findNode, visibleUids } from "../../outline/tree";
import { PAGE_TITLE, renderForest, type Command } from "./arbitraries";
import { readingRows, type Row } from "./reading";

/** The concrete inputs a command resolved to against the tree it ran on. */
export type Resolved =
  | { kind: "type"; uid: BlockUid; text: string }
  | { kind: "split"; uid: BlockUid; caret: number; fresh: BlockUid }
  | { kind: "backspace" | "indent" | "outdent" | "moveUp" | "moveDown" | "subtreeUp" | "subtreeDown"; uid: BlockUid }
  | { kind: "indentSel" | "outdentSel" | "selUp" | "selDown" | "deleteSel"; uids: BlockUid[] } // selectedUids order
  | { kind: "drop"; uids: BlockUid[]; position: DropPosition } // dragged roots, document order
  | { kind: "paste"; uid: BlockUid; from: number; to: number; forest: PastedNode[]; text: string; fresh: BlockUid[] }
  | { kind: "collapse"; uid: BlockUid; value: boolean }
  | { kind: "heading"; uid: BlockUid; value: BlockNode["heading"] }
  | { kind: "viewType"; uid: BlockUid; value: SetViewTypeOp["view_type"] };

export interface Step {
  command: Command;
  /** null for undo/redo and for a command with no visible row. */
  resolved: Resolved | null;
  /** The tree the command ran on (after any draft flush). */
  base: BlockNode[];
  after: BlockNode[];
  /** The command's ops, not the flushed text op; for undo/redo, the batch as
   * replayed, placements re-keyed against `base`. */
  ops: BlockOp[];
  focus: FocusTarget | null;
  /** invertOps over the recorded batch, against the pre-flush tree: it undoes a
   * folded draft too, so applyOps(after, inverse) gives that tree, not `base`.
   * null = not invertible. */
  inverse: BlockOp[] | null;
  /** For undo/redo: the rows the entry should restore. */
  undo?: { expectedRows: Row[] };
}

/** The functions a teeth check swaps for deliberately wrong versions. */
export interface Seam {
  outdentBlock: typeof outdentBlock;
  moveBlockDown: typeof moveBlockDown;
  planOutlinePaste: typeof planOutlinePaste;
  invertOps: typeof invertOps;
  deleteSelection: typeof deleteSelection;
}

export const REAL: Seam = {
  outdentBlock, moveBlockDown, planOutlinePaste, invertOps, deleteSelection,
};

export interface Run {
  steps: Step[];
  /** The tree after the final draft flush. */
  end: BlockNode[];
  history: HistoryState;
  /** The rows after the newest recorded entry (the start's when none was),
   * taken when it was recorded: what redoing every entry should restore.
   * Undo and redo only move entries between the stacks, so it stays the
   * newest whether it now tops the undo stack or bottoms the redo stack. */
  newest: Row[];
}

interface EntryRows { before: Row[]; after: Row[] }

const noop = (b: BlockNode[]): EditResult => ({ blocks: b, ops: [], focus: null });

// Keyboard commands fired from the focused textarea: only these reach run()
// with the draft still pending, so only these fold it into their batch. Any
// other gesture flushes it as its own entry first: a command on another block
// needs focus there (onFocusBlock, onArrow), a selection starts with
// onStartBlockSelection/onSelectBlock, and a chevron, block-menu or drag-handle
// click blurs the textarea (onBlurBlock), each of which calls flushNow. Those
// same gestures set the focus the next history entry records: null after a
// selection start or a blur, the target block after a focus change.
const FOLDS_DRAFT = new Set<Command["kind"]>([
  "split", "backspace", "indent", "outdent", "moveUp", "moveDown", "subtreeUp",
  "subtreeDown", "paste", "heading",
]);

function countNodes(forest: readonly PastedNode[]): number {
  return forest.reduce((n, p) => n + 1 + countNodes(p.children), 0);
}

/** Replays a history entry the way undoManager does, placements re-keyed
 * against `tree`; every replay goes through here. `ops` is the batch as
 * applied, after re-keying. */
export function replayEntry(tree: BlockNode[], entry: HistoryEntry,
                            direction: "undo" | "redo"): { blocks: BlockNode[]; ops: BlockOp[] } {
  const undoing = direction === "undo";
  const ops = resolveAnchors(tree, PAGE_TITLE, undoing ? entry.inverse : entry.ops,
                             undoing ? entry.anchors.inverse : entry.anchors.ops);
  return { blocks: applyOps(tree, ops, PAGE_TITLE), ops };
}

export function runSequence(start: BlockNode[], commands: readonly Command[],
                            seam: Seam = REAL): Run {
  let tree = start;
  let draft: PendingDraft | null = null;
  let history = emptyHistory();
  let focus: FocusTarget | null = null;
  let minted = 0;
  // Entries are the same objects through takeUndo/takeRedo, so the rows each
  // entry should restore ride alongside without a second stack to keep in step.
  const entryRows = new Map<HistoryEntry, EntryRows>();
  let newest = readingRows(start);
  const steps: Step[] = [];
  const mint = (): BlockUid => `n${minted++}` as BlockUid;

  /** What the editor shows: the committed tree with the draft typed over it. */
  const displayed = (): BlockNode[] =>
    draft && findNode(tree, draft.uid)
      ? applyOps(tree, [{ op: "update_text", uid: draft.uid, text: draft.text }], PAGE_TITLE)
      : tree;

  /** useOutline.run: flush the draft, run the command on the flushed tree,
   * record the whole batch with its inverse against the pre-flush tree. */
  const run = (fn: (b: BlockNode[]) => EditResult) => {
    const textOps = pendingTextOps(draft, tree, PAGE_TITLE);
    draft = null;
    const pre = tree;
    const undoableTextOps = textOps.filter((op) => findNode(pre, op.uid));
    const base = textOps.length > 0 ? applyOps(pre, textOps, PAGE_TITLE) : pre;
    const result = fn(base);
    if (textOps.length + result.ops.length === 0) {
      return { base, after: base, result, inverse: [] as BlockOp[] | null };
    }
    const next = result.ops.length > 0 ? result.blocks : base;
    tree = next;
    const recorded = [...undoableTextOps.map(withoutStamps), ...result.ops];
    const inverse = seam.invertOps(pre, PAGE_TITLE, recorded);
    if (inverse !== null && inverse.length > 0) {
      const entry: HistoryEntry = {
        pageTitle: PAGE_TITLE,
        ops: recorded,
        inverse,
        anchors: historyAnchors(pre, PAGE_TITLE, recorded, inverse),
        focusBefore: focus,
        focusAfter: result.focus ?? focus,
      };
      history = recordEntry(history, entry);
      newest = readingRows(next);
      entryRows.set(entry, { before: readingRows(pre), after: newest });
    }
    if (result.focus) focus = result.focus;
    return { base, after: next, result, inverse };
  };

  const flushNow = () => { run(noop); };
  // Functions, not reads of `draft` and `focus`: the closures above reassign
  // them, which the loop's narrowing cannot see.
  const heldUid = (): BlockUid | null => draft?.uid ?? null;
  const focusedUid = (): BlockUid | null => focus?.uid ?? null;

  const replay = (command: Command & { kind: "undo" | "redo" }): Step => {
    flushNow();
    const base = tree;
    const { state, entry } = command.kind === "undo" ? takeUndo(history) : takeRedo(history);
    history = state;
    if (!entry) {
      return { command, resolved: null, base, after: base, ops: [], focus: null, inverse: [],
               undo: { expectedRows: readingRows(base) } };
    }
    const undoing = command.kind === "undo";
    const replayed = replayEntry(base, entry, command.kind);
    tree = replayed.blocks;
    // useOutline's applyFocus: the entry's focus, validated as useOutline does.
    focus = validateOutlineFocus(undoing ? entry.focusBefore : entry.focusAfter, tree);
    const rows = entryRows.get(entry);
    if (!rows) throw new Error("runner: history entry without recorded rows");
    return { command, resolved: null, base, after: tree, ops: replayed.ops, focus,
             inverse: undoing ? entry.ops : entry.inverse,
             undo: { expectedRows: undoing ? rows.before : rows.after } };
  };

  const type = (command: Command & { kind: "type" }, uid: BlockUid): Step => {
    // A draft on another block is flushed before this one starts.
    if (draft && draft.uid !== uid) flushNow();
    const base = displayed();
    draft = captureDraft(draft, uid, command.text, tree);
    const after = displayed();
    const before = findNode(base, uid)?.text ?? "";
    const ops: BlockOp[] = before !== command.text
      ? [{ op: "update_text", uid, text: command.text }] : [];
    // onFocusBlock sets the caret once, when the block takes focus, and typing
    // never moves it: an entry's focus keeps that caret. A block focused to be
    // typed into takes it at the end of the text it showed then.
    if (focusedUid() !== uid) focus = { uid, cursor: before.length };
    // Typing returns no focus; the editor's focus is left where it is.
    return { command, resolved: { kind: "type", uid, text: command.text }, base, after, ops,
             focus: null, inverse: seam.invertOps(base, PAGE_TITLE, ops) };
  };

  for (const command of commands) {
    if (command.kind === "undo" || command.kind === "redo") {
      steps.push(replay(command));
      continue;
    }
    const shown = displayed();
    const rows = visibleUids(shown);
    if (rows.length === 0) {
      steps.push({ command, resolved: null, base: shown, after: shown, ops: [], focus: null,
                   inverse: [] });
      continue;
    }
    const r = command.row % rows.length;
    const uid = rows[r];
    if (command.kind === "type") {
      steps.push(type(command, uid));
      continue;
    }
    const text = findNode(shown, uid)?.text ?? "";
    const selection = (span: number): BlockSelection =>
      ({ anchor: uid, head: rows[Math.min(r + span, rows.length - 1)] });

    let resolved: Resolved;
    let edit: ((b: BlockNode[]) => EditResult) | null;
    switch (command.kind) {
      case "split": {
        const caret = Math.round(((command.caret % 101) / 100) * text.length);
        const fresh = mint();
        resolved = { kind: "split", uid, caret, fresh };
        edit = (b) => splitBlock(b, PAGE_TITLE, uid, caret, fresh);
        break;
      }
      case "backspace":
        resolved = { kind: command.kind, uid };
        edit = (b) => backspaceAtStart(b, PAGE_TITLE, uid);
        break;
      case "indent":
        resolved = { kind: command.kind, uid };
        edit = (b) => indentBlock(b, PAGE_TITLE, uid);
        break;
      case "outdent":
        resolved = { kind: command.kind, uid };
        edit = (b) => seam.outdentBlock(b, PAGE_TITLE, uid);
        break;
      case "moveUp":
        resolved = { kind: command.kind, uid };
        edit = (b) => moveBlockUp(b, PAGE_TITLE, uid);
        break;
      case "moveDown":
        resolved = { kind: command.kind, uid };
        edit = (b) => seam.moveBlockDown(b, PAGE_TITLE, uid);
        break;
      case "subtreeUp":
        resolved = { kind: command.kind, uid };
        edit = (b) => moveSubtreeUp(b, PAGE_TITLE, uid);
        break;
      case "subtreeDown":
        resolved = { kind: command.kind, uid };
        edit = (b) => moveSubtreeDown(b, PAGE_TITLE, uid);
        break;
      case "indentSel":
      case "outdentSel":
      case "selUp":
      case "selDown":
      case "deleteSel": {
        const sel = selection(command.span);
        const plan = {
          indentSel: indentSelection, outdentSel: outdentSelection,
          selUp: moveSelectionUp, selDown: moveSelectionDown,
          deleteSel: seam.deleteSelection,
        }[command.kind];
        resolved = { kind: command.kind, uids: selectedUids(shown, sel) };
        edit = (b) => plan(b, PAGE_TITLE, selectedUids(b, sel));
        break;
      }
      case "drop": {
        const uids = command.span > 0
          ? selectionDragUids(shown, selection(command.span), uid) ?? [uid] : [uid];
        const drag: DragSource = { uid, pageTitle: PAGE_TITLE, ...(command.span > 0 ? { uids } : {}) };
        const dropAt = dropRows(shown, drag, PAGE_TITLE);
        const boundary = command.boundary % (dropAt.length + 1);
        const allowed = allowedDepths(dropAt, boundary);
        const position = { boundary, depth: allowed[command.depth % allowed.length] };
        resolved = { kind: "drop", uids, position };
        const target = resolveDrop(shown, PAGE_TITLE, drag, position);
        edit = target
          ? (b) => moveBlocksTo(b, PAGE_TITLE, uids, target.parent_uid, target.order_idx)
          : null;
        break;
      }
      case "paste": {
        const pasted = renderForest(command.forest, command.style);
        if (!isOutlinePaste(pasted)) throw new Error("runner: paste text is not an outline paste");
        const [from, to] = [command.from, command.to]
          .map((n) => n % (text.length + 1)).sort((x, y) => x - y);
        // The first root splices into the row; every other node is created,
        // depth-first, and takes the next fresh uid.
        const fresh = Array.from({ length: countNodes(command.forest) - 1 }, mint);
        let handed = 0;
        const newUid = (): BlockUid => {
          if (handed === fresh.length) {
            throw new Error("runner: paste created more blocks than its forest has");
          }
          return fresh[handed++];
        };
        resolved = { kind: "paste", uid, from, to, forest: command.forest, text: pasted, fresh };
        edit = (b) => seam.planOutlinePaste(b, PAGE_TITLE, uid, from, to, pasted, newUid);
        break;
      }
      case "collapse":
        resolved = { kind: "collapse", uid, value: command.value };
        edit = (b) => setCollapsed(b, PAGE_TITLE, uid, command.value);
        break;
      case "heading":
        resolved = { kind: "heading", uid, value: command.value };
        edit = (b) => setHeading(b, PAGE_TITLE, uid, command.value);
        break;
      case "viewType":
        resolved = { kind: "viewType", uid, value: command.value };
        edit = (b) => setViewType(b, PAGE_TITLE, uid, command.value);
        break;
    }

    const folds = FOLDS_DRAFT.has(command.kind);
    const held = heldUid();
    if (held !== null && !(folds && held === uid)) flushNow();
    if (!folds) focus = null;
    else if (focusedUid() !== uid) focus = { uid, cursor: text.length };
    if (edit === null) {
      // A drop back where it came from: the app never calls moveTo.
      steps.push({ command, resolved, base: tree, after: tree, ops: [], focus: null,
                   inverse: [] });
      continue;
    }
    const done = run(edit);
    steps.push({ command, resolved, base: done.base, after: done.after, ops: done.result.ops,
                 focus: done.result.focus, inverse: done.inverse });
  }

  flushNow();
  return { steps, end: tree, history, newest };
}
