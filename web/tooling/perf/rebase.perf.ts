// pattern: Imperative Shell
// The frontend gate's R scenarios: the SQLite work one feed window costs the
// replica's applyChanges while six optimistic batches are pending. Talks to
// the perf fixture server for a snapshot and three peer windows, then drives
// the worker's handler surface over an in-memory sqlite-wasm database.
//
// The replica code and sqlite-wasm come from $PERF_WEB_ROOT, never from this
// file's own checkout, so a merge-base run measures the base's replica with
// the branch's harness. The branch's small modules (typed client, id and
// uid helpers) are imported statically; the replica never is.
import { renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import type { SyncSeq } from "../../src/api/brands";
import { setUnauthorizedHandler } from "../../src/api/client";
import { apiGet, apiPost } from "../../src/api/typedClient";
import type { Changes, Snapshot } from "../../src/replica/apply";
import type { Oo1DbLike } from "../../src/replica/db";
import { newBatchId, newClientId } from "../../src/uid";
import { installCounter, type Oo1Exec, type SqlCounts, type Sqlite3Like } from "./sqlcount";
import {
  PENDING_BATCHES, WINDOW_BATCHES, pendingBatches, pickTargets, windowBatches,
} from "./rebaseTargets";

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
const PEER = newClientId();
const WINDOWS = ["R/rebase-edit", "R/rebase-paste", "R/rebase-overlap"] as const;
const mintIds = (n: number) => Array.from({ length: n }, () => newBatchId());

const src = (rel: string): string => path.join(WEB_ROOT, "src", rel);

/** A module of the checkout under measurement, typed as this checkout's. */
async function importReplica<M>(rel: string): Promise<M> {
  // brand: untrusted -- code of the checkout under measurement, not this one
  return await import(/* @vite-ignore */ src(rel)) as M;
}

async function loadReplica(): Promise<{ handlers: HandlersModule; db: DbModule; sqlite3: Sqlite3 }> {
  const handlers = await importReplica<HandlersModule>("replica/workerHandlers.ts");
  const db = await importReplica<DbModule>("replica/db.ts");
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

/** Routes the typed client's relative fetches to the fixture server; the
 * returned function puts the real fetch back. A 401 skips the app's
 * redirect, which reads `window.location`, absent on Node. */
function pointClientAt(cookie: string): () => void {
  const real = globalThis.fetch;
  setUnauthorizedHandler(() => {});
  globalThis.fetch = (input, init) => real(`${BASE_URL}${String(input)}`, {
    ...init, headers: { ...(init?.headers as Record<string, string> | undefined), cookie },
  });
  return () => { globalThis.fetch = real; };
}

/** The snapshot, then each peer batch posted and its window fetched. */
async function fetchWorkload(): Promise<{ snapshot: Snapshot; feeds: Changes[] }> {
  const restoreFetch = pointClientAt(await login());
  try {
    const snapshot = await apiGet("/api/sync/snapshot");
    const targets = pickTargets(snapshot, PAGE);
    const feeds: Changes[] = [];
    let cursor: SyncSeq = snapshot.seq;
    for (const w of windowBatches(targets, snapshot, mintIds(WINDOW_BATCHES))) {
      const ack = await apiPost("/api/ops",
        { body: { client_id: PEER, batch_id: w.batchId, ops: w.ops } });
      // a skipped op would silently shrink the window being measured
      expect(ack.skipped ?? [], `${w.batchId} skipped ops`).toEqual([]);
      expect(ack.applied, `${w.batchId} applied`).toBe(w.ops.length);
      const feed = await apiGet("/api/sync/changes", { query: { since: cursor } });
      feeds.push(feed);
      cursor = feed.next_since;
    }
    return { snapshot, feeds };
  } finally {
    restoreFetch();
  }
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
      openDb: async () => replica.db.wrapSqlite(raw, { checkRows: false }),
      nowMs: () => FROZEN_MS,
      newBatchId: () => { throw new Error("rebase scenario: every enqueue names its batch id"); },
    });
    await h.init(undefined);
    await h.applySnapshot({ snapshot, expectedPendingIds: [] });
    for (const b of pendingBatches(pickTargets(snapshot, PAGE), snapshot, mintIds(PENDING_BATCHES))) {
      await h.enqueue({ ops: b.ops, batchId: b.batchId });
    }
    const out: SqlCounts[] = [];
    for (const [i, feed] of feeds.entries()) {
      const pending = await h.pendingBatches(undefined);
      expect(pending.filter((b) => !b.poisoned), `${WINDOWS[i]} pending batches`).toHaveLength(PENDING_BATCHES);
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
      (Object.keys(a) as (keyof SqlCounts)[]).map(
        (metric) => [metric, { class: "exact" as const, value: a[metric] }]));
  });
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(scenarios, null, 2)}\n`);
  renameSync(tmp, OUT);
});
