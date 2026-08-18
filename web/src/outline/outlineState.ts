// pattern: Functional Core
// Causality for one title's shared outline. The shell supplies ticket ids,
// read tokens, and I/O; this module only decides whether a tree is safe to
// adopt and whether settlement requires a fresh authoritative read.
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import type { FocusTarget } from "./edits";
import type { TextSelection } from "./keyEdits";
import { applyOps, applyOpsWithChange, blocksEqual, findNode,
         insertSubtree } from "./tree";
import { bumpedUids } from "./blockStamps";

export interface ReadToken {
  requestId: number;
  revisionAtDispatch: number;
}

export interface DeferredAuthoritative {
  token: ReadToken;
  blocks: BlockNode[];
}

export type OutlineReplayAction =
  | { type: "ops"; ops: readonly BlockOp[] }
  | { type: "insert-subtree"; node: BlockNode;
      parentUid: string | null; orderIdx: number };

export interface OutlineState {
  title: string;
  blocks: BlockNode[];
  revision: number;
  nextRequestId: number;
  latestRequestId: number;
  relevantWrites: ReadonlySet<string>;
  relevantWriteReplays: ReadonlyMap<string, readonly OutlineReplayAction[]>;
  deferredAuthoritative: DeferredAuthoritative | null;
}

export type OutlineEvent =
  | { type: "local-ops"; ticketId: string; ops: readonly BlockOp[];
      nowMs: number }
  | { type: "local-tree"; blocks: BlockNode[] }
  | { type: "remote-ops"; ops: readonly BlockOp[]; nowMs: number }
  // The replay is what a repair rebases this write onto a fresh server tree
  // with, so every announcement must state it — `[]` only when the write
  // genuinely has nothing to reapply here.
  | { type: "write-started"; ticketId: string; scope: readonly string[];
      replay: readonly OutlineReplayAction[] }
  | { type: "write-replay"; ticketId: string;
      replay: readonly OutlineReplayAction[] }
  | { type: "authoritative"; token: ReadToken; blocks: BlockNode[] }
  | { type: "authoritative-repair"; token: ReadToken; blocks: BlockNode[] }
  | { type: "write-settled"; ticketId: string };

export type OutlineEffect = {
  type: "request-authoritative";
  reason: "write-settled" | "revision-advanced";
};

export interface OutlineTransition {
  state: OutlineState;
  effects: readonly OutlineEffect[];
}

export function createOutlineState(
  title: string,
  blocks: BlockNode[],
): OutlineState {
  return {
    title,
    blocks,
    revision: 0,
    nextRequestId: 1,
    latestRequestId: 0,
    relevantWrites: new Set(),
    relevantWriteReplays: new Map(),
    deferredAuthoritative: null,
  };
}

export function beginAuthoritativeRead(state: OutlineState): {
  state: OutlineState;
  token: ReadToken;
} {
  const reserved = reserveAuthoritativeRead(state);
  return {
    token: reserved.token,
    state: activateAuthoritativeRead(reserved.state, reserved.token)!,
  };
}

/** Reserve dispatch-time causality without superseding a request until the
 * caller learns that its multi-title response actually contains this title. */
export function reserveAuthoritativeRead(state: OutlineState): {
  state: OutlineState;
  token: ReadToken;
} {
  const token = {
    requestId: state.nextRequestId,
    revisionAtDispatch: state.revision,
  };
  return {
    token,
    state: {
      ...state,
      nextRequestId: state.nextRequestId + 1,
    },
  };
}

/** Promote a reserved read only if no later request has already won. */
export function activateAuthoritativeRead(
  state: OutlineState,
  token: ReadToken,
): OutlineState | null {
  if (token.requestId <= state.latestRequestId) return null;
  return { ...state, latestRequestId: token.requestId };
}

/** Shared with outlineSessions.ts's write tracking — both need the same
 * "does this delivery ticket's scope cover this title" test. */
export function scopeContainsTitle(scope: readonly string[], title: string): boolean {
  return scope[0] === "page" && scope.slice(1).includes(title);
}

/** A tree that changed advances the revision; one that didn't leaves the
 * state object identical, so React skips the render and the causality checks
 * against `revisionAtDispatch` still see an unmoved outline. Callers own the
 * `changed` verdict because they know where the tree came from. */
function withBlocks(state: OutlineState, blocks: BlockNode[],
                    changed: boolean): OutlineState {
  if (!changed) return state;
  return { ...state, blocks, revision: state.revision + 1 };
}

/** For a tree that arrived whole — a drag/drop result, a server read — with
 * no op set to say what it altered. A structural compare is the only signal
 * available; the op paths have a cheaper one and must not come through here. */
function withComparedBlocks(state: OutlineState,
                            blocks: BlockNode[]): OutlineState {
  return withBlocks(state, blocks, !blocksEqual(state.blocks, blocks));
}

function adopt(state: OutlineState, blocks: BlockNode[]): OutlineState {
  return {
    ...withComparedBlocks(state, blocks),
    deferredAuthoritative: null,
  };
}

/** The tree an op batch leaves behind, plus whether anything moved. Two
 * sources of change: the ops themselves, and the stamps pkm-4ler puts on the
 * blocks they touched — a batch whose ops all resolve to what was already
 * there can still bump updated_at, exactly as the server does. */
function applyBatch(state: OutlineState, ops: readonly BlockOp[],
                    nowMs: number): { blocks: BlockNode[]; changed: boolean } {
  const applied = applyOpsWithChange(state.blocks, [...ops], state.title);
  const stamped = stampBumped(applied.blocks, ops, nowMs);
  return {
    blocks: stamped,
    changed: applied.changed || stamped !== applied.blocks,
  };
}

function replayActions(
  blocks: BlockNode[],
  actions: readonly OutlineReplayAction[],
  title: string,
): BlockNode[] {
  let replayed = blocks;
  for (const action of actions) {
    if (action.type === "ops") {
      replayed = applyOps(replayed, [...action.ops], title);
    } else if (findNode(replayed, action.node.uid)) {
      replayed = applyOps(replayed, [{
        op: "move", uid: action.node.uid, parent_uid: action.parentUid,
        order_idx: action.orderIdx, page_title: title,
      }], title);
    } else {
      replayed = insertSubtree(
        replayed, action.node, action.parentUid, action.orderIdx,
      );
    }
  }
  return replayed;
}

/** Stamp updated_at on the blocks a batch changed (bean pkm-4ler). Runs on
 * the tree AFTER applyOps, so a uid the batch deleted, or an op aimed at
 * another page, is skipped simply by not being here. The clock arrives with
 * the event: this module stays pure, and a remote edit stamps exactly like a
 * local one because both flow through here.
 *
 * Structure-shares: a subtree with nothing to stamp is returned by reference,
 * so `result === blocks` is an exact "nothing was stamped" signal — which is
 * how applyBatch tells a stamp-only change from no change at all. */
function stampBumped(blocks: BlockNode[], ops: readonly BlockOp[],
                     nowMs: number): BlockNode[] {
  const bumped = new Set(bumpedUids(ops));
  if (bumped.size === 0) return blocks;
  const walk = (nodes: BlockNode[]): BlockNode[] => {
    let dirty = false;
    const stamped = nodes.map((n) => {
      const children = walk(n.children);
      const stamp = bumped.has(n.uid) && n.updated_at !== nowMs;
      if (!stamp && children === n.children) return n;
      dirty = true;
      return { ...n, updated_at: stamp ? nowMs : n.updated_at, children };
    });
    return dirty ? stamped : nodes;
  };
  return walk(blocks);
}

/** Every event is handled by its own `case` so that adding a variant is a
 * compile error here, not a silent fall-through into write settlement. */
export function transitionOutline(
  state: OutlineState,
  event: OutlineEvent,
): OutlineTransition {
  switch (event.type) {
    case "local-ops": {
      const relevantWrites = new Set(state.relevantWrites);
      relevantWrites.add(event.ticketId);
      const relevantWriteReplays = new Map(state.relevantWriteReplays);
      relevantWriteReplays.set(event.ticketId, [{
        type: "ops", ops: [...event.ops],
      }]);
      const applied = applyBatch(state, event.ops, event.nowMs);
      return {
        state: {
          ...withBlocks(state, applied.blocks, applied.changed),
          relevantWrites,
          relevantWriteReplays,
        },
        effects: [],
      };
    }
    case "local-tree":
      return { state: withComparedBlocks(state, event.blocks), effects: [] };
    case "remote-ops": {
      const applied = applyBatch(state, event.ops, event.nowMs);
      return {
        state: withBlocks(state, applied.blocks, applied.changed), effects: [],
      };
    }
    case "write-started": {
      // A ticket already relevant here keeps the replay it was recorded with:
      // `local-ops` records the real ops the moment the edit applies, and the
      // delivery registry then announces the same ticket with whatever it
      // holds. Re-recording would lose the newer of the two.
      if (!scopeContainsTitle(event.scope, state.title) ||
          state.relevantWrites.has(event.ticketId)) {
        return { state, effects: [] };
      }
      const relevantWrites = new Set(state.relevantWrites);
      relevantWrites.add(event.ticketId);
      const relevantWriteReplays = new Map(state.relevantWriteReplays);
      relevantWriteReplays.set(event.ticketId, [...event.replay]);
      return {
        state: { ...state, relevantWrites, relevantWriteReplays }, effects: [],
      };
    }
    case "write-replay": {
      if (!state.relevantWrites.has(event.ticketId)) {
        return { state, effects: [] };
      }
      const relevantWriteReplays = new Map(state.relevantWriteReplays);
      relevantWriteReplays.set(event.ticketId, [...event.replay]);
      return { state: { ...state, relevantWriteReplays }, effects: [] };
    }
    case "authoritative":
    case "authoritative-repair": {
      if (event.token.requestId !== state.latestRequestId) {
        return { state, effects: [] };
      }
      if (event.type === "authoritative-repair") {
        if (state.revision !== event.token.revisionAtDispatch) {
          return { state, effects: [] };
        }
        let rebased = event.blocks;
        for (const ticketId of state.relevantWrites) {
          const replay = state.relevantWriteReplays.get(ticketId);
          if (replay && replay.length > 0) {
            rebased = replayActions(rebased, replay, state.title);
          }
        }
        return { state: adopt(state, rebased), effects: [] };
      }
      if (state.revision === event.token.revisionAtDispatch &&
          state.relevantWrites.size === 0) {
        return { state: adopt(state, event.blocks), effects: [] };
      }
      const deferred = {
        state: {
          ...state,
          deferredAuthoritative: { token: event.token, blocks: event.blocks },
        },
        effects: [] as readonly OutlineEffect[],
      };
      if (state.relevantWrites.size > 0) return deferred;
      return {
        ...deferred,
        effects: [{
          type: "request-authoritative", reason: "revision-advanced",
        }],
      };
    }
    case "write-settled": {
      if (!state.relevantWrites.has(event.ticketId)) {
        return { state, effects: [] };
      }
      const relevantWrites = new Set(state.relevantWrites);
      relevantWrites.delete(event.ticketId);
      const relevantWriteReplays = new Map(state.relevantWriteReplays);
      relevantWriteReplays.delete(event.ticketId);
      const settled = { ...state, relevantWrites, relevantWriteReplays };
      if (relevantWrites.size > 0) return { state: settled, effects: [] };
      return {
        state: { ...settled, deferredAuthoritative: null },
        effects: [{ type: "request-authoritative", reason: "write-settled" }],
      };
    }
    default: {
      const exhaustive: never = event;
      throw new Error(`unhandled outline event: ${String(exhaustive)}`);
    }
  }
}

export function validateOutlineFocus(
  focus: FocusTarget | null,
  blocks: BlockNode[],
): FocusTarget | null {
  return focus && findNode(blocks, focus.uid) ? focus : null;
}

/** The text op a debounced draft should flush before a structural edit runs.
 * Empty when nothing is pending, when a remote batch already deleted the block
 * (flushing would doom the whole batch), or when the draft never changed the
 * text. */
export function pendingTextOps(
  pending: { uid: string; text: string } | null,
  blocks: BlockNode[],
): BlockOp[] {
  if (!pending) return [];
  const node = findNode(blocks, pending.uid);
  if (!node || node.text === pending.text) return [];
  return [{ op: "update_text", uid: pending.uid, text: pending.text }];
}

/** Splice uploaded asset markdown into a block's text at the pre-upload caret,
 * clamped to the current length (the user may have kept typing during a slow
 * upload). Returns the new text plus the caret placed after the insertion. */
export function spliceUploadedMarkdown(
  text: string,
  requestedOffset: number,
  markdown: string,
): TextSelection {
  const at = Math.min(requestedOffset, text.length);
  const spliced = text.slice(0, at) + markdown + text.slice(at);
  const caret = at + markdown.length;
  return { text: spliced, selStart: caret, selEnd: caret };
}
