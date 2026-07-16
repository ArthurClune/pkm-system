// pattern: Functional Core
// Causality for one title's shared outline. The shell supplies ticket ids,
// read tokens, and I/O; this module only decides whether a tree is safe to
// adopt and whether settlement requires a fresh authoritative read.
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import type { FocusTarget } from "./edits";
import type { TextSelection } from "./keyEdits";
import { applyOps, findNode, insertSubtree } from "./tree";

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
  | { type: "local-ops"; ticketId: string; ops: readonly BlockOp[] }
  | { type: "local-tree"; blocks: BlockNode[] }
  | { type: "remote-ops"; ops: readonly BlockOp[] }
  | { type: "write-started"; ticketId: string; scope: readonly string[];
      replay?: readonly OutlineReplayAction[]; ops?: readonly BlockOp[] }
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

function scopeContainsTitle(scope: readonly string[], title: string): boolean {
  return scope[0] === "page" && scope.slice(1).includes(title);
}

function changed(before: BlockNode[], after: BlockNode[]): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

function withBlocks(state: OutlineState, blocks: BlockNode[]): OutlineState {
  if (!changed(state.blocks, blocks)) return state;
  return { ...state, blocks, revision: state.revision + 1 };
}

function adopt(state: OutlineState, blocks: BlockNode[]): OutlineState {
  return {
    ...withBlocks(state, blocks),
    deferredAuthoritative: null,
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

export function transitionOutline(
  state: OutlineState,
  event: OutlineEvent,
): OutlineTransition {
  if (event.type === "local-ops") {
    const relevantWrites = new Set(state.relevantWrites);
    relevantWrites.add(event.ticketId);
    const relevantWriteReplays = new Map(state.relevantWriteReplays);
    relevantWriteReplays.set(event.ticketId, [{
      type: "ops", ops: [...event.ops],
    }]);
    return {
      state: {
        ...withBlocks(state,
          applyOps(state.blocks, [...event.ops], state.title)),
        relevantWrites,
        relevantWriteReplays,
      },
      effects: [],
    };
  }
  if (event.type === "local-tree") {
    return { state: withBlocks(state, event.blocks), effects: [] };
  }
  if (event.type === "remote-ops") {
    return {
      state: withBlocks(state,
        applyOps(state.blocks, [...event.ops], state.title)),
      effects: [],
    };
  }
  if (event.type === "write-started") {
    if (!scopeContainsTitle(event.scope, state.title) ||
        state.relevantWrites.has(event.ticketId)) {
      return { state, effects: [] };
    }
    const relevantWrites = new Set(state.relevantWrites);
    relevantWrites.add(event.ticketId);
    const relevantWriteReplays = new Map(state.relevantWriteReplays);
    if (event.replay !== undefined) {
      relevantWriteReplays.set(event.ticketId, [...event.replay]);
    } else if (event.ops !== undefined) {
      relevantWriteReplays.set(event.ticketId, [{
        type: "ops", ops: [...event.ops],
      }]);
    }
    return {
      state: { ...state, relevantWrites, relevantWriteReplays }, effects: [],
    };
  }
  if (event.type === "write-replay") {
    if (!state.relevantWrites.has(event.ticketId)) {
      return { state, effects: [] };
    }
    const relevantWriteReplays = new Map(state.relevantWriteReplays);
    relevantWriteReplays.set(event.ticketId, [...event.replay]);
    return { state: { ...state, relevantWriteReplays }, effects: [] };
  }
  if (event.type === "authoritative" || event.type === "authoritative-repair") {
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
