// pattern: Imperative Shell
// One simulated device: the real replica worker handlers over a
// MessageChannel, the real op queue, replicaSync, clientRuntime and
// reconnect flow, wired as SyncProvider and useSocketLifecycle wire them, over
// an in-memory sqlite database that survives reloads.
//
// A "life" is one page load. reload() ends it the way a browser ends one by
// killing the worker and the page's fetches: the transport discards replies
// to the old life's requests and refuses its new ones, the old worker
// handlers finish what they had already received and then lose the
// database, and the old ports close, so nothing from an old promise chain
// can write into the database the new life opens.
import type { BatchId, ClientId, SyncSeq } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import { createReplica, type Replica } from "../../replica/client";
import type { ReplicaDb } from "../../replica/db";
import { getMeta } from "../../replica/meta";
import { serveRpc, toPortLike } from "../../replica/rpc";
import { failingOnce, openRawTestDb } from "../../replica/testDb";
import { buildHandlers } from "../../replica/workerHandlers";
import { createClientRuntime, type ClientRuntime } from "../../sync/clientRuntime";
import { createOpQueue, type OpQueue, type PoisonEvent } from "../../sync/opQueue";
import { createReconnectFlow, type ReconnectFlow } from "../../sync/reconnectFlow";
import { createReplicaSync, type ReplicaSync } from "../../sync/replicaSync";
import type { SyncStatus } from "../../sync/syncState";
import type { ServerControl } from "./serverControl";
import { createTransport, type Broken, type Transport,
         type TransportLife } from "./transport";

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
  /** A websocket seq frame: not awaited. */
  nudge(seq: SyncSeq, force?: boolean): void;
  /** The next pending_ops INSERT throws. */
  failNextWrite(): void;
  /** A failNextWrite whose INSERT has not yet come. */
  writeFailArmed(): boolean;
  reload(): Promise<void>;
  /** sync_client_meta "cursor", 0 before the first bootstrap. */
  cursor(): SyncSeq;
  dispose(): Promise<void>;
}

/** What one page load's instances share with the harness. */
interface LifeState {
  /** useSocketLifecycle's statusRef. */
  status: SyncStatus;
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
}

const PENDING_INSERT = /^\s*INSERT INTO pending_ops/i;

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
      select: (sql, params) => live().select(sql, params),
      transaction: (fn) => live().transaction(fn),
    },
    ended: () => ended,
    end: () => { ended = true; },
  };
}

export async function startClient(
  name: string, server: ServerControl, broken?: Broken,
): Promise<HarnessClient> {
  const raw = await openRawTestDb();
  const db = raw.db;
  const transport = createTransport(server, broken);
  const enqueued: BatchId[] = [];
  const poisoned: BatchId[] = [];
  const desyncs: unknown[] = [];
  // Stands in for the localStorage poison-intent store, and outlives a
  // reload as localStorage does.
  let poisonIntents: PoisonEvent[] = [];
  let minted = 0;
  let lives = 0;
  // failingOnce over the shared handle while a write failure is armed.
  let writeDb: ReplicaDb = db;
  let writeArmed = false;

  const buildLife = (doors: TransportLife): Life => {
    lives += 1;
    // A page load mints a new client id; batch ids carry on across lives.
    const clientId = `proptest-${name}-${lives}` as ClientId;
    const idSlots: { id?: BatchId }[] = [];
    const state: LifeState = {
      status: "connecting", everConnected: false, unsentInMemory: 0, ended: false,
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
    const queue = createOpQueue(replica, {
      post: doors.post,
      clientId,
      poisonStore: {
        read: () => [...poisonIntents],
        write: (intents) => { poisonIntents = [...intents]; },
      },
      newBatchId: () => {
        minted += 1;
        const id = `batch-${name}-${minted}` as BatchId;
        enqueued.push(id);
        const slot = idSlots.find((s) => s.id === undefined);
        if (slot) slot.id = id;
        return id;
      },
    });
    const replicaSync = createReplicaSync({
      replica,
      fetchJson: doors.fetchJson,
      clientId,
      queue,
      isOffline: () => state.status === "reconnecting",
      onState: () => undefined,
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
      onSyncEvent: () => undefined,
      onReplicaState: () => undefined,
    });
    const reconnect = createReconnectFlow({
      queue,
      replicaSync,
      isMounted: () => !state.ended,
      onResync: () => undefined,
    });
    const offs = [
      // Stands in for SyncProvider's legacy outline repair, whose success
      // resumes delivery.
      queue.onDesync((error) => {
        desyncs.push(error);
        void Promise.resolve().then(() => {
          if (!state.ended) queue.resume("recovery");
        });
      }),
      queue.onPoison((event) => { poisoned.push(event.batch_id); }),
      queue.onUnsentInMemory((n) => { state.unsentInMemory = n; }),
      queue.onDrain((outcome) => reconnect.observeDrain(outcome)),
    ];
    return {
      state, queue, replica, replicaSync, runtime, reconnect,
      initialPending: Promise.resolve(0), offs, handle, idSlots,
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

  await mount(life);
  await goOnline(life);

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
      // Forced: a rotated generation keeps the journal's seq, and a pull must
      // still run to find it.
      l.replicaSync.onSeq(latest, true);
      await l.replicaSync.idle();
    },
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
          if (PENDING_INSERT.test(sql)) writeArmed = false;
          failing.exec(sql, params);
        },
      };
    },
    writeFailArmed: () => writeArmed,
    async reload() {
      // Severed first: the old life's fetches fail now rather than after
      // the network answers, which also releases any recovery lease it holds.
      const doors = transport.newLife();
      await endLife(life);
      life = buildLife(doors);
      await mount(life);
      if (offline) goOffline(life);
      else await goOnline(life);
    },
    cursor() {
      const hasMeta = db.select(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_client_meta'",
      ).length > 0;
      return Number(hasMeta ? getMeta(db, "cursor") ?? 0 : 0) as SyncSeq;
    },
    async dispose() {
      transport.newLife();
      await endLife(life);
      raw.close();
    },
  };
}
