// @vitest-environment node
// The recovery lease end to end: the real replicaSync driving the real
// Replica facade over a MessageChannel to the real worker handlers on an
// in-memory database, with a snapshot download that honours apiFetch's
// contract (onProgress per chunk, StalledReadError after stallMs of
// silence, an abort through init.signal). Fake timers move the client's
// Date.now and the worker's lease clock together.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { StalledReadError, type ApiFetchOptions } from "../api/client";
import type { BatchId, SyncSeq } from "../api/brands";
import type { Changes, Snapshot } from "../replica/apply";
import { createReplica, RECOVERY_LEASE_MS, type Replica } from "../replica/client";
import { serveRpc, toPortLike } from "../replica/rpc";
import { openRawTestDb, type TestDb } from "../replica/testDb";
import { buildHandlers, LEASE_EXPIRED } from "../replica/workerHandlers";
import {
  batchIdOf, canonicalTitleOf, orderIdxOf, pageIdOf, seqOf, uidOf,
} from "../test-helpers";
import {
  createReplicaSync, LEASE_RENEW_EVERY_MS, RETRY_BASE_MS, SNAPSHOT_STALL_MS,
  type ReplicaState,
} from "./replicaSync";

const realSetTimeout = setTimeout;

const snapshotOf = (generation: string, seq: SyncSeq, text: string): Snapshot => ({
  generation, plain_space_title_canonicalization: false, seq,
  pages: [{ id: pageIdOf(1), title: canonicalTitleOf("Notes"),
            created_at: 1, updated_at: 1 }],
  blocks: [{ uid: uidOf("uid_b1"), page_id: pageIdOf(1), parent_uid: null,
             order_idx: orderIdxOf(0), text, heading: null, view_type: null,
             collapsed: 0, created_at: 1, updated_at: 1, refs: [] }],
  sidebar: [],
});

const BEFORE = snapshotOf("gen-1", seqOf(5), "before");
const AFTER = snapshotOf("gen-2", seqOf(9), "after");

/** The server after a restore: its feed belongs to AFTER's generation, so a
 * replica still on BEFORE's meets needs-bootstrap. */
const FEED: Changes = {
  reset: false, generation: "gen-2", plain_space_title_canonicalization: false,
  next_since: seqOf(9), latest_seq: seqOf(9),
  pages: [], blocks: [], sidebar: [], tombstones: [],
};

const SILENT = Number.POSITIVE_INFINITY;

/** A server whose every snapshot download delivers a chunk after each gap
 * in `gaps`, then the body; a gap of SILENT stops sending for good. With
 * `honoursStall` false it never abandons a silent read itself, as a page
 * whose timers stopped running would not. */
function server(gaps: readonly number[], { honoursStall = true } = {}) {
  const downloads: { opts: ApiFetchOptions | undefined; abortedAt: number | null }[] = [];
  const fetchJson = (
    path: string, init?: RequestInit, opts?: ApiFetchOptions,
  ): Promise<unknown> => {
    if (path.startsWith("/api/sync/changes")) return Promise.resolve(FEED);
    if (!path.startsWith("/api/sync/snapshot")) {
      return Promise.reject(new Error(`unexpected request ${path}`));
    }
    const download = { opts, abortedAt: null as number | null };
    downloads.push(download);
    return new Promise<unknown>((resolve, reject) => {
      let stall: ReturnType<typeof setTimeout> | undefined;
      let next: ReturnType<typeof setTimeout> | undefined;
      const stop = () => { clearTimeout(stall); clearTimeout(next); };
      const armStall = () => {
        clearTimeout(stall);
        const stallMs = opts?.stallMs;
        if (!honoursStall || stallMs === undefined) return;
        stall = setTimeout(() => {
          stop();
          reject(new StalledReadError(stallMs));
        }, stallMs);
      };
      init?.signal?.addEventListener("abort", () => {
        download.abortedAt = Date.now();
        stop();
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
      const chunk = (i: number): void => {
        if (i === gaps.length) { stop(); resolve(AFTER); return; }
        const gap = gaps[i]!;
        if (gap === SILENT) return;
        next = setTimeout(() => {
          opts?.onProgress?.();
          armStall();
          chunk(i + 1);
        }, gap);
      };
      armStall();
      chunk(0);
    });
  };
  return { fetchJson, downloads };
}

/** Lets the worker's replies cross the channel: each RPC round trip needs
 * real event-loop turns, which fake timers do not give. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => { realSetTimeout(resolve, 0); });
  }
}

/** Advance the fake clock by `ms` a second at a time, draining between. */
async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 1000) {
    await vi.advanceTimersByTimeAsync(Math.min(1000, left));
    await drain();
  }
}

type Outcome = { state: "pending" } | { state: "resolved"; value: unknown }
  | { state: "rejected"; error: unknown };

function watch(promise: Promise<unknown>): { now: () => Outcome } {
  let outcome: Outcome = { state: "pending" };
  promise.then(
    (value) => { outcome = { state: "resolved", value }; },
    (error: unknown) => { outcome = { state: "rejected", error }; },
  );
  return { now: () => outcome };
}

const messageOf = (outcome: Outcome): string | null =>
  outcome.state === "rejected" && outcome.error instanceof Error
    ? outcome.error.message : null;

let ports: MessageChannel[] = [];

async function replicaOn(snapshot: Snapshot | null): Promise<{
  replica: Replica; t: TestDb;
}> {
  const t = await openRawTestDb();
  const ch = new MessageChannel();
  ports.push(ch);
  serveRpc(toPortLike(ch.port2), buildHandlers({ openDb: async () => t.db }));
  const replica = createReplica(toPortLike(ch.port1));
  await replica.init();
  if (snapshot !== null) await replica.applySnapshot(snapshot);
  return { replica, t };
}

const textOf = (t: TestDb): unknown =>
  t.db.select("SELECT text FROM blocks WHERE uid='uid_b1'", ["text"]);

function collector() {
  const states: ReplicaState[] = [];
  return { states, onState: (s: ReplicaState) => { states.push(s); } };
}

const bid = (s: string): BatchId => batchIdOf(s);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
  for (const ch of ports) { ch.port1.close(); ch.port2.close(); }
  ports = [];
});

const EVERY_10S_FOR_300S: readonly number[] = Array<number>(30).fill(10_000);

test("a Reset whose snapshot download outlasts the lease commits while the " +
     "download keeps making progress", async () => {
  const { replica, t } = await replicaOn(BEFORE);
  const srv = server(EVERY_10S_FOR_300S);
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson: srv.fetchJson, onState });

  const reset = watch(sync.resetLocalData({ discardPending: false }));
  await advance(300_000 + 5_000);

  expect(messageOf(reset.now())).toBeNull();
  expect(reset.now().state).toBe("resolved");
  expect(states.at(-1)).toEqual({ mode: "ready" });
  expect(textOf(t)).toEqual([{ text: "after" }]);
  expect(srv.downloads).toHaveLength(1);
});

test("a rebase whose download outlasts the lease commits once and fetches " +
     "the snapshot once", async () => {
  const { replica, t } = await replicaOn(BEFORE);
  const srv = server(EVERY_10S_FOR_300S);
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson: srv.fetchJson, onState });

  const started = watch(sync.start());
  await advance(300_000 + 5_000);
  // past the first retry a failed recovery's backoff would arm
  await advance(RETRY_BASE_MS * 4);

  expect(srv.downloads).toHaveLength(1);
  expect(started.now()).toEqual({ state: "resolved", value: true });
  expect(states.map((s) => s.mode)).not.toContain("recovery-failed");
  expect(textOf(t)).toEqual([{ text: "after" }]);
  sync.stop();
});

test("a recovery whose download goes silent fails at the stall and gives " +
     "the gate back at once", async () => {
  const { replica } = await replicaOn(BEFORE);
  const srv = server([10_000, SILENT]);
  const sync = createReplicaSync({
    replica, fetchJson: srv.fetchJson, onState: () => undefined,
  });

  const reset = watch(sync.resetLocalData({ discardPending: false }));
  await advance(25_000);
  // queued behind the gate the recovery holds, inside its own RPC timeout
  const write = watch(replica.enqueue(
    [{ op: "delete", uid: uidOf("uid_b1") }], bid("batch-during")));
  await advance(10_000 + SNAPSHOT_STALL_MS - 25_000 - 1_000);
  expect(write.now().state).toBe("pending");

  await advance(2_000);
  expect(messageOf(reset.now())).toBe(
    new StalledReadError(SNAPSHOT_STALL_MS).message);
  expect(write.now().state).toBe("resolved");
  expect(Date.now()).toBeLessThan(RECOVERY_LEASE_MS);
});

test("a recovery that loses its lease stops downloading and fails as expired",
async () => {
  const { replica } = await replicaOn(BEFORE);
  // progress, then a pause longer than the lease (the page stopped running,
  // its stall timer with it), then 100 s more of download
  const resumeAt = 20_000 + RECOVERY_LEASE_MS + 10_000;
  const srv = server(
    [10_000, 10_000, RECOVERY_LEASE_MS + 10_000,
     ...Array<number>(10).fill(10_000)],
    { honoursStall: false });
  const sync = createReplicaSync({
    replica, fetchJson: srv.fetchJson, onState: () => undefined,
  });

  const reset = watch(sync.resetLocalData({ discardPending: false }));
  await advance(resumeAt + 5_000);

  expect(srv.downloads[0]?.abortedAt).not.toBeNull();
  expect(srv.downloads[0]?.abortedAt).toBeLessThan(
    resumeAt + LEASE_RENEW_EVERY_MS);
  expect(messageOf(reset.now())).toBe(LEASE_EXPIRED);
});

test("a recovery whose flush POST hangs stops renewing, and the worker frees " +
     "the gate a lease-length after the prepare", async () => {
  const { replica } = await replicaOn(BEFORE);
  await replica.enqueue([{ op: "delete", uid: uidOf("uid_b1") }],
                        bid("batch-queued"));
  let renewals = 0;
  const counted: Replica = {
    ...replica,
    renewRecovery: (token) => {
      renewals += 1;
      return replica.renewRecovery(token);
    },
  };
  const srv = server([]);
  const sync = createReplicaSync({
    replica: counted, fetchJson: srv.fetchJson, onState: () => undefined,
    queue: {
      pause: () => undefined, resume: () => undefined,
      deliverLeased: () => new Promise<never>(() => undefined),
    },
  });

  void sync.resetLocalData({ discardPending: false }).catch(() => undefined);
  await advance(RECOVERY_LEASE_MS - 20_000);
  const write = watch(replica.enqueue(
    [{ op: "delete", uid: uidOf("uid_b2") }], bid("batch-during")));
  await advance(20_000 - 2_000);
  expect(write.now().state).toBe("pending");

  await advance(4_000);
  expect(write.now().state).toBe("resolved");
  expect(renewals).toBe(0);
  expect(srv.downloads).toHaveLength(0);
});

test("a bootstrap's snapshot fetch is stall-bounded", async () => {
  const { replica } = await replicaOn(null);
  const srv = server([10_000]);
  const sync = createReplicaSync({
    replica, fetchJson: srv.fetchJson, onState: () => undefined,
  });

  const started = watch(sync.start());
  await advance(15_000);

  expect(started.now().state).toBe("resolved");
  expect(srv.downloads[0]?.opts).toMatchObject({
    timeoutMs: null, stallMs: SNAPSHOT_STALL_MS,
  });
  expect(srv.downloads[0]?.opts?.onProgress).toBeUndefined();
  sync.stop();
});
