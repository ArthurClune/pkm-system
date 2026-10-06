// pattern: Imperative Shell
// The frontend gate's R scenarios: the SQLite work one feed window costs the
// replica's applyChanges while six optimistic batches are pending. Talks to
// the perf fixture server for a snapshot and three peer windows, then drives
// the worker's handler surface over an in-memory sqlite-wasm database.
//
// The replica code and sqlite-wasm come from $PERF_WEB_ROOT, never from this
// file's own checkout, so a merge-base run measures the base's replica with
// the branch's harness. Only types are imported from the branch statically.
import { renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import type { ClientId, SyncSeq } from "../../src/api/brands";
import type { OpsAck } from "../../src/api/payloads";
import type { Changes, Snapshot } from "../../src/replica/apply";
import type { Oo1DbLike } from "../../src/replica/db";
import { installCounter, type Oo1Exec, type SqlCounts, type Sqlite3Like } from "./sqlcount";
import { pendingBatches, pickTargets, windowBatches } from "./rebaseTargets";

type HandlersModule = typeof import("../../src/replica/workerHandlers");
type DbModule = typeof import("../../src/replica/db");
type RawDb = Oo1DbLike & Oo1Exec & { pointer: number; close(): void };
type Sqlite3 = Sqlite3Like & { oo1: { DB: new (filename: string) => RawDb } };

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`rebase scenario: ${name} is not set`);
  return value;
};

const WEB_ROOT = path.resolve(env("PERF_WEB_ROOT"));
const BASE_URL = env("PERF_BASE_URL");
const OUT = env("PERF_REBASE_OUT");
const FROZEN_MS = Date.parse(process.env.PERF_FROZEN_NOW ?? "2026-06-15T12:00:00+01:00");
const PAGE = "Perf Big Page";
const PEER = "perf-rebase-peer" as ClientId;
const WINDOWS = ["R/rebase-edit", "R/rebase-paste", "R/rebase-overlap"] as const;
const PENDING = 6;

async function loadReplica(): Promise<{ handlers: HandlersModule; db: DbModule; sqlite3: Sqlite3 }> {
  const src = (rel: string): string => path.join(WEB_ROOT, "src", rel);
  const handlers = await import(/* @vite-ignore */ src("replica/workerHandlers.ts")) as HandlersModule;
  const db = await import(/* @vite-ignore */ src("replica/db.ts")) as DbModule;
  const wasm = createRequire(path.join(WEB_ROOT, "package.json")).resolve("@sqlite.org/sqlite-wasm");
  const mod = await import(/* @vite-ignore */ pathToFileURL(wasm).href) as
    { default: () => Promise<unknown> };
  // The engine's bootstrap probes `localStorage` for its kvvfs backend; on
  // Node that getter prints a warning. Hide it for the probe only.
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true, writable: true });
  try {
    return { handlers, db, sqlite3: await mod.default() as Sqlite3 };
  } finally {
    if (saved) Object.defineProperty(globalThis, "localStorage", saved);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "e2e-pw" }),
  });
  if (!res.ok) throw new Error(`rebase scenario: login failed: ${res.status}`);
  const cookie = (res.headers.getSetCookie()[0] ?? "").split(";")[0];
  if (!cookie) throw new Error("rebase scenario: login set no cookie");
  return cookie;
}

async function call<T>(cookie: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${route}`, body === undefined
    ? { headers: { cookie } }
    : { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`rebase scenario: ${route} failed: ${res.status} ${await res.text()}`);
  return await res.json() as T;
}

/** The snapshot, then each peer batch posted and its window fetched. */
async function fetchWorkload(): Promise<{ snapshot: Snapshot; feeds: Changes[] }> {
  const cookie = await login();
  const snapshot = await call<Snapshot>(cookie, "/api/sync/snapshot");
  const targets = pickTargets(snapshot, PAGE);
  const feeds: Changes[] = [];
  let cursor: SyncSeq = snapshot.seq;
  for (const w of windowBatches(targets, snapshot)) {
    const ack = await call<OpsAck>(cookie, "/api/ops", { client_id: PEER, batch_id: w.batchId, ops: w.ops });
    // a skipped op would silently shrink the window being measured
    expect(ack.skipped ?? [], `${w.batchId} skipped ops`).toEqual([]);
    expect(ack.applied, `${w.batchId} applied`).toBe(w.ops.length);
    const feed = await call<Changes>(cookie, `/api/sync/changes?since=${cursor}`);
    feeds.push(feed);
    cursor = feed.next_since;
  }
  return { snapshot, feeds };
}

/** One fresh replica: snapshot, the pending queue, then each window
 * counted inside applyChanges alone. */
async function measurePass(
  replica: Awaited<ReturnType<typeof loadReplica>>, snapshot: Snapshot, feeds: Changes[],
): Promise<SqlCounts[]> {
  const raw = new replica.sqlite3.oo1.DB(":memory:");
  try {
    // the worker's pragmas (worker.ts)
    raw.exec("PRAGMA foreign_keys=ON");
    raw.exec("PRAGMA recursive_triggers=ON");
    const counter = installCounter(replica.sqlite3, raw);
    const h = replica.handlers.buildHandlers({
      openDb: async () => replica.db.wrapSqlite(raw),
      nowMs: () => FROZEN_MS,
      newBatchId: () => { throw new Error("rebase scenario: every enqueue names its batch id"); },
    });
    await h.init(undefined);
    await h.applySnapshot(snapshot);
    for (const b of pendingBatches(pickTargets(snapshot, PAGE), snapshot)) {
      await h.enqueue({ ops: b.ops, batchId: b.batchId });
    }
    const out: SqlCounts[] = [];
    for (const [i, feed] of feeds.entries()) {
      const pending = await h.pendingBatches(undefined);
      expect(pending.filter((b) => !b.poisoned), `${WINDOWS[i]} pending batches`).toHaveLength(PENDING);
      const { result, counts } = await counter.measure(() =>
        h.applyChanges({ feed, expectedPendingIds: pending.map((b) => b.id) }));
      expect(result.status, `${WINDOWS[i]} apply status`).toBe("applied");
      expect(counts.statements, `${WINDOWS[i]} statements`).toBeGreaterThan(0);
      out.push(counts);
    }
    counter.uninstall();
    return out;
  } finally {
    raw.close();
  }
}

test("rebase: feed windows applied over a pending queue", async () => {
  const replica = await loadReplica();
  const { snapshot, feeds } = await fetchWorkload();
  const first = await measurePass(replica, snapshot, feeds);
  const second = await measurePass(replica, snapshot, feeds);
  const scenarios: Record<string, Record<string, { class: "exact"; value: number }>> = {};
  WINDOWS.forEach((name, i) => {
    const a = first[i] as SqlCounts;
    const b = second[i] as SqlCounts;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error(`rebase scenario: ${name} is unstable: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
    scenarios[name] = Object.fromEntries(
      Object.entries(a).map(([metric, value]) => [metric, { class: "exact" as const, value }]));
  });
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(scenarios, null, 2)}\n`);
  renameSync(tmp, OUT);
});
