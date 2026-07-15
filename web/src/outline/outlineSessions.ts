// pattern: Imperative Shell
// Per-title external store for flushed outline trees and the single editable
// view lease. Registry acquisition happens from layout effects, never render.
import type { BlockNode } from "../api/payloads";
import type { WsBatch } from "../sync/socket";
import { applyOps, findNode } from "./tree";

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
  applyOptimistic(blocks: BlockNode[]): void;
  applyRemote(batch: WsBatch): {
    applied: boolean;
    needsAuthoritative: boolean;
  };
  requestAuthoritative(load: () => Promise<BlockNode[]>): Promise<void>;
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
  snapshot: SharedOutlineSnapshot;
  bootstrapped: boolean;
  handles: number;
  listeners: Set<() => void>;
  editor: LeaseRecord | null;
  waiters: LeaseRecord[];
  seenRemote: WeakSet<WsBatch>;
  authoritativeRead: Promise<void> | null;
}

const sessions = new Map<string, Session>();

function publish(session: Session, blocks: BlockNode[]): void {
  session.snapshot = {
    blocks,
    revision: session.snapshot.revision + 1,
  };
  for (const listener of session.listeners) listener();
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
    session = {
      title,
      snapshot: { blocks: bootstrap ?? [], revision: 0 },
      bootstrapped: bootstrap !== null,
      handles: 0,
      listeners: new Set(),
      editor: null,
      waiters: [],
      seenRemote: new WeakSet(),
      authoritativeRead: null,
    };
    sessions.set(title, session);
  } else if (!session.bootstrapped && bootstrap !== null) {
    session.snapshot = { blocks: bootstrap, revision: 0 };
    session.bootstrapped = true;
  }
  session.handles += 1;

  let released = false;
  const subscriptions = new Set<() => void>();
  const leases = new Set<LeaseRecord>();

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
    applyOptimistic: (blocks) => {
      if (released) return;
      publish(session, blocks);
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
      publish(session,
        applyOps(session.snapshot.blocks, batch.ops, session.title));
      return { applied: true, needsAuthoritative };
    },
    requestAuthoritative: (load) => {
      if (session.authoritativeRead) return session.authoritativeRead;
      let request!: Promise<void>;
      request = load()
        .then((blocks) => publish(session, blocks))
        .finally(() => {
          if (session.authoritativeRead === request) {
            session.authoritativeRead = null;
          }
        });
      session.authoritativeRead = request;
      return request;
    },
    release: () => {
      if (released) return;
      released = true;
      for (const unsubscribe of [...subscriptions]) unsubscribe();
      for (const lease of [...leases]) releaseLease(session, lease);
      leases.clear();
      session.handles -= 1;
      if (session.handles === 0 && sessions.get(title) === session) {
        sessions.delete(title);
      }
    },
  };
  return handle;
}

export function isOutlineEditorActive(title: string): boolean {
  return sessions.get(title)?.editor?.granted ?? false;
}
