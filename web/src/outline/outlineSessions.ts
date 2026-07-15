// pattern: Imperative Shell
// Per-title external store for flushed trees, authoritative read causality,
// scoped delivery tickets, and the single editable view lease. Registry
// acquisition happens from effects, never render.
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import type { WriteTicket } from "../sync/opQueue";
import type { WsBatch } from "../sync/socket";
import {
  beginAuthoritativeRead as beginRead,
  activateAuthoritativeRead,
  createOutlineState,
  reserveAuthoritativeRead,
  transitionOutline,
  type OutlineEffect,
  type OutlineState,
  type ReadToken,
} from "./outlineState";
import { findNode } from "./tree";

export type { ReadToken } from "./outlineState";
export type AuthoritativeReadSource =
  "parent" | "resync" | "cross-page-move" | "write-settled";

export interface SharedOutlineSnapshot {
  blocks: BlockNode[];
  revision: number;
}

export interface EditorLease {
  readonly granted: boolean;
  subscribe(listener: () => void): () => void;
  release(): void;
}

export interface OutlineSessionHandle {
  getSnapshot(): SharedOutlineSnapshot;
  subscribe(listener: () => void): () => void;
  claimEditor(owner: symbol): EditorLease;
  beginAuthoritativeRead(source: AuthoritativeReadSource): ReadToken;
  receiveAuthoritative(token: ReadToken, blocks: BlockNode[]): void;
  cancelAuthoritativeRead(token: ReadToken): void;
  setAuthoritativeLoader(load: () => Promise<BlockNode[]>): () => void;
  applyLocal(ticket: WriteTicket, ops: readonly BlockOp[]): void;
  applyOptimistic(blocks: BlockNode[]): void;
  applyRemote(batch: WsBatch): {
    applied: boolean;
    needsAuthoritative: boolean;
  };
  requestAuthoritative(load: () => Promise<BlockNode[]>): Promise<void>;
  release(): void;
}

export interface CapturedOutlineRead {
  receive(blocks: BlockNode[]): void;
  release(): void;
}

interface LeaseRecord {
  owner: symbol;
  granted: boolean;
  released: boolean;
  listeners: Set<() => void>;
}

interface Session {
  title: string;
  state: OutlineState;
  snapshot: SharedOutlineSnapshot;
  bootstrapped: boolean;
  handles: number;
  listeners: Set<() => void>;
  editor: LeaseRecord | null;
  waiters: LeaseRecord[];
  seenRemote: WeakSet<WsBatch>;
  authoritativeRead: Promise<void> | null;
  authoritativeRepair: Promise<void> | null;
  authoritativeAgain: boolean;
  reservations: number;
  loaders: Map<symbol, () => Promise<BlockNode[]>>;
  trackedWrites: Set<string>;
  manualReads: Set<number>;
}

const sessions = new Map<string, Session>();
const unresolvedWrites = new Map<string, {
  ticket: WriteTicket;
  ops: readonly BlockOp[];
}>();

function maybeDeleteSession(session: Session): void {
  if (session.handles === 0 && session.reservations === 0 &&
      session.trackedWrites.size === 0 && session.authoritativeRead === null &&
      session.authoritativeRepair === null &&
      sessions.get(session.title) === session) {
    sessions.delete(session.title);
  }
}

function publish(session: Session): void {
  session.snapshot = {
    blocks: session.state.blocks,
    revision: session.state.revision,
  };
  for (const listener of session.listeners) listener();
}

function applyTransition(
  session: Session,
  result: ReturnType<typeof transitionOutline>,
): void {
  const prior = session.state;
  session.state = result.state;
  if (prior.blocks !== result.state.blocks ||
      prior.revision !== result.state.revision) publish(session);
  runEffects(session, result.effects);
}

function expireManualReadsBefore(session: Session, requestId: number): void {
  let expired = 0;
  for (const id of session.manualReads) {
    if (id >= requestId) continue;
    session.manualReads.delete(id);
    expired += 1;
  }
  session.reservations -= expired;
}

function startAuthoritativeRead(session: Session): ReadToken {
  const started = beginRead(session.state);
  session.state = started.state;
  expireManualReadsBefore(session, started.token.requestId);
  return started.token;
}

function receiveAuthoritative(
  session: Session,
  token: ReadToken,
  blocks: BlockNode[],
): void {
  session.bootstrapped = true;
  const result = transitionOutline(session.state, {
    type: "authoritative", token, blocks,
  });
  applyTransition(session, result);
}

function receiveAuthoritativeRepair(
  session: Session,
  token: ReadToken,
  blocks: BlockNode[],
): boolean {
  if (token.requestId !== session.state.latestRequestId) return false;
  session.bootstrapped = true;
  applyTransition(session, transitionOutline(session.state, {
    type: "authoritative-repair", token, blocks,
  }));
  return true;
}

function finishManualRead(
  session: Session,
  token: ReadToken,
  blocks?: BlockNode[],
): void {
  if (!session.manualReads.delete(token.requestId)) return;
  try {
    if (blocks !== undefined) receiveAuthoritative(session, token, blocks);
  } finally {
    session.reservations -= 1;
    maybeDeleteSession(session);
  }
}

function requestAuthoritative(
  session: Session,
  load?: () => Promise<BlockNode[]>,
): Promise<void> {
  if (session.authoritativeRepair) return session.authoritativeRepair;
  if (session.authoritativeRead) return session.authoritativeRead;
  const loader = load ?? [...session.loaders.values()].at(-1);
  if (!loader) return Promise.resolve();
  const token = startAuthoritativeRead(session);
  let request!: Promise<void>;
  request = loader()
    .then((blocks) => receiveAuthoritative(session, token, blocks))
    .finally(() => {
      if (session.authoritativeRead === request) {
        session.authoritativeRead = null;
        if (session.authoritativeAgain && !session.authoritativeRepair) {
          session.authoritativeAgain = false;
          void requestAuthoritative(session).catch(() => undefined);
        }
        maybeDeleteSession(session);
      }
    });
  session.authoritativeRead = request;
  return request;
}

function forceAuthoritativeRepair(session: Session): Promise<void> {
  if (session.authoritativeRepair) return session.authoritativeRepair;
  const previous = session.authoritativeRead;
  session.authoritativeAgain = false;
  // Invalidate any current automatic/manual controller before waiting for its
  // transport. The forced loader below receives a still newer real token.
  startAuthoritativeRead(session);

  let start!: () => void;
  const repair = new Promise<void>((resolve, reject) => {
    start = () => {
      void (async () => {
        if (previous) await previous.catch(() => undefined);
        for (;;) {
          const loader = [...session.loaders.values()].at(-1);
          if (!loader) {
            throw new Error(
              `No authoritative loader for active outline ${session.title}`,
            );
          }
          const token = startAuthoritativeRead(session);
          let adopted = false;
          const request = loader().then((blocks) => {
            adopted = receiveAuthoritativeRepair(session, token, blocks);
          });
          session.authoritativeRead = request;
          try {
            await request;
          } finally {
            if (session.authoritativeRead === request) {
              session.authoritativeRead = null;
            }
          }
          if (adopted) return;
          // A newer controller superseded this repair while its transport was
          // in flight. Run one more forced read and await actual integration.
        }
      })().then(resolve, reject);
    };
  });
  session.authoritativeRepair = repair;
  repair.then(() => {
    if (session.authoritativeRepair === repair) {
      session.authoritativeRepair = null;
      maybeDeleteSession(session);
    }
  }, () => {
    if (session.authoritativeRepair === repair) {
      session.authoritativeRepair = null;
      maybeDeleteSession(session);
    }
  });
  start();
  return repair;
}

function runEffects(session: Session, effects: readonly OutlineEffect[]): void {
  if (effects.some((effect) => effect.type === "request-authoritative")) {
    if (session.authoritativeRepair) return;
    if (session.authoritativeRead) {
      // Settlement requires a post-delivery read. Supersede the current token
      // immediately so its pre-delivery response can never publish while the
      // single-flight transport winds down.
      startAuthoritativeRead(session);
      session.authoritativeAgain = true;
    }
    else void requestAuthoritative(session).catch(() => undefined);
  }
}

function scopeContainsTitle(scope: readonly string[], title: string): boolean {
  return scope[0] === "page" && scope.slice(1).includes(title);
}

function trackWrite(
  session: Session,
  ticket: WriteTicket,
  ops: readonly BlockOp[] = [],
): void {
  if (!scopeContainsTitle(ticket.scope, session.title) ||
      session.trackedWrites.has(ticket.id)) return;
  session.trackedWrites.add(ticket.id);
  applyTransition(session, transitionOutline(session.state, {
    type: "write-started", ticketId: ticket.id, scope: ticket.scope, ops,
  }));
  void ticket.delivered.finally(() => {
    session.trackedWrites.delete(ticket.id);
    applyTransition(session, transitionOutline(session.state, {
      type: "write-settled", ticketId: ticket.id,
    }));
    maybeDeleteSession(session);
  });
}

function notifyLease(lease: LeaseRecord): void {
  for (const listener of lease.listeners) listener();
}

function promoteNext(session: Session): void {
  let next = session.waiters.shift() ?? null;
  while (next?.released) next = session.waiters.shift() ?? null;
  session.editor = next;
  if (next) {
    next.granted = true;
    notifyLease(next);
  }
}

function releaseLease(session: Session, lease: LeaseRecord): void {
  if (lease.released) return;
  lease.released = true;
  lease.listeners.clear();
  if (session.editor === lease) {
    lease.granted = false;
    promoteNext(session);
    return;
  }
  const index = session.waiters.indexOf(lease);
  if (index >= 0) session.waiters.splice(index, 1);
}

/** Acquire a title session from an effect. The first real bootstrap wins;
 * later mounts observe that established tree instead of replacing it. `null`
 * reserves editor ownership without supplying a page snapshot. */
export function acquireOutlineSession(
  title: string,
  bootstrap: BlockNode[] | null,
): OutlineSessionHandle {
  let session = sessions.get(title);
  if (!session) {
    const state = createOutlineState(title, bootstrap ?? []);
    session = {
      title,
      state,
      snapshot: { blocks: state.blocks, revision: state.revision },
      bootstrapped: bootstrap !== null,
      handles: 0,
      listeners: new Set(),
      editor: null,
      waiters: [],
      seenRemote: new WeakSet(),
      authoritativeRead: null,
      authoritativeRepair: null,
      authoritativeAgain: false,
      reservations: 0,
      loaders: new Map(),
      trackedWrites: new Set(),
      manualReads: new Set(),
    };
    sessions.set(title, session);
  } else if (!session.bootstrapped && bootstrap !== null) {
    session.state = createOutlineState(title, bootstrap);
    session.snapshot = { blocks: bootstrap, revision: 0 };
    session.bootstrapped = true;
  }
  session.handles += 1;
  for (const unresolved of unresolvedWrites.values()) {
    trackWrite(session, unresolved.ticket, unresolved.ops);
  }

  let released = false;
  const subscriptions = new Set<() => void>();
  const leases = new Set<LeaseRecord>();
  const loaders = new Set<symbol>();

  const handle: OutlineSessionHandle = {
    getSnapshot: () => session.snapshot,
    subscribe: (listener) => {
      if (released) return () => undefined;
      session.listeners.add(listener);
      let subscribed = true;
      const unsubscribe = () => {
        if (!subscribed) return;
        subscribed = false;
        session.listeners.delete(listener);
        subscriptions.delete(unsubscribe);
      };
      subscriptions.add(unsubscribe);
      return unsubscribe;
    },
    claimEditor: (owner) => {
      const lease: LeaseRecord = {
        owner,
        granted: false,
        released,
        listeners: new Set(),
      };
      if (!released) {
        leases.add(lease);
        if (session.editor === null) {
          session.editor = lease;
          lease.granted = true;
        } else {
          session.waiters.push(lease);
        }
      }
      return {
        get granted() { return lease.granted && !lease.released; },
        subscribe: (listener) => {
          if (lease.released) return () => undefined;
          lease.listeners.add(listener);
          let subscribed = true;
          return () => {
            if (!subscribed) return;
            subscribed = false;
            lease.listeners.delete(listener);
          };
        },
        release: () => {
          releaseLease(session, lease);
          leases.delete(lease);
        },
      };
    },
    beginAuthoritativeRead: () => {
      const token = startAuthoritativeRead(session);
      session.manualReads.add(token.requestId);
      session.reservations += 1;
      return token;
    },
    receiveAuthoritative: (token, blocks) => {
      finishManualRead(session, token, blocks);
    },
    cancelAuthoritativeRead: (token) => finishManualRead(session, token),
    setAuthoritativeLoader: (load) => {
      if (released) return () => undefined;
      const token = Symbol(`authoritative:${title}`);
      session.loaders.set(token, load);
      loaders.add(token);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        session.loaders.delete(token);
        loaders.delete(token);
      };
    },
    applyLocal: (ticket, ops) => {
      if (released) return;
      applyTransition(session, transitionOutline(session.state, {
        type: "local-ops", ticketId: ticket.id, ops,
      }));
      trackWrite(session, ticket);
    },
    applyOptimistic: (blocks) => {
      if (released) return;
      applyTransition(session, transitionOutline(session.state, {
        type: "local-tree", blocks,
      }));
    },
    applyRemote: (batch) => {
      if (released || session.seenRemote.has(batch)) {
        return { applied: false, needsAuthoritative: false };
      }
      session.seenRemote.add(batch);
      const needsAuthoritative = batch.ops.some((op) =>
        op.op === "move" && op.page_title != null &&
        op.page_title === session.title &&
        !findNode(session.snapshot.blocks, op.uid));
      applyTransition(session, transitionOutline(session.state, {
        type: "remote-ops", ops: batch.ops,
      }));
      return { applied: true, needsAuthoritative };
    },
    requestAuthoritative: (load) => requestAuthoritative(session, load),
    release: () => {
      if (released) return;
      released = true;
      for (const unsubscribe of [...subscriptions]) unsubscribe();
      for (const lease of [...leases]) releaseLease(session, lease);
      leases.clear();
      for (const token of loaders) session.loaders.delete(token);
      loaders.clear();
      session.handles -= 1;
      maybeDeleteSession(session);
    },
  };
  return handle;
}

export function isOutlineEditorActive(title: string): boolean {
  return sessions.get(title)?.editor?.granted ?? false;
}

/** Retain a page-scoped ticket centrally until delivery and route it to every
 * matching session. A matching session opened later attaches the same ticket
 * from the unresolved registry, including read-only cross-page targets. */
export function trackActiveOutlineWrite(
  ticket: WriteTicket,
  ops: readonly BlockOp[] = [],
): void {
  if (ticket.scope[0] !== "page") return;
  if (!unresolvedWrites.has(ticket.id)) {
    unresolvedWrites.set(ticket.id, { ticket, ops: [...ops] });
    void ticket.delivered.finally(() => {
      if (unresolvedWrites.get(ticket.id)?.ticket === ticket) {
        unresolvedWrites.delete(ticket.id);
      }
    });
  }
  for (const title of new Set(ticket.scope.slice(1))) {
    const session = sessions.get(title);
    if (session) trackWrite(session, ticket, ops);
  }
}

/** Capture causality for every currently active title before a multi-title
 * request dispatches. Reservations pin their session but do not supersede an
 * unrelated read unless the response actually contains that title. */
export function captureActiveOutlineReads(
  _source: AuthoritativeReadSource,
): Map<string, CapturedOutlineRead> {
  const captures = new Map<string, CapturedOutlineRead>();
  for (const [title, session] of sessions) {
    const reserved = reserveAuthoritativeRead(session.state);
    session.state = reserved.state;
    session.reservations += 1;
    let released = false;
    let received = false;
    captures.set(title, {
      receive: (blocks) => {
        if (released || received) return;
        received = true;
        const activated = activateAuthoritativeRead(
          session.state, reserved.token,
        );
        if (activated === null) return;
        session.state = activated;
        expireManualReadsBefore(session, reserved.token.requestId);
        receiveAuthoritative(session, reserved.token, blocks);
      },
      release: () => {
        if (released) return;
        released = true;
        session.reservations -= 1;
        maybeDeleteSession(session);
      },
    });
  }
  return captures;
}

export function isOutlineSessionActive(title: string): boolean {
  return sessions.has(title);
}

/** Force every active outline through a post-settlement authoritative read,
 * rebase wholly later unresolved writes, and only then release legacy delivery. */
export async function repairActiveOutlineSessions(): Promise<void> {
  // Delivery promises resolve before their settlement callbacks run. Let the
  // rejected ticket leave every session before selecting the pending ops that
  // must be rebased over the authoritative snapshot.
  await Promise.resolve();
  await Promise.all([...sessions.values()].map(forceAuthoritativeRepair));
}
