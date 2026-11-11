import { expect, vi } from "vitest";
import { acquireOutlineSession } from "./outline/outlineSessions";
import { applyOps, findNode } from "./outline/tree";
import type { Outline } from "./outline/useOutline";
import type { BlockOp } from "./api/ops";
import type { Backlinks, BlockNode, PagePayload } from "./api/payloads";
import type { BatchId, BlockUid, CanonicalTitle, NormalizedTitle } from "./api/brands";
import type { WsBatch } from "./sync/socket";
import type { Sync, SyncStatus } from "./sync/SyncProvider";
import type { WriteTicket } from "./sync/opQueue";
import { batchIdOf, normalizedTitleOf, orderIdxOf, pageIdOf, ticketIdOf, uidOf } from "./test-mint";

export * from "./test-mint";

/** The `confirm` a useOutline harness passes when no prompt is under test. */
export const confirmYes = (): Promise<boolean> => Promise.resolve(true);

/** A block of compile-time checks. The callback is never called: tsc still
 * type-checks its body (`pnpm typecheck` covers tests), so a
 * `@ts-expect-error` inside it fails the build once the line stops
 * erroring, but nothing in it ever runs. It is the only place the lint
 * allows a `@ts-expect-error`. */
export function typeProbe(probe: () => void): void {
  void probe;
}

/** Hold the outline editor for `title` so a test's own mount cannot win the
 * lease, and return the release. Sessions are global to the module, so the
 * handle is released before throwing on an ungranted lease:
 * leaking it would cascade into every later test in the process. */
export function reserveOutlineEditor(title: CanonicalTitle): () => void {
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
 * carrying the READ_TIMEOUT_MS deadline. Assert with this rather
 * than a bare `{ method: "GET" }`, which no longer matches. */
export const READ_INIT: { method: string; signal: unknown } =
  { method: "GET", signal: expect.any(AbortSignal) };

/** A parsed JSON object as a record of unknowns; throws on anything else. */
export function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected a JSON object, got ${JSON.stringify(value)}`);
  }
  return { ...value };
}

/** The batch id a POST /api/ops body carries, as the checked brand. */
export function bodyBatchId(body: unknown): BatchId {
  const id = jsonRecord(body).batch_id;
  if (typeof id !== "string") throw new Error(`batch_id is not a string: ${String(id)}`);
  return batchIdOf(id);
}

/** The JSON body a mocked `fetch` was called with, as a record. */
export function sentBody(init: RequestInit | undefined): Record<string, unknown> {
  return jsonRecord(JSON.parse(String(init?.body)));
}

/** The ops of the POST /api/ops a mocked `fetch` was called with, each as a
 * record. */
export function sentOps(init: RequestInit | undefined): Record<string, unknown>[] {
  const ops = sentBody(init).ops;
  if (!Array.isArray(ops)) throw new Error("the request body has no ops array");
  return ops.map((op: unknown) => jsonRecord(op));
}

/** The batch id of the POST /api/ops a mocked `fetch` was called with. */
export function sentBatchId(init: RequestInit | undefined): BatchId {
  return bodyBatchId(sentBody(init));
}

/** `expect.any(String)`, typed so it can sit in an expected object. */
export const ANY_STRING: unknown = expect.any(String);

/** `expect.objectContaining`, typed so it can sit in an expected object. */
export function objectContaining(shape: Record<string, unknown>): unknown {
  return expect.objectContaining(shape);
}

/** `expect.stringContaining`, typed so it can sit in an expected object. */
export function stringContaining(part: string): unknown {
  return expect.stringContaining(part);
}

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

/** Serve one page the way the server would after this tab's writes: every
 * read of /api/page/<title> is `blocks` with all of `sync.sent` applied, so a
 * re-read after a write settles does not undo it. */
export function servePageApplyingSent(sync: SyncFake, pageTitle: CanonicalTitle,
                                      blocks: BlockNode[]) {
  const path = `/api/page/${encodeURIComponent(pageTitle)}`;
  const mock = vi.fn(async (input: RequestInfo | URL) => (
    String(input).startsWith(path)
      ? jsonResponse(pagePayload(pageTitle,
                                 applyOps(blocks, sync.sent.flat(), pageTitle)))
      : jsonResponse({ detail: "not found" }, 404)));
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Type `text` into `uid` as BlockInput does: a block with no pending
 * draft first reports the text it showed, the tree's. */
export function typeInto(outline: Pick<Outline, "handlers" | "blocks">,
                         uid: BlockUid, text: string, holdFlush?: boolean): void {
  if (outline.handlers.pendingDraft(uid) === null) {
    const node = findNode(outline.blocks, uid);
    if (!node) throw new Error(`typeInto: no textarea can show ${uid}`);
    outline.handlers.onDraftStart(uid, node.text);
  }
  outline.handlers.onDraftChange(uid, text, holdFlush);
}

export function block(rawUid: string, text: string,
                      over: Partial<BlockNode> = {}): BlockNode {
  return { uid: uidOf(rawUid), text, heading: null, view_type: null,
           collapsed: false, order_idx: orderIdxOf(0), created_at: 1000,
           updated_at: 2000, children: [], ...over };
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

export function pagePayload(pageTitle: CanonicalTitle, blocks: BlockNode[],
                            over: Partial<PagePayload> = {}): PagePayload {
  return {
    page: { id: pageIdOf(1), title: pageTitle,
            created_at: 1000, updated_at: 2000 },
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
  // Mirrors the real WebSocket readyState constants so production code that
  // branches on `ws.readyState === WebSocket.OPEN` (the frozen-socket resume
  // heuristic) sees the same values under the stubbed global.
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  sent: string[] = [];
  closedByApp = false;
  readyState: number = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) { this.sent.push(data); }

  /** App-initiated close. `closedByApp` flips synchronously -- that much
   * mirrors calling the real method -- but the resulting close event does
   * not: a real WebSocket's close is an async task, so `onclose` here is
   * deferred (setTimeout(0), driven by fake timers) rather than fired
   * inline. This matters for the frozen-socket resume heuristic: production
   * code calls `ws.close()` and then falls through to `reconnectNow()` in the
   * same synchronous handler, trusting that the close event -- and the
   * scheduleReconnect() it triggers -- hasn't happened yet. A synchronous
   * onclose here would let that same-tick reconnectNow() see a freshly
   * scheduled reconnect timer and hurry it, bypassing the backoff inside
   * the test double in a way that cannot happen against a real socket. */
  close() {
    this.closedByApp = true;
    this.readyState = FakeWebSocket.CLOSING;
    setTimeout(() => { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }, 0);
  }

  // --- test drivers ---
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  message(body: unknown) { this.onmessage?.({ data: JSON.stringify(body) }); }
  drop() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
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

/** A ticket already delivered, for history entries whose own write is not
 * under test. */
export function deliveredTicket(scope: readonly string[] = []): WriteTicket {
  return {
    id: ticketIdOf(`delivered-${Math.random()}`), scope,
    settled: Promise.resolve({ status: "persisted", pending: 0 }),
    delivered: Promise.resolve({ status: "delivered" }),
  };
}

export function makeSync(status: SyncStatus = "connected",
                         over: Partial<Sync> = {}): SyncFake {
  const subs = new Set<(b: WsBatch) => void>();
  const sent: BlockOp[][] = [];
  const tickets: WriteTicket[] = [];
  let nextTicket = 1;
  return {
    status,
    resyncGeneration: 0,
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
        id: ticketIdOf(`fake-write-${nextTicket++}`),
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

/** Stub the bits of `navigator` the predicate reads, for the duration of one
 * test. jsdom's own `navigator` properties are configurable, so
 * `Object.defineProperty` can override them cleanly and this restores the
 * originals afterwards. */
export function stubIosStandaloneNavigator(over: {
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
} = {}) {
  const props: Record<string, PropertyDescriptor> = {};
  const values: Record<string, unknown> = {
    platform: over.platform ?? "iPhone",
    maxTouchPoints: over.maxTouchPoints ?? 5,
    standalone: over.standalone ?? true,
  };
  for (const [key, value] of Object.entries(values)) {
    props[key] = Object.getOwnPropertyDescriptor(window.navigator, key) ?? {
      configurable: true, enumerable: true, writable: true, value: undefined,
    };
    Object.defineProperty(window.navigator, key, {
      configurable: true, enumerable: true, value,
    });
  }
  return () => {
    for (const [key, descriptor] of Object.entries(props)) {
      Object.defineProperty(window.navigator, key, descriptor);
    }
  };
}

/** A string member of a parsed JSON fixture row: a missing or non-string
 * member throws rather than reading as "undefined". */
export function fixtureText(row: unknown, key: string): string {
  const value = (row as Record<string, unknown> | null)?.[key];
  if (typeof value !== "string") {
    throw new Error(`fixture row has no string "${key}"`);
  }
  return value;
}

/** The `refs` rows of a parsed ref-grammar fixture, each title minted as
 * the NormalizedTitle the extractors return. */
export function fixtureRefs(rows: readonly unknown[]):
  { title: NormalizedTitle; kind: string }[] {
  return rows.map((r) => ({
    title: normalizedTitleOf(fixtureText(r, "title")),
    kind: fixtureText(r, "kind"),
  }));
}

/** jsdom has no DataTransfer: a stub a block drag can write into. `types`
 * lists what was set, as a browser lists it during dragover. */
export function dragTransfer() {
  const data: Record<string, string> = {};
  return {
    setData: (k: string, v: string) => { data[k] = v; },
    getData: (k: string) => data[k] ?? "",
    get types() { return Object.keys(data); },
    items: [], files: [],
    effectAllowed: "", dropEffect: "",
  };
}
