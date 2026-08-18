// pattern: Imperative Shell
// Per-title external store for flushed trees, authoritative read causality,
// scoped delivery tickets, and the single editable view lease. Registry
// acquisition happens from effects, never render.
//
// Two machines the sessions drive live beside this file rather than in it:
// `parentReadElection.ts` (who starts the next full-payload parent read, and
// what waiters are told when nobody can) and `repairEpochs.ts` (the global
// post-settlement repair pass). This module owns what is left: the registry,
// handle refcounts, the editor lease, loader election, write tracking, and
// read causality.
import type { BlockNode, PagePayload } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import type { WriteTicket } from "../sync/opQueue";
import type { WsBatch } from "../sync/socket";
import {
  beginAuthoritativeRead as beginRead,
  activateAuthoritativeRead,
  createOutlineState,
  reserveAuthoritativeRead,
  scopeContainsTitle,
  transitionOutline,
  type OutlineEffect,
  type OutlineReplayAction,
  type OutlineState,
  type ReadToken,
} from "./outlineState";
import {
  createParentReadElection,
  type ParentReadElection,
  type ParentReadiness,
} from "./parentReadElection";
import {
  activeRepairCompletion,
  isRepairActive,
  runRepair,
  type RepairCohort,
  type RepairTarget,
} from "./repairEpochs";
import { findNode } from "./tree";

export type { ReadToken } from "./outlineState";
export type { ParentReadiness } from "./parentReadElection";
export type AuthoritativeReadSource =
  "parent" | "resync" | "cross-page-move" | "write-settled";

/** Which surface registered a blocks-only loader:
 *  * `page` — the page-load controller (`useOutlinePageLoad`), the surface
 *    that owns this title's full-payload parent read and its missing-page
 *    policy;
 *  * `day` — the journal's per-day loader, which knows a day title is a daily
 *    by construction;
 *  * `editable` — the editable outline itself (`useOutline`), registered by
 *    every mounted `EditablePage`.
 * Several surfaces of the same title are mounted at once — a page and its
 * `EditablePage` child, a journal day and its child — so the session must
 * choose. */
export type OutlineLoaderKind = "page" | "day" | "editable";

/** Election order for reads the session starts itself (repair epochs, write
 * settlement, cross-page-move catch-up), most authoritative first. It is
 * this list and not registration order: mount and remount order is a
 * temporal accident, and a change to it must not swap fetch behaviour. Within
 * one kind the newest registration wins, so a remounted surface of the same
 * kind replaces its predecessor. */
const LOADER_PRECEDENCE: readonly OutlineLoaderKind[] =
  ["page", "day", "editable"];

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
  receiveAuthoritative(token: ReadToken, blocks: BlockNode[]): boolean;
  receiveParentAuthoritative(token: ReadToken, payload: PagePayload): boolean;
  failAuthoritativeRead(token: ReadToken, error: unknown): boolean;
  cancelAuthoritativeRead(token: ReadToken): boolean;
  registerParentReadiness(token: ReadToken): ParentReadiness;
  setParentReadController(start: () => void): () => void;
  setAuthoritativeLoader(
    kind: OutlineLoaderKind, load: () => Promise<BlockNode[]>,
  ): () => void;
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

interface RegisteredLoader {
  kind: OutlineLoaderKind;
  load: () => Promise<BlockNode[]>;
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
  authoritativeAgain: boolean;
  reservations: number;
  activatedCaptures: Set<number>;
  loaders: Map<symbol, RegisteredLoader>;
  trackedWrites: Set<string>;
  manualReads: Set<number>;
  /** Who starts this title's next full-payload parent read. */
  election: ParentReadElection;
  /** This session as a repair epoch sees it; identity is stable for the
   * session's lifetime, which is what the epoch keys its bookkeeping on. */
  repairTarget: RepairTarget;
}

const sessions = new Map<string, Session>();

interface UnresolvedWrite {
  ticket: WriteTicket;
  /** The batch's wire ops: every scoped title's replay unless the UI that did
   * the local tree surgery captured something more precise. */
  ops: readonly BlockOp[];
  capturedByTitle: Map<string, readonly OutlineReplayAction[]>;
}

const unresolvedWrites = new Map<string, UnresolvedWrite>();

/** What a repair should reapply to `title` for this still-unresolved write.
 * There is always an answer — captured optimistic metadata when the UI
 * supplied it, the batch's own wire ops otherwise — so no caller has to
 * substitute an empty replay and lose the write's rebase data. */
function replayFor(
  unresolved: UnresolvedWrite,
  title: string,
): readonly OutlineReplayAction[] {
  return unresolved.capturedByTitle.get(title) ??
    [{ type: "ops", ops: unresolved.ops }];
}

function maybeDeleteSession(session: Session): void {
  if (session.handles === 0 && session.reservations === 0 &&
      session.trackedWrites.size === 0 && session.authoritativeRead === null &&
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
  session.election.expireRecoveryBefore(requestId);
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
): boolean {
  if (token.requestId !== session.state.latestRequestId) return false;
  session.bootstrapped = true;
  const result = transitionOutline(session.state, {
    type: "authoritative", token, blocks,
  });
  applyTransition(session, result);
  return true;
}

function receiveAuthoritativeRepair(
  session: Session,
  token: ReadToken,
  blocks: BlockNode[],
): boolean {
  if (token.requestId !== session.state.latestRequestId ||
      token.revisionAtDispatch !== session.state.revision) return false;
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
): boolean {
  if (!session.manualReads.delete(token.requestId)) return false;
  try {
    return blocks !== undefined
      ? receiveAuthoritative(session, token, blocks)
      : false;
  } finally {
    session.reservations -= 1;
    session.election.schedule();
    maybeDeleteSession(session);
  }
}

function abandonManualRead(
  session: Session,
  token: ReadToken,
  error: unknown,
): boolean {
  const current = session.manualReads.has(token.requestId) &&
    token.requestId === session.state.latestRequestId;
  finishManualRead(session, token);
  session.election.noteReadAbandoned(token.requestId, error, current);
  return current;
}

/** The registered loader a session-started read uses: highest-precedence kind
 * present, newest registration within it. */
function electLoader(session: Session): (() => Promise<BlockNode[]>) | null {
  const registered = [...session.loaders.values()];
  for (const kind of LOADER_PRECEDENCE) {
    const elected = registered.filter((entry) => entry.kind === kind).at(-1);
    if (elected) return elected.load;
  }
  return null;
}

function requestAuthoritative(
  session: Session,
  load?: () => Promise<BlockNode[]>,
): Promise<void> {
  const repairing = activeRepairCompletion();
  if (repairing) return repairing;
  if (session.authoritativeRead) return session.authoritativeRead;
  const loader = load ?? electLoader(session);
  if (!loader) return Promise.resolve();
  const token = startAuthoritativeRead(session);
  let request!: Promise<void>;
  request = loader()
    .then((blocks) => { receiveAuthoritative(session, token, blocks); })
    .finally(() => {
      if (session.authoritativeRead === request) {
        session.authoritativeRead = null;
        if (session.authoritativeAgain && !isRepairActive()) {
          session.authoritativeAgain = false;
          void requestAuthoritative(session).catch(() => undefined);
        }
        session.election.schedule();
        maybeDeleteSession(session);
      }
    });
  session.authoritativeRead = request;
  session.election.schedule();
  return request;
}

/** How a repair epoch drives one session. The synchronous prelude runs before
 * the returned promise exists: the epoch owns the next controller, so every
 * older automatic or manual token is invalidated at once and only then does
 * this wait for the existing transport to wind down. */
function repairTargetFor(session: Session): RepairTarget {
  return {
    currentState: () => session.state,
    isActive: () => session.handles > 0,
    settle: () => { maybeDeleteSession(session); },
    repairRead: () => {
      const previous = session.authoritativeRead;
      session.authoritativeAgain = false;
      startAuthoritativeRead(session);
      return (async () => {
        if (previous) await previous.catch(() => undefined);
        if (session.handles === 0) return null;
        const loader = electLoader(session);
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
        return adopted ? session.state : null;
      })();
    },
  };
}

/** The registry as a repair epoch scans it. */
const repairCohort: RepairCohort = {
  targets: () => [...sessions.values()].map((session) => session.repairTarget),
  epochEnded: () => {
    for (const session of sessions.values()) {
      session.election.schedule();
      maybeDeleteSession(session);
    }
  },
};

function runEffects(session: Session, effects: readonly OutlineEffect[]): void {
  if (effects.some((effect) => effect.type === "request-authoritative")) {
    if (isRepairActive()) return;
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

/** Retain a scoped ticket on one session until delivery. `replay` is what a
 * repair would reapply to this title, and has no default: every caller knows
 * it, and an empty stand-in would be indistinguishable from a write that
 * genuinely has nothing to rebase. */
function trackWrite(
  session: Session,
  ticket: WriteTicket,
  replay: readonly OutlineReplayAction[],
): void {
  if (!scopeContainsTitle(ticket.scope, session.title) ||
      session.trackedWrites.has(ticket.id)) return;
  session.trackedWrites.add(ticket.id);
  applyTransition(session, transitionOutline(session.state, {
    type: "write-started", ticketId: ticket.id, scope: ticket.scope, replay,
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

function canBootstrapExistingSession(session: Session): boolean {
  return session.state.revision === 0 &&
    session.state.relevantWrites.size === 0 &&
    session.state.deferredAuthoritative === null &&
    session.manualReads.size === 0 &&
    session.reservations === 0 &&
    session.trackedWrites.size === 0 &&
    session.authoritativeRead === null &&
    !session.authoritativeAgain;
}

/** Both attached machines query the session they belong to, so the session
 * exists before they do; nothing reads either field before this returns. */
type SessionCore = Omit<Session, "election" | "repairTarget">;

function createSession(
  title: string,
  bootstrap: BlockNode[] | null,
): Session {
  const state = createOutlineState(title, bootstrap ?? []);
  const core: SessionCore = {
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
    authoritativeAgain: false,
    reservations: 0,
    activatedCaptures: new Set(),
    loaders: new Map(),
    trackedWrites: new Set(),
    manualReads: new Set(),
  };
  const session = core as Session;
  session.election = createParentReadElection({
    title,
    latestRequestId: () => session.state.latestRequestId,
    hasActivatedCapture: (requestId) =>
      session.activatedCaptures.has(requestId),
    manualReadCount: () => session.manualReads.size,
    hasManualRead: (requestId) => session.manualReads.has(requestId),
    repairActive: isRepairActive,
    publishedBlocks: () => session.snapshot.blocks,
  });
  session.repairTarget = repairTargetFor(session);
  return session;
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
    session = createSession(title, bootstrap);
    sessions.set(title, session);
  } else if (!session.bootstrapped && bootstrap !== null &&
             canBootstrapExistingSession(session)) {
    session.state = { ...session.state, blocks: bootstrap };
    session.snapshot = {
      blocks: session.state.blocks,
      revision: session.state.revision,
    };
    session.bootstrapped = true;
  }
  session.handles += 1;
  for (const unresolved of unresolvedWrites.values()) {
    trackWrite(session, unresolved.ticket, replayFor(unresolved, title));
  }

  let released = false;
  const subscriptions = new Set<() => void>();
  const leases = new Set<LeaseRecord>();
  const loaders = new Set<symbol>();
  const parentControllers = new Set<() => void>();
  const handleId = Symbol(`outline-handle:${title}`);

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
      session.election.noteReadBeginning();
      const token = startAuthoritativeRead(session);
      session.manualReads.add(token.requestId);
      session.reservations += 1;
      return token;
    },
    receiveAuthoritative: (token, blocks) =>
      finishManualRead(session, token, blocks),
    receiveParentAuthoritative: (token, payload) => {
      const accepted = finishManualRead(session, token, payload.blocks);
      if (accepted) session.election.publish(token, payload);
      return accepted;
    },
    failAuthoritativeRead: (token, error) =>
      abandonManualRead(session, token, error),
    cancelAuthoritativeRead: (token) => abandonManualRead(
      session,
      token,
      new Error(`Parent read cancelled for ${session.title}`),
    ),
    registerParentReadiness: (token) => {
      // An answer this read can already have is served whatever the handle's
      // state; only a waiter needs the handle to still be live.
      if (released && !session.election.hasAcceptedFor(token)) {
        return {
          promise: Promise.reject(
            new Error(`Outline handle released for ${title}`),
          ),
          release: () => undefined,
        };
      }
      return session.election.awaitPayload(handleId, token);
    },
    setParentReadController: (start) => {
      if (released) return () => undefined;
      const remove = session.election.addController(start);
      parentControllers.add(remove);
      return () => {
        parentControllers.delete(remove);
        remove();
      };
    },
    setAuthoritativeLoader: (kind, load) => {
      if (released) return () => undefined;
      const token = Symbol(`authoritative:${kind}:${title}`);
      session.loaders.set(token, { kind, load });
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
        type: "local-ops", ticketId: ticket.id, ops, nowMs: Date.now(),
      }));
      // Same replay the local-ops transition just recorded, so tracking a
      // ticket the delivery registry has not pre-tracked still leaves this
      // session able to rebase the edit onto a repaired server tree.
      trackWrite(session, ticket, [{ type: "ops", ops: [...ops] }]);
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
        type: "remote-ops", ops: batch.ops, nowMs: Date.now(),
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
      for (const remove of [...parentControllers]) remove();
      parentControllers.clear();
      session.election.releaseWaiters(handleId);
      session.handles -= 1;
      session.election.schedule();
      maybeDeleteSession(session);
    },
  };
  return handle;
}

/** A refcounted handle to an EXISTING session, or null. Unlike acquire this
 * never creates one — the undo manager uses it to apply history batches
 * instantly to mounted outlines without leaving behind an un-bootstrapped
 * session for pages that aren't rendered. Callers must release(). */
export function peekOutlineSession(title: string): OutlineSessionHandle | null {
  if (!sessions.has(title)) return null;
  return acquireOutlineSession(title, null);
}

export function isOutlineEditorActive(title: string): boolean {
  return sessions.get(title)?.editor?.granted ?? false;
}

/** Retain a page-scoped ticket centrally until delivery and route it to every
 * matching session. A matching session opened later attaches the same ticket
 * from the unresolved registry, including read-only cross-page targets. */
export function trackActiveOutlineWrite(
  ticket: WriteTicket,
  ops: readonly BlockOp[],
): void {
  if (ticket.scope[0] !== "page") return;
  if (!unresolvedWrites.has(ticket.id)) {
    unresolvedWrites.set(ticket.id, {
      ticket, ops: [...ops], capturedByTitle: new Map(),
    });
    void ticket.delivered.finally(() => {
      if (unresolvedWrites.get(ticket.id)?.ticket === ticket) {
        unresolvedWrites.delete(ticket.id);
      }
    });
  }
  const unresolved = unresolvedWrites.get(ticket.id);
  if (!unresolved || unresolved.ticket !== ticket) return;
  for (const title of new Set(ticket.scope.slice(1))) {
    const session = sessions.get(title);
    if (session) trackWrite(session, ticket, replayFor(unresolved, title));
  }
}

/** Replace one title's generic wire-op replay with deterministic optimistic
 * metadata captured by the UI that performed the local tree surgery. */
export function attachActiveOutlineWriteReplay(
  ticket: WriteTicket,
  title: string,
  replay: readonly OutlineReplayAction[],
): void {
  const unresolved = unresolvedWrites.get(ticket.id);
  if (!unresolved || unresolved.ticket !== ticket ||
      !scopeContainsTitle(ticket.scope, title)) return;
  const captured = [...replay];
  unresolved.capturedByTitle.set(title, captured);
  const session = sessions.get(title);
  if (session?.trackedWrites.has(ticket.id)) {
    applyTransition(session, transitionOutline(session.state, {
      type: "write-replay", ticketId: ticket.id, replay: captured,
    }));
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
    let captureActivated = false;
    captures.set(title, {
      receive: (blocks) => {
        if (released || received) return;
        received = true;
        const activatedState = activateAuthoritativeRead(
          session.state, reserved.token,
        );
        if (activatedState === null) return;
        session.state = activatedState;
        captureActivated = true;
        session.activatedCaptures.add(reserved.token.requestId);
        expireManualReadsBefore(session, reserved.token.requestId);
        receiveAuthoritative(session, reserved.token, blocks);
      },
      release: () => {
        if (released) return;
        released = true;
        if (captureActivated) {
          session.activatedCaptures.delete(reserved.token.requestId);
        }
        session.reservations -= 1;
        session.election.schedule();
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
export function repairActiveOutlineSessions(
  onStable?: () => void,
): Promise<void> {
  return runRepair(repairCohort, onStable);
}
