// pattern: Imperative Shell
// One outline session's parent-read election. A "parent" read is the
// full-payload `/api/page/{title}` fetch a single-page surface performs; its
// result is what `useOutlinePageLoad` renders. Several surfaces of one title
// can be mounted, so the payload a waiter gets is whichever same-title read
// the session actually accepted — not necessarily the one that waiter
// started.
//
// The machine exists for the case where nobody's read will ever arrive: the
// owner unmounted, its transport hangs, or its token was superseded. Then a
// registered controller is elected to start a fresh read, ONCE, and if that
// produces nothing the waiters are rejected rather than left pending.
//
// It owns no session state and writes none: it queries the session through
// `ParentReadHost` and is driven by the session's own notifications.
import type { BlockNode, PagePayload } from "../api/payloads";
import type { ReadToken } from "./outlineState";

/** What the election needs to know about its session. Queries only. */
export interface ParentReadHost {
  /** The session's title — it names the errors waiters see. */
  readonly title: string;
  /** The newest authoritative request id the session has issued. */
  latestRequestId(): number;
  /** A multi-title capture is activated for this request id, so a response
   * for it is already on its way and no election is needed. */
  hasActivatedCapture(requestId: number): boolean;
  /** Outstanding token-based reads: any one of them may still publish. */
  manualReadCount(): number;
  /** Whether `requestId` is one of those outstanding reads. */
  hasManualRead(requestId: number): boolean;
  /** A repair epoch owns every session's reads while it runs. */
  repairActive(): boolean;
  /** The blocks an accepted payload is published with — the session's tree,
   * never the response's, which the session may have rebased. */
  publishedBlocks(): BlockNode[];
}

export interface ParentReadiness {
  promise: Promise<PagePayload>;
  release(): void;
}

export interface ParentReadElection {
  /** Accept `payload` as the answer for `token` and hand it to every waiter
   * that started at or before that read. Resets the recovery budget: a live
   * parent read proves the surfaces are healthy. */
  publish(token: ReadToken, payload: PagePayload): void;
  /** Wait for the payload of `token`'s read or of whichever same-title read
   * supersedes it. Resolves immediately when one has already been accepted at
   * or after `token`. `owner` identifies the handle, for `releaseWaiters`. */
  awaitPayload(owner: symbol, token: ReadToken): ParentReadiness;
  /** Whether `awaitPayload` would resolve immediately — an answer for this
   * read already exists, so no waiter has to be registered for it. */
  hasAcceptedFor(token: ReadToken): boolean;
  /** Register a surface that can start a fresh full-payload parent read.
   * Returns a disposer; the newest live controller is the one elected. */
  addController(start: () => void): () => void;
  /** Drop `owner`'s waiters without settling them — the handle is going away
   * and its own readiness release is the caller's business. */
  releaseWaiters(owner: symbol): void;
  /** Re-run the election on the next microtask; idempotent within a tick. */
  schedule(): void;
  /** A token-based read is starting. Unless this machine started it, that is
   * a fresh chance for the session and re-arms the one-shot recovery. */
  noteReadBeginning(): void;
  /** A token-based read was abandoned. `current` says it was the session's
   * newest read, and only then does its error become the parent failure and
   * free the recovery slot it held. */
  noteReadAbandoned(requestId: number, error: unknown, current: boolean): void;
  /** Reads older than `requestId` have expired. A spent recovery becomes
   * reusable only when another controller takes ownership from that still-live
   * elected request. */
  expireRecoveryBefore(requestId: number): void;
}

interface ParentWaiter {
  owner: symbol;
  afterRequestId: number;
  resolve: (payload: PagePayload) => void;
  reject: (error: unknown) => void;
}

export function createParentReadElection(
  host: ParentReadHost,
): ParentReadElection {
  let accepted: { requestId: number; payload: PagePayload } | null = null;
  let failure: unknown = null;
  const waiters = new Set<ParentWaiter>();
  const controllers = new Map<symbol, () => void>();
  let scheduled = false;
  let electing = false;
  let recoveryAttempted = false;
  let recoveryRequestId: number | null = null;

  function rejectWaiters(error: unknown): void {
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  }

  function elect(): void {
    scheduled = false;
    if (waiters.size === 0 ||
        host.hasActivatedCapture(host.latestRequestId()) ||
        host.manualReadCount() > 0 ||
        host.repairActive()) return;
    const controller = [...controllers.values()].at(-1);
    if (!controller || recoveryAttempted) {
      rejectWaiters(failure ?? new Error(
        `No parent read controller for active outline ${host.title}`,
      ));
      return;
    }
    recoveryAttempted = true;
    electing = true;
    const previousRequestId = host.latestRequestId();
    try {
      controller();
      const electedRequestId = host.latestRequestId();
      if (electedRequestId > previousRequestId &&
          host.hasManualRead(electedRequestId)) {
        recoveryRequestId = electedRequestId;
      }
    } catch (error) {
      failure = error;
      rejectWaiters(error);
    } finally {
      electing = false;
    }
    if (host.manualReadCount() === 0 && waiters.size > 0) {
      rejectWaiters(failure ?? new Error(
        `Parent read controller did not start for ${host.title}`,
      ));
    }
  }

  const election: ParentReadElection = {
    schedule: () => {
      if (scheduled) return;
      scheduled = true;
      void Promise.resolve().then(elect);
    },
    publish: (token, payload) => {
      const published = {
        requestId: token.requestId,
        payload: { ...payload, blocks: host.publishedBlocks() },
      };
      accepted = published;
      failure = null;
      recoveryAttempted = false;
      recoveryRequestId = null;
      for (const waiter of [...waiters]) {
        if (waiter.afterRequestId > published.requestId) continue;
        waiters.delete(waiter);
        waiter.resolve(published.payload);
      }
    },
    hasAcceptedFor: (token) =>
      accepted !== null && accepted.requestId >= token.requestId,
    awaitPayload: (owner, token) => {
      const settled = accepted;
      if (settled && settled.requestId >= token.requestId) {
        return {
          promise: Promise.resolve(settled.payload),
          release: () => undefined,
        };
      }
      let active = true;
      let waiter!: ParentWaiter;
      const promise = new Promise<PagePayload>((resolve, reject) => {
        waiter = {
          owner,
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
        waiters.add(waiter);
      });
      election.schedule();
      return {
        promise,
        release: () => {
          if (!active) return;
          active = false;
          waiters.delete(waiter);
        },
      };
    },
    addController: (start) => {
      const token = Symbol(`parent-controller:${host.title}`);
      controllers.set(token, start);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        controllers.delete(token);
        election.schedule();
      };
    },
    releaseWaiters: (owner) => {
      for (const waiter of [...waiters]) {
        if (waiter.owner === owner) waiters.delete(waiter);
      }
    },
    noteReadBeginning: () => {
      if (electing) return;
      recoveryAttempted = false;
      recoveryRequestId = null;
      failure = null;
    },
    noteReadAbandoned: (requestId, error, current) => {
      if (!current) return;
      if (recoveryRequestId === requestId) recoveryRequestId = null;
      failure = error;
      election.schedule();
    },
    expireRecoveryBefore: (requestId) => {
      if (recoveryRequestId !== null && recoveryRequestId < requestId) {
        recoveryRequestId = null;
        recoveryAttempted = false;
      }
    },
  };
  return election;
}
