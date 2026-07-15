// pattern: Functional Core
// Causality for one title's shared outline. The shell supplies ticket ids,
// read tokens, and I/O; this module only decides whether a tree is safe to
// adopt and whether settlement requires a fresh authoritative read.
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import type { FocusTarget } from "./edits";
import { applyOps, findNode } from "./tree";

export interface ReadToken {
  requestId: number;
  revisionAtDispatch: number;
}

export interface DeferredAuthoritative {
  token: ReadToken;
  blocks: BlockNode[];
}

export interface OutlineState {
  title: string;
  blocks: BlockNode[];
  revision: number;
  nextRequestId: number;
  latestRequestId: number;
  relevantWrites: ReadonlySet<string>;
  deferredAuthoritative: DeferredAuthoritative | null;
}

export type OutlineEvent =
  | { type: "local-ops"; ticketId: string; ops: readonly BlockOp[] }
  | { type: "local-tree"; blocks: BlockNode[] }
  | { type: "remote-ops"; ops: readonly BlockOp[] }
  | { type: "write-started"; ticketId: string; scope: readonly string[] }
  | { type: "authoritative"; token: ReadToken; blocks: BlockNode[] }
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

export function transitionOutline(
  state: OutlineState,
  event: OutlineEvent,
): OutlineTransition {
  if (event.type === "local-ops") {
    const relevantWrites = new Set(state.relevantWrites);
    relevantWrites.add(event.ticketId);
    return {
      state: {
        ...withBlocks(state,
          applyOps(state.blocks, [...event.ops], state.title)),
        relevantWrites,
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
    return { state: { ...state, relevantWrites }, effects: [] };
  }
  if (event.type === "authoritative") {
    if (event.token.requestId !== state.latestRequestId) {
      return { state, effects: [] };
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
  const settled = { ...state, relevantWrites };
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
