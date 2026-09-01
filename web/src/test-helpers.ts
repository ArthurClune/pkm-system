import { expect, vi } from "vitest";
import { acquireOutlineSession } from "./outline/outlineSessions";
import type { BlockOp } from "./api/ops";
import type { Backlinks, BlockNode, PagePayload } from "./api/payloads";
import type { WsBatch } from "./sync/socket";
import type { Sync, SyncStatus } from "./sync/SyncProvider";
import type { WriteTicket } from "./sync/opQueue";

/** Hold the outline editor for `title` so a test's own mount cannot win the
 * lease, and return the release. Sessions are global to the module, so the
 * handle is released before throwing on an ungranted lease (pkm-l457):
 * leaking it would cascade into every later test in the process. */
export function reserveOutlineEditor(title: string): () => void {
  const handle = acquireOutlineSession(title, null);
  const lease = handle.claimEditor(Symbol(`test-reservation:${title}`));
  if (!lease.granted) {
    handle.release();
    throw new Error(`Could not reserve editor for ${title}`);
  }
  return () => {
    lease.release();
    handle.release();
  };
}

/** What `apiFetch` hands `fetch` for a read: the verb, plus the abort signal
 * carrying the READ_TIMEOUT_MS deadline (pkm-d6i6). Assert with this rather
 * than a bare `{ method: "GET" }`, which no longer matches. */
export const READ_INIT = { method: "GET", signal: expect.any(AbortSignal) };

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A promise plus its settlers, for tests that need to control exactly when
 * an in-flight request resolves relative to other events (rerenders, other
 * requests) — used to reproduce out-of-order async resolution. */
export function defer<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Stub global fetch; handlers are [urlPrefix, body] pairs, FIRST match
 * wins — list more-specific prefixes first. Unmatched urls 404. */
export function stubFetch(handlers: [string, unknown][]) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [prefix, body] of handlers) {
      if (url.startsWith(prefix)) return jsonResponse(body);
    }
    return jsonResponse({ detail: "not found" }, 404);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

export function block(uid: string, text: string,
                      over: Partial<BlockNode> = {}): BlockNode {
  return { uid, text, heading: null, view_type: null, collapsed: false, order_idx: 0,
           created_at: 1000, updated_at: 2000, children: [], ...over };
}

/** A backlinks page, empty by default: what /api/page carries for a page
 * nothing links to, `limit` matching that route's default page size.
 * `total_pages` follows the groups given, so a caller only states it to model a
 * page with more still to fetch. */
export function backlinks(groups: Backlinks["groups"] = [],
                          over: Partial<Backlinks> = {}): Backlinks {
  return { groups, total_pages: groups.length, offset: 0, limit: 20, ...over };
}

/** The same shape as /api/journal carries per day: a preview page of
 * JOURNAL_BACKLINK_PREVIEW. The size matters — BacklinksSection reads
 * `initial.limit` to ask for the next batch, so a day fixture built with the
 * page route's 20 would page the journal wrongly and no test would notice. */
export function journalBacklinks(groups: Backlinks["groups"] = [],
                                 over: Partial<Backlinks> = {}): Backlinks {
  return backlinks(groups, { limit: 5, ...over });
}

export function pagePayload(title: string, blocks: BlockNode[],
                            over: Partial<PagePayload> = {}): PagePayload {
  return {
    page: { id: 1, title, created_at: 1000, updated_at: 2000 },
    blocks,
    backlinks: backlinks(),
    block_ref_texts: {},
    block_ref_counts: {},
    ...over,
  };
}

/** WebSocket stub installed globally in test-setup: quiet by default (never
 * opens); tests drive instances via FakeWebSocket.instances. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: string[] = [];
  closedByApp = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) { this.sent.push(data); }

  close() { this.closedByApp = true; this.onclose?.(); }

  // --- test drivers ---
  open() { this.onopen?.(); }
  message(body: unknown) { this.onmessage?.({ data: JSON.stringify(body) }); }
  drop() { this.onclose?.(); }
}

/** Controllable stand-in for a MediaQueryList; jsdom has no real
 * matchMedia. Installed globally (quiet, "light") in test-setup; tests that
 * care about the OS theme call stubMatchMedia() again for a fresh, drivable
 * instance. */
export class FakeMediaQueryList {
  matches: boolean;
  media = "(prefers-color-scheme: dark)";
  private listeners = new Set<(e: { matches: boolean }) => void>();

  constructor(matches: boolean) { this.matches = matches; }

  addEventListener(_type: string, listener: (e: { matches: boolean }) => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: (e: { matches: boolean }) => void) {
    this.listeners.delete(listener);
  }

  // --- test driver ---
  simulateChange(matches: boolean) {
    this.matches = matches;
    this.listeners.forEach((fn) => fn({ matches }));
  }
}

export function stubMatchMedia(initialMatches = false): FakeMediaQueryList {
  const mql = new FakeMediaQueryList(initialMatches);
  vi.stubGlobal("matchMedia", vi.fn(() => mql));
  return mql;
}

/** In-memory Storage stand-in. Node 26's own (experimental, flag-gated)
 * global `localStorage` shadows jsdom's real implementation in this repo's
 * test environment, making the bare global undefined -- see test-setup.ts. */
export class FakeLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}

export interface SyncFake extends Sync {
  sent: BlockOp[][];
  tickets: WriteTicket[];
  emit(batch: WsBatch): void;
}

export function makeSync(status: SyncStatus = "connected",
                         over: Partial<Sync> = {}): SyncFake {
  const subs = new Set<(b: WsBatch) => void>();
  const sent: BlockOp[][] = [];
  const tickets: WriteTicket[] = [];
  let nextTicket = 1;
  return {
    status,
    resyncSeq: 0,
    replicaMode: "ready",
    canEdit: status === "connected",
    pending: 0,
    unsentInMemory: 0,
    retryProblem: () => Promise.resolve(),
    dismissProblem: () => undefined,
    discardProblem: () => Promise.resolve(),
    resetReplica: () => Promise.resolve(),
    enqueue: (ops, scope): WriteTicket => {
      sent.push(ops);
      const write = {
        id: `fake-write-${nextTicket++}`,
        scope: scope ?? [],
        settled: Promise.resolve({ status: "persisted", pending: 0 }),
        delivered: Promise.resolve({ status: "delivered" }),
      } satisfies WriteTicket;
      tickets.push(write);
      return write;
    },
    attachOutlineReplay: () => undefined,
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
    settled: () => Promise.resolve(),
    sent,
    tickets,
    emit: (batch) => subs.forEach((fn) => fn(batch)),
    ...over,
  };
}
