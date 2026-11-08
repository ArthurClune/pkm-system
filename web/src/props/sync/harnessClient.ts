// pattern: Imperative Shell
// One simulated device: the real replica worker handlers over a
// MessageChannel, the real op queue, replicaSync, clientRuntime, legacy
// repair and reconnect flow, wired as SyncProvider and useSocketLifecycle wire
// them, over an in-memory sqlite database that survives reloads.
//
// The legacy repair's outline sessions are the one part stood in for: the
// harness mounts no editor, so its repairSessions is one authoritative read
// through this client's transport, of pt_seed_6's block: live for the whole
// example, so the read succeeds online whatever a Rename has done to page
// titles. It fails while the client is offline, as the real repair's does,
// so a lane rejection whose repair is cut off by the network is left for
// the next connect to retry.
//
// A "life" is one page load. reload() ends it the way a browser ends one by
// killing the worker and the page's fetches: the transport discards replies
// to the old life's requests and refuses its new ones, the old worker
// handlers finish what they had already received and then lose the
// database, and the old ports close, so nothing from an old promise chain
// can write into the database the new life opens.
//
// A worker can die mid-life (killWorker): its RPC client turns terminal, as
// when a real worker throws, so every later call rejects with worker-error,
// while the requests it had already received finish as a crash just after
// them would leave the file. Only a reload brings a new worker.
//
// A page load's first connect comes, by default, once the startup has
// finished. In the app it need not: the socket's onStatus is a macrotask
// that can land at any await inside runtime.startup(), and the
// first-connect handler then waits on the mount-time pending read and the
// startup run itself. A load given connectAt connects that many ticks after
// its mount begins instead, whether or not the startup has finished.
import type { BatchId, SyncSeq } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import { createReplica, type Replica } from "../../replica/client";
import { RpcLifecycleError } from "../../replica/errors";
import { computeEditability, type ReplicaMode } from "../../sync/syncState";
import type { ReplicaDb } from "../../replica/db";
import { getMeta } from "../../replica/meta";
import { serveRpc, toPortLike } from "../../replica/rpc";
import { failingOnce, openRawTestDb } from "../../replica/testDb";
import { buildHandlers } from "../../replica/workerHandlers";
import { createClientRuntime, type ClientRuntime } from "../../sync/clientRuntime";
import { createLegacyRepair } from "../../sync/legacyRepair";
import { createOpQueue, type OpQueue, type PoisonEvent } from "../../sync/opQueue";
import { createReconnectFlow, type ReconnectFlow } from "../../sync/reconnectFlow";
import { createReplicaSync, type ReplicaSync } from "../../sync/replicaSync";
import type { SyncEvent, SyncStatus } from "../../sync/syncState";
import { BAD_UID } from "./arbitraries";
import type { ServerControl } from "./serverControl";
import { createTransport, type Broken, type Transport, type TransportOptions,
         type TransportLife } from "./transport";
import { clientIdOf, batchIdOf, seqOf } from "../../test-helpers";

export interface HarnessClient {
  readonly name: string;
  /** Survives reload. */
  readonly db: ReplicaDb;
  readonly transport: Transport;
  /** The current life's instances; reload() replaces them. */
  readonly queue: OpQueue;
  readonly replica: Replica;
  readonly replicaSync: ReplicaSync;
  /** Every ticket's batch id, in enqueue order, across lives. */
  readonly enqueued: BatchId[];
  /** Batch ids reported rejected: through onPoison, or found poisoned by a
   * page load's startup discovery. */
  readonly poisoned: BatchId[];
  /** Errors reported through onDesync. */
  readonly desyncs: unknown[];
  /** The client runtime's and the legacy repair's sync events
   * (SyncProvider's applySync input), in order, across lives. */
  readonly syncEvents: SyncEvent[];
  /** Entries in the queue's in-memory lane (lost by a reload). */
  unsentInMemory(): number;
  /** The socket coming up. */
  online(): Promise<void>;
  /** The socket going down. */
  offline(): void;
  /** Enqueues `ops` and waits for persistence only; delivery runs in the
   * background, as in the app. */
  edit(ops: BlockOp[]): Promise<BatchId>;
  /** Pulls now and waits for the pull to finish. */
  pull(): Promise<void>;
  /** How the last pull() met replicaSync: alone, joining a pull in flight,
   * or joining one while a poison repair owned recovery (that pass may be
   * left to the repair, and the join must still get a pass of its own). */
  lastPullJoin(): PullJoin;
  /** A websocket seq frame: not awaited. */
  nudge(seq: SyncSeq, force?: boolean): void;
  /** The next pending_ops INSERT throws. */
  failNextWrite(): void;
  /** A failNextWrite whose INSERT has not yet come. */
  writeFailArmed(): boolean;
  /** Batches pushed into the lane, across lives: how often writeFails and
   * lostReply fired together. */
  lanePushes(): number;
  /** The next enqueue's reply times out on the main thread while the worker
   * still stores the row, as when a recovery lease holds the worker's gate
   * past the RPC timeout: the batch has a durable row and a lane copy. */
  loseNextReply(): void;
  /** A loseNextReply whose enqueue has not yet come. */
  lostReplyArmed(): boolean;
  /** How often loseNextReply fired, across lives. */
  lostReplies(): number;
  /** The batch ids whose pending_ops INSERT failed, in order: the lane sends
   * them from memory, unhashed, and their ops never reach the replica. */
  readonly laneBatches: readonly BatchId[];
  /** A page reload. Online, the new life connects `connectAt` ticks after
   * its mount begins (see StartOptions); offline, it does not connect. */
  reload(connectAt?: number): Promise<void>;
  /** The current life's replica worker dies. */
  killWorker(): void;
  /** The worker dies the moment replicaSync's next applyChanges answers
   * needs-bootstrap: a fixed scenario's way to land a death between a pull
   * pass that leaves recovery to a poison repair and the pass after it. */
  killOnNeedsBootstrap(): void;
  /** Whether the current life's worker has died. */
  workerDead(): boolean;
  /** Batches not yet committed when a worker died, across lives: durable
   * rows that wait for the next life, behind that life's lane. */
  readonly undeliveredAtDeath: ReadonlySet<BatchId>;
  /** Batches a dead worker's life pushed into the lane, across lives. */
  deathLanePushes(): number;
  /** Batches whose enqueue reply loseNextReply lost: a lane copy and a
   * durable row, across lives. */
  readonly lostReplyBatches: readonly BatchId[];
  /** SyncProvider's replicaState.mode for the current life. */
  mode(): ReplicaMode;
  /** The current life's replicaSync.appliedVersion(). */
  appliedVersion(): number | null;
  /** The current life's replicaSync.hasStarted(). */
  hasStarted(): boolean;
  /** Whether the current life's replicaSync has called init: a start was
   * attempted, rather than held back behind a poison repair. */
  startAttempted(): boolean;
  /** What the editor may do: computeEditability over the life's status and
   * mode, as SyncProvider derives canEdit. */
  canEdit(): boolean;
  /** Whether the current life's timed connect fired before its startup had
   * finished, or null when it had no timing or did not connect. */
  connectLanded(): ConnectLanding | null;
  /** sync_client_meta "cursor", 0 before the first bootstrap. */
  cursor(): SyncSeq;
  dispose(): Promise<void>;
}

/** What one page load's instances share with the harness. */
interface LifeState {
  /** useSocketLifecycle's statusRef. */
  status: SyncStatus;
  /** SyncProvider's replicaState.mode, set by both of its writers. */
  mode: ReplicaMode;
  workerDead: boolean;
  startAttempted: boolean;
  everConnected: boolean;
  unsentInMemory: number;
  ended: boolean;
}

/** One page load's instances. */
interface Life {
  state: LifeState;
  queue: OpQueue;
  replica: Replica;
  replicaSync: ReplicaSync;
  runtime: ClientRuntime;
  reconnect: ReconnectFlow;
  /** useSocketLifecycle's readInitialPending, read at mount. */
  initialPending: Promise<number>;
  offs: (() => void)[];
  /** This life's view of the shared database. */
  handle: LifeDb;
  /** One slot per non-empty enqueue, in call order: the queue mints ids in
   * the same order on its persist chain, and each mint fills the oldest
   * empty slot. */
  idSlots: { id?: BatchId }[];
  kill(): void;
}

const PENDING_INSERT = /^\s*INSERT INTO pending_ops/i;

export type ConnectLanding = "mid-startup" | "after startup";

export type PullJoin = "alone" | "joined" | "joined under poison";

const POISON_EVENTS = new Set<SyncEvent["type"]>([
  "repair-started", "repair-failed", "poison-mark-failed", "repair-succeeded",
  "poison-intents-discarded"]);
/** Whether a poison repair owns recovery, read from the runtime's events. */
const poisonOwns = (events: readonly SyncEvent[]): boolean => {
  const last = [...events].reverse().find((e) => POISON_EVENTS.has(e.type));
  return last !== undefined && last.type !== "repair-succeeded" &&
    last.type !== "poison-intents-discarded";
};

/** How the client's first bootstrap goes. "fails": its first two snapshot
 * fetches answer 503. "timesOut": its first snapshot fetch answers 503 and
 * the next applySnapshot reply times out while the worker applies it. Either
 * way the mount's start and the first connect's both fail, unless the
 * connect joins the mount's, and only the backoff retries it. */
export type FirstStart = "ok" | "fails" | "timesOut";

/** The backoff's first delay for a client whose first start is drawn to
 * fail: the app's second would outlast most examples. */
export const FAST_RETRY_MS = 25;

export interface StartOptions {
  /** Ticks (event-loop turns, each a setTimeout of 0) after the first
   * mount begins at which the socket connects; absent, it connects once the
   * startup has finished. */
  connectAt?: number;
  firstStart?: FirstStart;
}

/** `n` event-loop turns. */
async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

interface LifeDb {
  db: ReplicaDb;
  ended(): boolean;
  end(): void;
}

/** `db` for one life: unusable once `end` has run, as a dead worker's handle
 * is, while the database itself carries on for the next life. */
function lifeDb(current: () => ReplicaDb): LifeDb {
  let ended = false;
  const live = (): ReplicaDb => {
    if (ended) throw new Error("replica worker ended with its page load");
    return current();
  };
  return {
    db: {
      exec: (sql, params) => live().exec(sql, params),
      select: (sql, keys, params) => live().select(sql, keys, params),
      introspect: (sql, params) => live().introspect(sql, params),
      transaction: (fn) => live().transaction(fn),
    },
    ended: () => ended,
    end: () => { ended = true; },
  };
}

export async function startClient(
  name: string, server: ServerControl, broken?: Broken,
  transportOptions: TransportOptions = {},
  { connectAt, firstStart = "ok" }: StartOptions = {},
): Promise<HarnessClient> {
  const raw = await openRawTestDb();
  const db = raw.db;
  const transport = createTransport(server, broken, transportOptions);
  const enqueued: BatchId[] = [];
  const poisoned: BatchId[] = [];
  const desyncs: unknown[] = [];
  const syncEvents: SyncEvent[] = [];
  // Stands in for the localStorage poison-intent store, and outlives a
  // reload as localStorage does.
  let poisonIntents: PoisonEvent[] = [];
  let minted = 0;
  let lives = 0;
  // failingOnce over the shared handle while a write failure is armed.
  let writeDb: ReplicaDb = db;
  let writeArmed = false;
  let lanePushes = 0;
  let loseArmed = false;
  let lostReplies = 0;
  const laneBatches: BatchId[] = [];
  const undeliveredAtDeath = new Set<BatchId>();
  const lostReplyBatches: BatchId[] = [];
  let deathLanePushes = 0;
  let snapshotTimeoutArmed = firstStart === "timesOut";
  const retryBaseMs = firstStart === "ok" ? undefined : FAST_RETRY_MS;
  let disposed = false;

  const buildLife = (doors: TransportLife): Life => {
    lives += 1;
    // A page load mints a new client id; batch ids carry on across lives.
    const clientId = clientIdOf(`proptest-${name}-${lives}`);
    const idSlots: { id?: BatchId }[] = [];
    const state: LifeState = {
      status: "connecting", mode: "starting", workerDead: false, startAttempted: false,
      everConnected: false, unsentInMemory: 0, ended: false,
    };
    const handle = lifeDb(() => writeDb);
    const channel = new MessageChannel();
    serveRpc(toPortLike(channel.port2), buildHandlers({
      openDb: async () => {
        if (handle.ended()) throw new Error("replica worker ended with its page load");
        return handle.db;
      },
      // Ends this life's view of the database, never the database: close
      // runs behind every request the worker had already received.
      closeDb: () => handle.end(),
    }));
    const replica = createReplica(toPortLike(channel.port1), () => {
      channel.port1.close();
      channel.port2.close();
    });
    // The queue's view of the replica: a lost reply rejects on this side
    // while the worker's write goes on. Not with a write failure armed, whose
    // INSERT would store nothing.
    // A dead worker's enqueue goes to the lane unhashed, as a failed write
    // does; one in flight at the death may also have stored its row.
    const deadLane = <T>(batchId: BatchId, sent: Promise<T>): Promise<T> =>
      sent.catch((error: unknown) => {
        if (error instanceof RpcLifecycleError && error.kind === "worker-error") {
          laneBatches.push(batchId);
          deathLanePushes += 1;
        }
        throw error;
      });
    const queueReplica: Replica = {
      ...replica,
      enqueue: (ops, batchId) => {
        if (!loseArmed || writeArmed || state.workerDead) {
          return deadLane(batchId, replica.enqueue(ops, batchId));
        }
        loseArmed = false;
        lostReplies += 1;
        lostReplyBatches.push(batchId);
        replica.enqueue(ops, batchId).catch(() => undefined);
        return Promise.reject(new RpcLifecycleError(
          "timeout", "proptest: replica RPC enqueue timed out"));
      },
    };
    // replicaSync's view: a first applySnapshot drawn to time out rejects
    // here while the worker applies it.
    const syncReplica: Replica = {
      ...replica,
      init: () => {
        state.startAttempted = true;
        return replica.init();
      },
      applyChanges: async (feed, expectedPendingIds) => {
        const res = await replica.applyChanges(feed, expectedPendingIds);
        if (killOnNeedsBootstrap && res.status === "needs-bootstrap") {
          killOnNeedsBootstrap = false;
          killCurrent();
        }
        return res;
      },
      applySnapshot: (snapshot, expectedPendingIds) => {
        if (!snapshotTimeoutArmed) return replica.applySnapshot(snapshot, expectedPendingIds);
        snapshotTimeoutArmed = false;
        replica.applySnapshot(snapshot, expectedPendingIds).catch(() => undefined);
        return Promise.reject(new RpcLifecycleError(
          "timeout", "proptest: replica RPC applySnapshot timed out"));
      },
    };
    const queue = createOpQueue(queueReplica, {
      post: doors.post,
      clientId,
      poisonStore: {
        read: () => [...poisonIntents],
        write: (intents) => { poisonIntents = [...intents]; },
      },
      newBatchId: () => {
        minted += 1;
        const id = batchIdOf(`batch-${name}-${minted}`);
        enqueued.push(id);
        const slot = idSlots.find((s) => s.id === undefined);
        if (slot) slot.id = id;
        return id;
      },
    });
    const replicaSync = createReplicaSync({
      replica: syncReplica,
      fetchJson: doors.fetchJson,
      clientId,
      queue,
      isOffline: () => state.status === "reconnecting",
      onState: (next) => { if (!state.ended) state.mode = next.mode; },
      retryBaseMs,
    });
    const runtime = createClientRuntime({
      queue, replicaSync,
      replica: {
        // Startup discovery. A rejection whose onPoison died with the page
        // load before (its mark landed while that life was being torn down)
        // is found here, surfaced and repaired by this one.
        poisonedBatches: async () => {
          const found = await replica.poisonedBatches();
          for (const event of found) {
            if (!poisoned.includes(event.batch_id)) poisoned.push(event.batch_id);
          }
          return found;
        },
        deleteBatch: (id, batchId) => replica.deleteBatch(id, batchId),
      },
      onSyncEvent: (event) => { syncEvents.push(event); },
      onReplicaState: (next) => { if (!state.ended) state.mode = next.mode; },
    });
    const legacyRepair = createLegacyRepair({
      repairSessions: async (onStable) => {
        await doors.fetchJson(`/api/block/${BAD_UID}`);
        onStable();
      },
      onEvent: (event) => { syncEvents.push(event); },
      resume: () => queue.resume("lane"),
      isMounted: () => !state.ended,
    });
    const reconnect = createReconnectFlow({
      queue,
      replicaSync,
      isMounted: () => !state.ended,
      onResync: () => undefined,
      // SyncProvider's composition: the poison repair first, then the legacy.
      retryFailedRepair: async () => {
        await runtime.retryFailedRepair();
        await legacyRepair.retryFailed();
      },
    });
    const offs = [
      queue.onDesync((desync) => {
        desyncs.push(desync.error);
        void legacyRepair.run(desync.error, desync);
      }),
      queue.onPoison((event) => { poisoned.push(event.batch_id); }),
      queue.onUnsentInMemory((n) => {
        if (n > state.unsentInMemory) lanePushes += n - state.unsentInMemory;
        state.unsentInMemory = n;
      }),
      queue.onDrain((outcome) => reconnect.observeDrain(outcome)),
    ];
    return {
      state, queue, replica, replicaSync, runtime, reconnect,
      initialPending: Promise.resolve(0), offs, handle, idSlots,
      kill: () => {
        state.workerDead = true;
        // what a Worker's error event does to the RPC client (rpc.ts)
        toPortLike(channel.port1).onerror?.({ message: "proptest: replica worker died" });
      },
    };
  };

  /** SyncProvider's mount: the startup effect, then useSocketLifecycle's
   * mount-time pending read. */
  const mount = (l: Life): Promise<void> => {
    const startup = l.runtime.startup();
    l.initialPending = l.queue.refreshPending();
    return startup;
  };

  /** Ends a life whose transport doors are already severed, so that any of
   * its work still in flight fails at its next request instead of waiting
   * on the network. */
  const endLife = async (l: Life): Promise<void> => {
    l.state.ended = true;
    l.offs.forEach((off) => off());
    // useSocketLifecycle's teardown order: stop replicaSync, dispose the
    // queue, then SyncProvider's disposeOwned (the runtime, then the replica).
    l.replicaSync.stop();
    l.queue.dispose();
    l.runtime.dispose();
    try {
      // close queues behind every request the old worker already received,
      // so this resolves once that work has finished; then the ports close.
      await l.replica.dispose();
    } finally {
      // A close that timed out must still cut the old life off from the
      // shared database.
      l.handle.end();
    }
  };

  if (firstStart !== "ok") transport.arm("snapshot5xx");
  if (firstStart === "fails") transport.arm("snapshot5xx");
  let life = buildLife(transport.newLife());
  let offline = false;

  // Copied from useSocketLifecycle's onStatus (sync/useSocketLifecycle.ts);
  // keep the two in step. The harness awaits the first-connect chain the
  // socket handler leaves running.
  const goOnline = async (l: Life): Promise<void> => {
    offline = false;
    transport.setOffline(false);
    l.queue.setOnline(true);
    l.state.status = "connected";
    if (l.state.everConnected) {
      await l.reconnect.begin().catch((error: unknown) => {
        console.error("reconnect.begin() failed", error);
      });
      return;
    }
    l.state.everConnected = true;
    try {
      const n = await l.initialPending;
      await l.runtime.startupRun();
      // A reload during those awaits ended this life: never call into it.
      if (l.state.ended) return;
      if (n > 0 || !l.replicaSync.hasStarted()) {
        await l.reconnect.begin({ viewsAreStale: true });
      }
    } catch (error: unknown) {
      console.error("first-connect reconnect.begin() failed", error);
    }
  };

  const goOffline = (l: Life): void => {
    offline = true;
    transport.setOffline(true);
    l.queue.setOnline(false);
    l.state.status = "reconnecting";
  };

  let landed: ConnectLanding | null = null;
  let killOnNeedsBootstrap = false;
  const killCurrent = (): void => {
    if (life.state.workerDead) return;
    const committed = transport.committed;
    for (const id of enqueued) if (!committed.has(id)) undeliveredAtDeath.add(id);
    life.kill();
  };
  let lastJoin: PullJoin = "alone";

  /** A page load that connects: the mount, and the socket's first connect
   * either once the startup has finished or `at` ticks after the mount
   * begins, running alongside whatever of the startup is left. */
  const load = async (l: Life, at: number | undefined): Promise<void> => {
    landed = null;
    if (at === undefined) {
      await mount(l);
      await goOnline(l);
      return;
    }
    let mountDone = false;
    const mounted = mount(l).finally(() => { mountDone = true; });
    // Rejected while the ticks run, it is still awaited below.
    mounted.catch(() => undefined);
    await ticks(at);
    landed = mountDone ? "after startup" : "mid-startup";
    await Promise.all([mounted, goOnline(l)]);
  };

  await load(life, connectAt);

  return {
    name,
    db,
    transport,
    get queue() { return life.queue; },
    get replica() { return life.replica; },
    get replicaSync() { return life.replicaSync; },
    enqueued,
    poisoned,
    desyncs,
    syncEvents,
    unsentInMemory: () => life.state.unsentInMemory,
    online: () => goOnline(life),
    offline: () => goOffline(life),
    async edit(ops) {
      if (ops.length === 0) throw new Error("an edit needs at least one op");
      const l = life;
      const slot: { id?: BatchId } = {};
      l.idSlots.push(slot);
      const ticket = l.queue.enqueue(ops);
      await ticket.settled;
      // The mint precedes the replica write that settles the ticket, so the
      // slot is filled unless the queue was disposed before persisting.
      if (slot.id === undefined) throw new Error("the queue minted no batch id");
      return slot.id;
    },
    async pull() {
      const l = life;
      const latest = await server.latestSeq();
      // A reload while the seq was read ended this life: never call into it.
      if (l.state.ended) return;
      // idle() hands out the one in-flight pull, or a fresh resolved promise
      const inFlight = l.replicaSync.idle() === l.replicaSync.idle();
      lastJoin = !inFlight ? "alone"
        : poisonOwns(syncEvents) ? "joined under poison" : "joined";
      // Forced: a rotated generation keeps the journal's seq, and a pull must
      // still run to find it.
      l.replicaSync.onSeq(latest, true);
      await l.replicaSync.idle();
    },
    lastPullJoin: () => lastJoin,
    nudge(seq, force = false) {
      life.replicaSync.onSeq(seq, force);
    },
    failNextWrite() {
      const failing = failingOnce(db, PENDING_INSERT, "proptest: injected write failure");
      writeArmed = true;
      writeDb = {
        ...failing,
        exec(sql, params) {
          // The first matching INSERT is the one failingOnce throws on.
          if (writeArmed && PENDING_INSERT.test(sql)) {
            writeArmed = false;
            const batch = params?.[0];
            if (typeof batch !== "string") throw new Error("proptest: a pending insert without a batch id");
            laneBatches.push(batchIdOf(batch));
          }
          failing.exec(sql, params);
        },
      };
    },
    writeFailArmed: () => writeArmed,
    lanePushes: () => lanePushes,
    loseNextReply() { loseArmed = true; },
    lostReplyArmed: () => loseArmed,
    lostReplies: () => lostReplies,
    laneBatches,
    async reload(at) {
      // Severed first: the old life's fetches fail now rather than after
      // the network answers, which also releases any recovery lease it holds.
      const doors = transport.newLife();
      await endLife(life);
      // A dispose that ran while the old life was ending has closed the DB:
      // a new life built now would keep open message ports on it.
      if (disposed) return;
      life = buildLife(doors);
      if (offline) {
        landed = null;
        await mount(life);
        goOffline(life);
      } else {
        await load(life, at);
      }
    },
    connectLanded: () => landed,
    killWorker: () => killCurrent(),
    killOnNeedsBootstrap() { killOnNeedsBootstrap = true; },
    workerDead: () => life.state.workerDead,
    undeliveredAtDeath,
    deathLanePushes: () => deathLanePushes,
    lostReplyBatches,
    mode: () => life.state.mode,
    appliedVersion: () => life.replicaSync.appliedVersion(),
    hasStarted: () => life.replicaSync.hasStarted(),
    startAttempted: () => life.state.startAttempted,
    canEdit: () => computeEditability(life.state.status, life.state.mode).canEdit,
    cursor() {
      const hasMeta = db.select(
        "SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'sync_client_meta'", ["n"],
      ).length > 0;
      return seqOf(Number(hasMeta ? getMeta(db, "cursor") ?? 0 : 0));
    },
    async dispose() {
      disposed = true;
      transport.newLife();
      await endLife(life);
      raw.close();
    },
  };
}
