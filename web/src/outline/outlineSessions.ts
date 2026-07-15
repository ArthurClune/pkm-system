// pattern: Imperative Shell
// Per-title external store for flushed trees, authoritative read causality,
// scoped delivery tickets, and the single editable view lease. Registry
// acquisition happens from effects, never render.
import type { BlockNode, PagePayload } from "../api/payloads";
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
  type OutlineReplayAction,
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

export interface ParentReadiness {
  promise: Promise<PagePayload>;
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

interface ParentWaiter {
  owner: symbol;
  afterRequestId: number;
  resolve: (payload: PagePayload) => void;
  reject: (error: unknown) => void;
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
  loaders: Map<symbol, () => Promise<BlockNode[]>>;
  trackedWrites: Set<string>;
  manualReads: Set<number>;
  parentPayload: { requestId: number; payload: PagePayload } | null;
  parentWaiters: Set<ParentWaiter>;
  parentControllers: Map<symbol, () => void>;
  parentElectionScheduled: boolean;
  parentElectionStarting: boolean;
  parentRecoveryAttempted: boolean;
  parentRecoveryRequestId: number | null;
  parentFailure: unknown;
}

const sessions = new Map<string, Session>();
const unresolvedWrites = new Map<string, {
  ticket: WriteTicket;
  replayByTitle: Map<string, readonly OutlineReplayAction[]>;
}>();

interface RepairEpoch {
  id: number;
  repairedState: Map<Session, OutlineState>;
  inFlight: Map<Session, Promise<void>>;
  onStable: Set<() => void>;
  completion: Promise<void>;
}

let nextRepairEpoch = 1;
let activeRepairEpoch: RepairEpoch | null = null;

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
  // A spent parent recovery becomes reusable only when another authoritative
  // controller takes ownership from that still-live elected request.
  if (session.parentRecoveryRequestId !== null &&
      session.parentRecoveryRequestId < requestId) {
    session.parentRecoveryRequestId = null;
    session.parentRecoveryAttempted = false;
  }
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
    scheduleParentElection(session);
    maybeDeleteSession(session);
  }
}

function publishParentPayload(
  session: Session,
  token: ReadToken,
  payload: PagePayload,
): void {
  const accepted = {
    requestId: token.requestId,
    payload: { ...payload, blocks: session.snapshot.blocks },
  };
  session.parentPayload = accepted;
  session.parentFailure = null;
  session.parentRecoveryAttempted = false;
  session.parentRecoveryRequestId = null;
  for (const waiter of [...session.parentWaiters]) {
    if (waiter.afterRequestId > accepted.requestId) continue;
    session.parentWaiters.delete(waiter);
    waiter.resolve(accepted.payload);
  }
}

function rejectParentWaiters(session: Session, error: unknown): void {
  for (const waiter of session.parentWaiters) waiter.reject(error);
  session.parentWaiters.clear();
}

function scheduleParentElection(session: Session): void {
  if (session.parentElectionScheduled) return;
  session.parentElectionScheduled = true;
  void Promise.resolve().then(() => {
    session.parentElectionScheduled = false;
    if (session.parentWaiters.size === 0 ||
        session.activatedCaptures.has(session.state.latestRequestId) ||
        session.manualReads.size > 0 ||
        activeRepairEpoch !== null) return;
    const controller = [...session.parentControllers.values()].at(-1);
    if (!controller || session.parentRecoveryAttempted) {
      rejectParentWaiters(
        session,
        session.parentFailure ?? new Error(
          `No parent read controller for active outline ${session.title}`,
        ),
      );
      return;
    }
    session.parentRecoveryAttempted = true;
    session.parentElectionStarting = true;
    const previousRequestId = session.state.latestRequestId;
    try {
      controller();
      const electedRequestId = session.state.latestRequestId;
      if (electedRequestId > previousRequestId &&
          session.manualReads.has(electedRequestId)) {
        session.parentRecoveryRequestId = electedRequestId;
      }
    } catch (error) {
      session.parentFailure = error;
      rejectParentWaiters(session, error);
    } finally {
      session.parentElectionStarting = false;
    }
    if (session.manualReads.size === 0 && session.parentWaiters.size > 0) {
      rejectParentWaiters(
        session,
        session.parentFailure ?? new Error(
          `Parent read controller did not start for ${session.title}`,
        ),
      );
    }
  });
}

function abandonManualRead(
  session: Session,
  token: ReadToken,
  error: unknown,
): boolean {
  const current = session.manualReads.has(token.requestId) &&
    token.requestId === session.state.latestRequestId;
  const electedRecovery = current &&
    session.parentRecoveryRequestId === token.requestId;
  finishManualRead(session, token);
  if (electedRecovery) session.parentRecoveryRequestId = null;
  if (current) {
    session.parentFailure = error;
    scheduleParentElection(session);
  }
  return current;
}

function requestAuthoritative(
  session: Session,
  load?: () => Promise<BlockNode[]>,
): Promise<void> {
  if (activeRepairEpoch) return activeRepairEpoch.completion;
  if (session.authoritativeRead) return session.authoritativeRead;
  const loader = load ?? [...session.loaders.values()].at(-1);
  if (!loader) return Promise.resolve();
  const token = startAuthoritativeRead(session);
  let request!: Promise<void>;
  request = loader()
    .then((blocks) => { receiveAuthoritative(session, token, blocks); })
    .finally(() => {
      if (session.authoritativeRead === request) {
        session.authoritativeRead = null;
        if (session.authoritativeAgain && !activeRepairEpoch) {
          session.authoritativeAgain = false;
          void requestAuthoritative(session).catch(() => undefined);
        }
        scheduleParentElection(session);
        maybeDeleteSession(session);
      }
    });
  session.authoritativeRead = request;
  scheduleParentElection(session);
  return request;
}

function repairEpochSession(
  epoch: RepairEpoch,
  session: Session,
): Promise<void> {
  const current = epoch.inFlight.get(session);
  if (current) return current;
  const previous = session.authoritativeRead;
  session.authoritativeAgain = false;
  // The epoch owns the next controller. Invalidate every older automatic or
  // manual token immediately, then wait for existing transport to wind down.
  startAuthoritativeRead(session);
  const run = (async () => {
    if (previous) await previous.catch(() => undefined);
    if (session.handles === 0) return;
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
    if (adopted) epoch.repairedState.set(session, session.state);
  })().finally(() => {
    epoch.inFlight.delete(session);
    maybeDeleteSession(session);
  });
  epoch.inFlight.set(session, run);
  return run;
}

async function runRepairEpoch(epoch: RepairEpoch): Promise<void> {
  // Rejected delivery resolves before its settlement callbacks remove replay
  // data. Begin cohort selection only after those callbacks have run.
  await Promise.resolve();
  while (activeRepairEpoch === epoch) {
    const cohort = [...sessions.values()].filter(
      (session) => session.handles > 0,
    );
    const pending = cohort.filter(
      (session) => epoch.repairedState.get(session) !== session.state,
    );
    if (pending.length > 0) {
      await Promise.all(pending.map((session) =>
        repairEpochSession(epoch, session)));
      continue;
    }

    // Let acquisitions/releases queued by the completed loaders run, then
    // rescan. The final callbacks (including queue resume) run synchronously
    // while this epoch is still active, closing the cohort/resume race.
    await Promise.resolve();
    const stable = [...sessions.values()]
      .filter((session) => session.handles > 0)
      .every((session) => epoch.repairedState.get(session) === session.state);
    if (!stable) continue;
    for (const callback of epoch.onStable) callback();
    return;
  }
}

function runEffects(session: Session, effects: readonly OutlineEffect[]): void {
  if (effects.some((effect) => effect.type === "request-authoritative")) {
    if (activeRepairEpoch) return;
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
  replay: readonly OutlineReplayAction[] = [],
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
      authoritativeAgain: false,
      reservations: 0,
      activatedCaptures: new Set(),
      loaders: new Map(),
      trackedWrites: new Set(),
      manualReads: new Set(),
      parentPayload: null,
      parentWaiters: new Set(),
      parentControllers: new Map(),
      parentElectionScheduled: false,
      parentElectionStarting: false,
      parentRecoveryAttempted: false,
      parentRecoveryRequestId: null,
      parentFailure: null,
    };
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
    trackWrite(
      session,
      unresolved.ticket,
      unresolved.replayByTitle.get(title) ?? [],
    );
  }

  let released = false;
  const subscriptions = new Set<() => void>();
  const leases = new Set<LeaseRecord>();
  const loaders = new Set<symbol>();
  const parentControllers = new Set<symbol>();
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
      if (!session.parentElectionStarting) {
        session.parentRecoveryAttempted = false;
        session.parentRecoveryRequestId = null;
        session.parentFailure = null;
      }
      const token = startAuthoritativeRead(session);
      session.manualReads.add(token.requestId);
      session.reservations += 1;
      return token;
    },
    receiveAuthoritative: (token, blocks) =>
      finishManualRead(session, token, blocks),
    receiveParentAuthoritative: (token, payload) => {
      const accepted = finishManualRead(session, token, payload.blocks);
      if (accepted) publishParentPayload(session, token, payload);
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
      const accepted = session.parentPayload;
      if (accepted && accepted.requestId >= token.requestId) {
        return {
          promise: Promise.resolve(accepted.payload),
          release: () => undefined,
        };
      }
      if (released) {
        return {
          promise: Promise.reject(
            new Error(`Outline handle released for ${title}`),
          ),
          release: () => undefined,
        };
      }
      let active = true;
      let waiter!: ParentWaiter;
      const promise = new Promise<PagePayload>((resolve, reject) => {
        waiter = {
          owner: handleId,
          afterRequestId: token.requestId,
          resolve: (payload) => {
            if (!active) return;
            active = false;
            resolve(payload);
          },
          reject: (error) => {
            if (!active) return;
            active = false;
            reject(error);
          },
        };
        session.parentWaiters.add(waiter);
      });
      scheduleParentElection(session);
      return {
        promise,
        release: () => {
          if (!active) return;
          active = false;
          session.parentWaiters.delete(waiter);
        },
      };
    },
    setParentReadController: (start) => {
      if (released) return () => undefined;
      const token = Symbol(`parent-controller:${title}`);
      session.parentControllers.set(token, start);
      parentControllers.add(token);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        session.parentControllers.delete(token);
        parentControllers.delete(token);
        scheduleParentElection(session);
      };
    },
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
      for (const token of parentControllers) {
        session.parentControllers.delete(token);
      }
      parentControllers.clear();
      for (const waiter of [...session.parentWaiters]) {
        if (waiter.owner === handleId) session.parentWaiters.delete(waiter);
      }
      session.handles -= 1;
      scheduleParentElection(session);
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
    const genericReplay = new Map<string, readonly OutlineReplayAction[]>();
    for (const title of new Set(ticket.scope.slice(1))) {
      genericReplay.set(title, [{ type: "ops", ops: [...ops] }]);
    }
    unresolvedWrites.set(ticket.id, { ticket, replayByTitle: genericReplay });
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
    if (session) {
      trackWrite(session, ticket, unresolved.replayByTitle.get(title) ?? []);
    }
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
  unresolved.replayByTitle.set(title, captured);
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
        scheduleParentElection(session);
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
  if (activeRepairEpoch) {
    if (onStable) activeRepairEpoch.onStable.add(onStable);
    return activeRepairEpoch.completion;
  }
  const epoch: RepairEpoch = {
    id: nextRepairEpoch++,
    repairedState: new Map(),
    inFlight: new Map(),
    onStable: new Set(onStable ? [onStable] : []),
    completion: Promise.resolve(),
  };
  activeRepairEpoch = epoch;
  epoch.completion = runRepairEpoch(epoch).finally(() => {
    if (activeRepairEpoch === epoch) activeRepairEpoch = null;
    for (const session of sessions.values()) {
      scheduleParentElection(session);
      maybeDeleteSession(session);
    }
  });
  return epoch.completion;
}
