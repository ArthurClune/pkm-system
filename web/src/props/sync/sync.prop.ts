// pattern: Imperative Shell
// The sync protocol property: 2-3 clients running the real web sync stack
// against the real server take a random sequence of edits and faults, then
// are brought to rest and checked by the oracle. One example in three caps
// the changes feed's window at a few journal rows, so a catch-up crosses
// window boundaries (see windowLimit). Half the time a client's first
// connect, and a Reload's, comes at a drawn tick of its startup rather than
// after it (connectTiming in commands.ts), and one client in five has its
// first bootstrap fail (firstStart). The fixed scenarios run first, through
// the same commands.
//
// Between the commands and quiesce, settleReplicas checks what quiesce's own
// reconnect would hide: a first bootstrap that failed with the socket up
// must be retried without one, and a client whose worker died must be
// online-only after one pull. It then reloads each such client, as its
// banner asks; lane batches that reload destroys are expected lost.
//
// A failure prints the seed, the path, the shrunk command list, what each
// command did in the failing run, the oracle's findings and a replay line.
// How often each command ran or was skipped by its precondition, and how
// often each fault was armed and fired, is printed after the property.
import fc from "fast-check";
import { beforeAll, expect, test } from "vitest";
import { extractRefs } from "../../grammar/refs";
import { EDIT_TARGETS, type OpDraft, PAGE_TITLES } from "./arbitraries";
import { cancellable, ExampleCancelled } from "./cancel";
import { conflictLane, conflictNoise, overwrittenTarget } from "./conflictNoise";
import { staleNamers } from "./deleteWins";
import { BadBatch, commandsFor, connectTally, connectTiming, countSkipsWith, Edit,
         Fault, type FaultKind, NAMES, Nudge, Offline, Pull, Reload, Rename,
         RotateGeneration, SyncCommand, WorkerDies, type World } from "./commands";
import { REPLAY_PATH } from "./env";
import { type FirstStart, HARNESS_LEASE_MS, startClient,
         type HarnessClient } from "./harnessClient";
import { initialModel, type SyncModel } from "./model";
import { BannerWatch, checkQuiescent, CursorWatch, ModeWatch } from "./oracle";
import { quiesce, TIMED_OUT, within } from "./quiesce";
import { connectServer, type ServerControl } from "./serverControl";
import { settleReplicas } from "./settle";
import { AwaitPoisonRepair, clientIn, HoldSnapshots, ReleaseSnapshots } from "./steps";
import { checkGateProperty, EXAMPLES } from "../gate";
import { bump, type Reach, type Tally } from "../reach";
import { captureFaultWarnings } from "../warningsCapture";

captureFaultWarnings("sync");

/** Examples per gate run, sized so `proptest/check.sh web` takes about
 * three minutes. */
export const NUM_RUNS = 2100;
const MAX_COMMANDS = 30;
const QUIESCE_LIMIT_MS = 30_000;
/** One example, commands to oracle: well past the quiesce limit, so a
 * liveness failure is quiesce's to report. A command that hangs is caught
 * here instead, as a failing example fast-check can shrink. */
const EXAMPLE_LIMIT_MS = 90_000;
/** fast-check abandons the example the limit cuts into, which the property
 * then cancels. The margin to vitest's testTimeout (vitest.props.config.ts)
 * covers that example's clean-up and the report, so vitest never cuts a
 * report off. */
const PROPERTY_LIMIT_MS = 840_000;
const DISPOSE_LIMIT_MS = 10_000;
/** How long a fixed scenario waits for the state it sets up. */
const REPRO_WAIT_MS = 5_000;

type Commands = Iterable<fc.AsyncCommand<SyncModel, World, boolean>>;

/** The fixed scenarios count into it too; the property empties it first. */
const tally: Tally = new Map();
const count = (key: string, n = 1): void => { bump(tally, key, n); };
countSkipsWith(count);

const FAULT_KINDS: readonly FaultKind[] = [
  "dropAck", "duplicate", "lostPull", "writeFails", "lostReply", "snapshot5xx",
  "slowSnapshot", "stalledSnapshot"];

/** How many of each fault kind fired across these clients: transport faults
 * that met a request, and failed local writes that pushed a batch into the
 * lane. */
const firedFaults = (clients: Iterable<HarnessClient>): Record<FaultKind, number> => {
  const fired: Record<FaultKind, number> = {
    dropAck: 0, duplicate: 0, lostPull: 0, writeFails: 0, lostReply: 0, snapshot5xx: 0,
    slowSnapshot: 0, stalledSnapshot: 0,
  };
  for (const c of clients) {
    fired.dropAck += c.transport.fired("dropAck");
    fired.duplicate += c.transport.fired("duplicate");
    fired.lostPull += c.transport.fired("lostPull");
    fired.snapshot5xx += c.transport.fired("snapshot5xx");
    fired.slowSnapshot += c.transport.fired("slowSnapshot");
    fired.stalledSnapshot += c.transport.fired("stalledSnapshot");
    fired.writeFails += c.lanePushes() - c.lostReplies() - c.deathLanePushes();
    fired.lostReply += c.lostReplies();
  }
  return fired;
};

let server: ServerControl;

beforeAll(async () => {
  server = await connectServer();
});

/** Counts how each recovery run that got a lease went with it. */
function countRecoveries(clients: Iterable<HarnessClient>): void {
  for (const c of clients) {
    for (const r of c.recoveries) {
      if (r.renewals > 0) count("Recovery renewed");
      if (r.committedAt !== null && r.committedAt - r.calledAt > HARNESS_LEASE_MS) {
        count("Recovery committed past its first deadline");
      }
      if (r.abandonedOnStall) count("Recovery abandoned on a stall");
    }
  }
}

/** Fault rows read armed and fired side by side; everything else is one
 * count per key. */
function showSyncTally(t: Tally): string {
  const isFault = (k: string): boolean => /^Fault \S+( fired)?$/.test(k);
  const rest = [...t].filter(([k]) => !isFault(k));
  const width = Math.max(0, ...rest.map(([k]) => k.length));
  const faults = FAULT_KINDS.map((kind) =>
    `  Fault ${kind.padEnd(15)}  armed ${String(t.get(`Fault ${kind}`) ?? 0).padStart(6)}` +
    `  fired ${String(t.get(`Fault ${kind} fired`) ?? 0).padStart(6)}`);
  return `sync property tally (the property's examples):\n${
    rest.sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `  ${k.padEnd(width)}  ${n}`).join("\n")}\n${faults.join("\n")}`;
}

/** Where each label must stay above its share of EXAMPLES. The reach
 * signal is each `Fault <kind> fired`: a fault armed far more often than
 * it fired is the case a floor must catch. */
const REACH: Reach = {
  per: EXAMPLES,
  // Floors: half the lowest share over 30 unseeded gate runs, 2026-11-10.
  // No floor, under five events in some run:
  //   "Edit refused: read-only, mode recovery-failed"
  //   "Edit refused: read-only, mode stalled"
  //   "Pull joined under poison"
  //   "examples with an overwritten conflict on a lane write"
  //   "examples with an overwritten conflict behind an overtaking lost reply"
  // No floor, under ten in some run, so half of it is noise:
  //   "CrossMidnight fell back to model date"
  //   "settle: dead worker's reload drops lane batches"
  //   "Edit while a snapshot is paced"
  // No floor, server timing, not a draw, decides when the connect lands:
  //   "Reload connect timed, landed after startup"
  //   "Reload connect timed, landed mid-startup"
  //   "start connect timed, landed after startup"
  //   "start connect timed, landed mid-startup"
  // The banner, mark, discard and discovery-death labels were floored the
  // same rough way, from 6 unseeded runs on 2026-11-11: a quarter of the
  // lowest share. No floor, under ten in some run: the rarer "Banner rule:"
  // paths ("gone over failed", "gone over mark-failed", "gone over
  // running", "gone over stalled", "gone, then failed", "gone, then
  // mark-failed", "gone, then running"), "Discard of a failed mark" with or
  // without a dead worker, "WorkerDies during a poison repair", "BadBatch,
  // mark ... at startup" and "settle: first start held back by an
  // unanswered failed mark". The fixed scenarios and bannerTeeth.prop.ts
  // reach the stalled and running paths by construction. Never reached: a
  // mark during a repair, so no Discard of a failed mark during one.
  // The eight paced-snapshot labels were floored roughly, from 6 unseeded
  // runs on 2026-11-11: a quarter of the lowest share for the four drawn
  // Fault labels, and for the Recovery labels, which the harness lease's
  // real timers decide, only at least one event per run.
  floors: {
    "BadBatch": 0.187,
    "BadBatch skipped: worker dead": 0.012,
    "BadBatch skipped: write failure armed or lane unsent": 0.022,
    "BadBatch, mark fails": 0.021,
    "BadBatch, mark fails at rest": 0.014,
    "BadBatch, mark unmatched": 0.011,
    "BadBatch, mark unmatched at rest": 0.007,
    "Banner after a command: none": 0.24,
    "Banner after a command: rejected-batch failed": 0.003,
    "Banner after a command: rejected-batch mark-failed": 0.013,
    "Banner after a command: rejected-batch repaired": 0.025,
    "Banner after a command: rejected-batch running": 0.026,
    "Banner after a command: replica-unusable": 0.064,
    "Banner after a command: replica-unusable paused": 0.024,
    "Banner after quiesce: none": 0.246,
    "Banner after quiesce: rejected-batch repaired": 0.061,
    "Banner rule: gone over none": 0.095,
    "Banner rule: gone over repaired": 0.002,
    "Banner rule: gone, a kept problem ended by poison-intents-discarded": 0.001,
    "Banner rule: gone, then discovery": 0.023,
    "Banner unmodelled: a stall report beside a poison problem": 0.005,
    "Banner with its worker dead, after a Discard: replica-unusable": 0.001,
    "Banner with its worker dead, before its reload: rejected-batch mark-failed": 0.001,
    "Banner with its worker dead, before its reload: rejected-batch repaired": 0.002,
    "Banner with its worker dead, before its reload: replica-unusable": 0.069,
    "Banner with its worker dead, before its reload: replica-unusable paused": 0.021,
    "CrossMidnight 2026-03-29": 0.023,
    "CrossMidnight 2026-10-25": 0.026,
    "CrossMidnight model": 0.177,
    "DeletePage deleted": 0.096,
    "DeletePage failed offline": 0.033,
    "DeletePage refused 404": 0.091,
    "DeletePage refused 409": 0.005,
    "Discard: no failed mark shown": 0.112,
    "Edit": 2.381,
    "Edit op create": 0.344,
    "Edit op create top of Fourth": 0.011,
    "Edit op create top of Proptest": 0.067,
    "Edit op create top of Second": 0.011,
    "Edit op create top of Third": 0.012,
    "Edit op delete": 1.378,
    "Edit op move": 1.39,
    "Edit op move top of Fourth": 0.052,
    "Edit op move top of Proptest": 0.051,
    "Edit op move top of Second": 0.053,
    "Edit op move top of Third": 0.051,
    "Edit op move top untitled": 0.223,
    "Edit op set_collapsed": 1.393,
    "Edit op update_text": 1.37,
    "Edit refused: read-only, mode no-replica": 0.007,
    "Edit refused: read-only, mode starting": 0.036,
    "Edit with a dead worker": 0.225,
    "Fault dropAck": 0.117,
    "Fault dropAck fired": 0.058,
    "Fault duplicate": 0.109,
    "Fault duplicate fired": 0.056,
    "Fault lostPull": 0.115,
    "Fault lostPull fired": 0.05,
    "Fault lostReply": 0.103,
    "Fault lostReply fired": 0.057,
    "Fault lostReply skipped: worker dead": 0.007,
    "Fault slowSnapshot": 0.013,
    "Fault slowSnapshot fired": 0.002,
    "Fault snapshot5xx": 0.477,
    "Fault snapshot5xx fired": 0.381,
    "Fault stalledSnapshot": 0.019,
    "Fault stalledSnapshot fired": 0.003,
    "Fault writeFails": 0.091,
    "Fault writeFails fired": 0.052,
    "Fault writeFails skipped: worker dead": 0.006,
    "Fault writeFails skipped: write failure armed or lane unsent": 0.01,
    "Nudge ahead": 0.147,
    "Nudge ahead skipped: offline": 0.025,
    "Nudge duplicate": 0.145,
    "Nudge duplicate skipped: offline": 0.024,
    "Nudge latest": 0.146,
    "Nudge latest skipped: offline": 0.025,
    "Nudge stale": 0.143,
    "Nudge stale skipped: offline": 0.024,
    "Offline": 0.596,
    "Offline skipped: already offline": 0.11,
    "Online after 1": 0.102,
    "Online after 2": 0.091,
    "Online after 3": 0.083,
    "Online after 5": 0.065,
    "Online at quiesce": 0.15,
    "Online at quiesce, before its return": 0.081,
    "Problem at settle, worker dead, after a Discard: replica-unusable": 0.001,
    "Problem at settle, worker dead: rejected-batch mark-failed": 0.001,
    "Problem at settle, worker dead: rejected-batch repaired": 0.002,
    "Problem at settle, worker dead: replica-unusable": 0.078,
    "Problem at settle, worker dead: replica-unusable paused": 0.022,
    "Problem at settle: none": 0.546,
    "Problem at settle: rejected-batch repaired": 0.069,
    "Pull": 0.608,
    "Pull alone": 0.576,
    "Pull joined": 0.024,
    "Pull skipped: offline": 0.106,
    "Pull with a dead worker": 0.045,
    "Pull with a dead worker, never started": 0.005,
    "Recovery abandoned on a stall": 0.0004,
    "Recovery committed past its first deadline": 0.0004,
    "Recovery renewed": 0.0004,
    "Reload": 0.389,
    "Reload connect timed, offline": 0.028,
    "Reload connect untimed": 0.203,
    "Reload of a dead worker": 0.028,
    "Reload skipped: write failure armed or lane unsent": 0.052,
    "Reload, worker died at discovery": 0.024,
    "Rename failed offline": 0.033,
    "Rename refused 404": 0.09,
    "Rename refused 409": 0.042,
    "Rename renamed": 0.055,
    "RotateGeneration": 0.239,
    "WorkerDies offline": 0.029,
    "WorkerDies online": 0.175,
    "WorkerDies skipped: already dead": 0.019,
    "examples with 2 clients": 0.237,
    "examples with 3 clients": 0.237,
    "examples with a conflict": 0.31,
    "examples with a leading attribute": 0.191,
    "examples with a rejected batch": 0.15,
    "examples with a stale batch naming a deleted page": 0.039,
    "examples with an overwritten conflict": 0.036,
    "examples with no window limit": 0.324,
    "examples with window limit 1": 0.028,
    "examples with window limit 2": 0.029,
    "examples with window limit 3": 0.034,
    "examples with window limit 4": 0.026,
    "examples with window limit 5": 0.024,
    "settle: Retry of a failed mark": 0.007,
    "settle: dead worker never started": 0.017,
    "settle: dead worker online-only after a pull": 0.156,
    "settle: first start owed a retry": 0.064,
    "start connect untimed": 0.608,
    "start first bootstrap fails, not started by it": 0.116,
    "start first bootstrap timesOut, not started by it": 0.11,
  },
};

interface ExampleOptions {
  /** Runs after the commands, before quiescence. */
  beforeQuiesce?: (world: World<HarnessClient>) => Promise<void>;
  /** Every client's changes-feed window, in journal rows; absent, the
   * server's default. */
  windowLimit?: number;
  /** Each client's first connect, by client order, in ticks after its
   * mount begins (StartOptions); absent, once its startup has finished. */
  connectAt?: readonly (number | undefined)[];
  /** Each client's first bootstrap, by client order; absent, "ok". */
  firstStart?: readonly FirstStart[];
}

/** No cap two times in three, else a window of one to five journal rows:
 * small enough that a catch-up over a few edits crosses several window
 * boundaries, where block tombstones wait for the window at the journal
 * head (see "Block tombstones wait for the head window" in
 * docs/architecture/sync-and-offline.md). */
const windowLimit: fc.Arbitrary<number | undefined> = fc.oneof(
  { weight: 2, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 5 }) },
);

/** Whether a recorded body writes a text that leads with an attribute. */
const leadsWithAttribute = (body: string): boolean =>
  ((JSON.parse(body) as { ops?: { text?: unknown }[] }).ops ?? []).some((op) =>
    typeof op.text === "string" &&
    extractRefs(op.text).refs.some((r) => r.kind === "attribute"));

/** An error as the report shows it. */
const showError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** Disposes every client, each dispose bounded: what went wrong, or null. */
async function disposeAll(clients: readonly HarnessClient[]): Promise<string | null> {
  const done = clients.map(() => false);
  const settled = Promise.allSettled(clients.map(async (c, i) => {
    try {
      await c.dispose();
    } finally {
      done[i] = true;
    }
  }));
  const outcome = await within(settled, DISPOSE_LIMIT_MS);
  if (outcome === TIMED_OUT) {
    const hung = clients.filter((_, i) => !done[i]).map((c) => c.name);
    return `dispose of ${hung.join(", ")} did not finish in ${DISPOSE_LIMIT_MS}ms`;
  }
  const failed = outcome.flatMap((r, i) =>
    r.status === "rejected" ? [`${clients[i].name}: ${showError(r.reason)}`] : []);
  return failed.length === 0 ? null : `dispose failed: ${failed.join("; ")}`;
}

const ABANDONED = Symbol("abandoned");

/** The example in flight. fast-check's time limit abandons a run part way
 * through, leaving it running, so the property abandons it here too before
 * it reports. */
let inFlight: { abandon(): void; finished: Promise<void> } | null = null;

/** One example: reset the server, start the clients, run the commands
 * (watching every cursor after each), bring everything to rest, and run
 * the oracle. The serial replay leaves the server in its replayed state,
 * which the next example's reset clears.
 *
 * However the body ends (passed, failed, hung or abandoned), the example
 * is then cancelled (cancel.ts) and its clients disposed, so a body still
 * running never reaches the server again. A dispose that fails or hangs is
 * appended to the body's failure, or fails a passing example itself. */
async function runExample(names: readonly string[], cmds: Commands,
                          opts: ExampleOptions = {}): Promise<void> {
  const clients = new Map<string, HarnessClient>();
  const transcript: string[] = [];
  const guard = cancellable(server);
  const body = async (): Promise<void> => {
    await guard.server.reset();
    const started: string[] = [];
    for (const [i, name] of names.entries()) {
      const at = opts.connectAt?.[i];
      const firstStart = opts.firstStart?.[i] ?? "ok";
      const c = await startClient(name, guard.server, undefined,
                                  { windowLimit: opts.windowLimit, signal: guard.signal },
                                  { connectAt: at, firstStart });
      if (guard.cancelled()) {
        // Cancelled while it started: the clean-up ran without it.
        await c.dispose();
        throw new ExampleCancelled(`${name} started after the example was cancelled`);
      }
      clients.set(name, c);
      count(`start ${connectTally(at, c.connectLanded())}`);
      if (firstStart !== "ok") {
        count("Fault snapshot5xx", firstStart === "fails" ? 2 : 1);
        count(`start first bootstrap ${firstStart}, ${
          c.hasStarted() ? "started by the first connect" : "not started by it"}`);
      }
      started.push((at === undefined ? name : `${name} (connect at tick ${at})`) +
                   (firstStart === "ok" ? "" : `, first bootstrap ${firstStart}`));
    }
    transcript.push(`start ${started.join(", ")}` +
      (opts.windowLimit === undefined ? "" : `, window limit ${opts.windowLimit}`));
    const model = initialModel([...names]);
    const banners = new BannerWatch();
    const world: World<HarnessClient> = {
      server: guard.server, clients, watch: new CursorWatch(), modes: new ModeWatch(),
      banners, transcript, count, cancelled: guard.cancelled,
    };
    const all = (): HarnessClient[] => [...clients.values()];
    world.watch.observe(all());
    await fc.asyncModelRun(() => ({ model, real: world }), cmds);
    // How each offline period still open ends: quiesce brings it online,
    // whether it was drawn until quiesce or the commands ran out before its
    // return.
    for (const name of names) {
      if (model.online[name]) continue;
      count(model.backAfter[name] === null ? "Online at quiesce"
                                           : "Online at quiesce, before its return");
    }
    await opts.beforeQuiesce?.(world);
    const dropped = await settleReplicas(world, model, banners, count);
    const fired = Object.entries(firedFaults(all())).filter(([, n]) => n > 0);
    if (fired.length > 0) {
      transcript.push(`faults fired: ${fired.map(([k, n]) => `${k} ${n}`).join(", ")}`);
    }
    transcript.push("quiesce");
    await quiesce(all(), guard.server, QUIESCE_LIMIT_MS);
    world.watch.observe(all());
    for (const c of all()) count(`Problem at settle: ${banners.check(c, "after quiesce")}`);
    for (const label of banners.seen) count(label);
    const snap = await guard.server.snapshot();
    if (snap.blocks.some((b) => b.text.includes("[[conflict]]"))) count("examples with a conflict");
    if (model.bad.size > 0) count("examples with a rejected batch");
    const applied = await guard.server.applied();
    const committed = new Map(all().flatMap((c) => [...c.transport.committed]));
    const deletes = await guard.server.deletes();
    if (deletes.length > 0 && staleNamers({ applied, deletes, committed }).length > 0) {
      count("examples with a stale batch naming a deleted page");
    }
    const conflicts = await guard.server.conflicts();
    if (conflicts.some((c) => overwrittenTarget(c.text) !== null)) {
      count("examples with an overwritten conflict");
    }
    // An overwritten conflict that is noise but for the lane exemption: the
    // one single-device cause the invariant allows.
    const noise = { applied, conflicts,
                    committedBy: new Map(all().map((c) => [c.name, c.transport.committed])) };
    const laneOnly = conflictNoise({ ...noise, lane: new Set(all().flatMap((c) => c.laneBatches)) });
    if (conflictNoise({ ...noise, lane: new Set() }).length > laneOnly.length) {
      count("examples with an overwritten conflict on a lane write");
    }
    if (laneOnly.length >
        conflictNoise({ ...noise, lane: conflictLane(all(), applied, model.good) }).length) {
      count("examples with an overwritten conflict behind an overtaking lost reply");
    }
    if ([...committed.values()].some((body) => leadsWithAttribute(body))) {
      count("examples with a leading attribute");
    }
    transcript.push("check");
    // A destroyed lane batch that never landed was lost by design.
    const landed = new Set(applied.map((r) => r.batch_id));
    const good = new Map([...model.good].map(([name, ids]) =>
      [name, ids.filter((id) => !dropped.has(id) || landed.has(id))]));
    await checkQuiescent(all(), guard.server, { good, bad: model.bad },
                         { applied, conflicts });
  };
  let abandon = (): void => undefined;
  const abandoned = new Promise<typeof ABANDONED>((resolve) => {
    abandon = () => resolve(ABANDONED);
  });
  const finished = (async (): Promise<void> => {
    const running = body();
    // An abandoned run may still fail later; its failure is already reported.
    running.catch(() => undefined);
    let failure: { error: unknown } | null = null;
    try {
      const outcome = await Promise.race([within(running, EXAMPLE_LIMIT_MS), abandoned]);
      if (outcome === TIMED_OUT) {
        throw new Error(`example did not finish in ${EXAMPLE_LIMIT_MS}ms (a command hung)`);
      }
      if (outcome === ABANDONED) {
        throw new Error("example abandoned: the property ran out of its time budget");
      }
    } catch (error: unknown) {
      failure = { error };
    }
    guard.cancel();
    for (const [kind, n] of Object.entries(firedFaults(clients.values()))) {
      if (n > 0) count(`Fault ${kind} fired`, n);
    }
    for (const c of clients.values()) {
      for (const fired of c.markFaultsFired) count(`BadBatch, mark ${fired}`);
    }
    countRecoveries(clients.values());
    const disposeProblem = await disposeAll([...clients.values()]);
    if (failure === null && disposeProblem === null) return;
    const head = failure === null ? `the example passed, but ${disposeProblem}`
                                  : showError(failure.error);
    const tail = failure !== null && disposeProblem !== null
      ? `\n-- disposing the clients --\n${disposeProblem}` : "";
    throw new Error(`${head}\n-- what each command did --\n${transcript.join("\n")}${tail}`,
                    { cause: failure?.error });
  })();
  inFlight = { abandon, finished };
  try {
    await finished;
  } finally {
    if (inFlight?.finished === finished) inFlight = null;
  }
}

/** A fixed scenario's op draft: top level, Proptest, key 0, unless given. */
const draft = (d: Partial<OpDraft> & Pick<OpDraft, "kind">): OpDraft =>
  ({ target: 0, parent: null, page: null, order: 0, text: "", collapsed: false, ...d });

test("reload during an in-flight post", async () => {
  await runExample(["A"], [
    new Edit("A", [draft({ kind: "update_text", text: "posted, then reloaded" })]),
    new Reload("A"),
  ]);
});

test("a nudge ahead of the journal", async () => {
  await runExample(["A"], [new Nudge("A", "ahead")], {
    beforeQuiesce: async (world) => {
      const a = world.clients.get("A");
      if (!a) throw new Error("no client A");
      await a.replicaSync.idle();
      expect(a.cursor()).toBeLessThanOrEqual(await world.server.latestSeq());
    },
  });
});

// The second BadBatch's edit waits for persistence, which gives the first
// one's rejection time to arrive and start the repair; going offline then
// cuts that repair's snapshot fetch off. The reconnect alone must retry it:
// quiesce's own online() would be a second reconnect, so the repair has to
// have succeeded before quiesce starts.
test("poison repair cut off by offline settles after reconnect", async () => {
  await runExample(["A"], [new BadBatch("A"), new BadBatch("A"), new Offline("A")], {
    beforeQuiesce: async (world) => {
      const a = world.clients.get("A");
      if (!a) throw new Error("no client A");
      const outcomes = (): string[] => a.syncEvents
        .filter((e) => e.type === "repair-failed" || e.type === "repair-succeeded")
        .map((e) => e.type);
      const failed = await within((async () => {
        while (!outcomes().includes("repair-failed")) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })(), REPRO_WAIT_MS);
      if (failed === TIMED_OUT) {
        throw new Error(`the repair never failed offline: ${outcomes().join(", ") || "none"}`);
      }
      world.transcript.push("Online(A)");
      await a.online();
      expect(outcomes()).toEqual(["repair-failed", "repair-succeeded"]);
    },
  });
});

// The ack of a two-move batch is lost after the server commits it, and the
// batch's own websocket nudge pulls before the queue's redelivery: the
// window already holds the batch while its row is still pending, so the
// replica must not replay it over its own effects.
test("lost ack, own nudge pulls before the redelivery", async () => {
  await runExample(["A"], [
    new Fault("A", "dropAck"),
    new Edit("A", [
      draft({ kind: "move", target: 3, order: 0 }),
      draft({ kind: "move", target: 3, order: 1 }),
    ]),
  ], {
    beforeQuiesce: async (world) => {
      const a = world.clients.get("A");
      if (!a) throw new Error("no client A");
      const committed = await within((async () => {
        while (a.transport.committed.size === 0) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      })(), REPRO_WAIT_MS);
      if (committed === TIMED_OUT) throw new Error("the batch never committed");
      // The race this scenario is about: still pending and sent once, so the
      // pull below lands before the redelivery, not after it.
      const [id] = a.transport.committed.keys();
      const pending = a.db.select(
        "SELECT COUNT(*) AS n FROM pending_ops", ["n"])[0].n;
      if (pending !== 1 || a.transport.sends(id) !== 1) {
        throw new Error(`the redelivery won the race: ${pending} pending,` +
                        ` ${a.transport.sends(id)} sends`);
      }
      world.transcript.push("Pull(A) before the redelivery");
      await a.pull();
    },
  });
});

/** Waits for a client's queue to drain: every batch it holds is acked. A
 * fixed scenario's step, never drawn by the property. */
class Drained extends SyncCommand {
  protected readonly kindName = "Drained";
  constructor(readonly client: string) { super(); }

  protected blocked(m: Readonly<SyncModel>): string | null {
    return m.clients.includes(this.client) ? null : "client not in this example";
  }

  protected async act(_m: SyncModel, w: World<HarnessClient>): Promise<string> {
    const c = w.clients.get(this.client);
    if (!c) throw new Error(`no client ${this.client}`);
    const pending = (): number => c.db.select(
      "SELECT COUNT(*) AS n FROM pending_ops", ["n"])[0].n;
    const drained = await within((async () => {
      while (pending() > 0 || c.unsentInMemory() > 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })(), REPRO_WAIT_MS);
    if (drained === TIMED_OUT) throw new Error(`${this.client} never drained`);
    return this.toString();
  }

  toString(): string { return `Drained(${this.client})`; }
}

/** The release of each client's held changes fetches (HoldPulls). */
const heldPulls = new Map<string, () => void>();

/** Holds the client's changes fetches until ReleasePulls, and arms its
 * worker to die at the next needs-bootstrap answer. A fixed scenario's
 * step, never drawn by the property. */
class HoldPulls extends SyncCommand {
  protected readonly kindName = "HoldPulls";
  constructor(readonly client: string) { super(); }
  protected blocked(m: Readonly<SyncModel>): string | null {
    return m.clients.includes(this.client) ? null : "client not in this example";
  }
  protected act(_m: SyncModel, w: World<HarnessClient>): Promise<string> {
    const c = clientIn(w, this.client);
    heldPulls.set(this.client, c.transport.stall("/api/sync/changes"));
    c.killOnNeedsBootstrap();
    return Promise.resolve(this.toString());
  }
  toString(): string { return `HoldPulls(${this.client})`; }
}

/** Lets the held fetches go and waits for the pull, which must have met a
 * needs-bootstrap answer and the death armed for it, then checks the mode:
 * a pass after that answer must have met the dead worker. */
class ReleasePulls extends SyncCommand {
  protected readonly kindName = "ReleasePulls";
  constructor(readonly client: string) { super(); }
  protected blocked(m: Readonly<SyncModel>): string | null {
    return m.clients.includes(this.client) ? null : "client not in this example";
  }
  protected async act(m: SyncModel, w: World<HarnessClient>): Promise<string> {
    const c = clientIn(w, this.client);
    heldPulls.get(this.client)?.();
    heldPulls.delete(this.client);
    await c.replicaSync.idle();
    // the scenario is about this death; without it the check is vacuous
    if (!c.workerDead()) throw new Error("the pull never met a needs-bootstrap answer");
    m.dead[this.client] = true;
    w.count("ReleasePulls: worker died at a needs-bootstrap left to poison");
    w.modes.afterPull(c);
    return `${this.toString()}: worker dead, mode ${c.mode()}`;
  }
  toString(): string { return `ReleasePulls(${this.client})`; }
}

// A's pull is held at its changes fetch while the generation rotates and a
// rejected batch's repair claims recovery. A nudge joins the held pull.
// Released, the pull's window needs a bootstrap, which it leaves to the
// repair, and the worker dies at that answer: the joined nudge's own pass
// must still run, meet the dead worker and end replica mode.
test("a nudge joined to a pull left to a poison repair gets its own pass", async () => {
  await runExample(["A"], [
    new HoldPulls("A"),
    new RotateGeneration(),
    new Nudge("A", "ahead"),
    new BadBatch("A"),
    new AwaitPoisonRepair("A"),
    new Nudge("A", "ahead"),
    new ReleasePulls("A"),
  ]);
});

// The pool's #3 is pt_seed_4 and #4 is pt_seed_5. A moves pt_seed_5 under
// pt_seed_4, gives it a child, then moves it back out and deletes
// pt_seed_4 in one batch; B pulls after each. B's last window carries
// pt_seed_4's tombstone and pt_seed_5's row but not the child's, whose row
// did not change: it has to survive pt_seed_4's local cascade.
/** The scenarios below name blocks by pool index. */
const assertPool = (): void => {
  expect(EDIT_TARGETS[3]).toBe("pt_seed_4");
  expect(EDIT_TARGETS[4]).toBe("pt_seed_5");
};

test("moved-out child survives its old parent's deletion on another device", async () => {
  assertPool();
  await runExample(["A", "B"], [
    new Edit("A", [draft({ kind: "move", target: 4, parent: 3 })]),
    new Drained("A"), new Pull("B"),
    new Edit("A", [draft({ kind: "create", parent: 4, text: "child" })]),
    new Drained("A"), new Pull("B"),
    new Edit("A", [draft({ kind: "move", target: 4 }),
                   draft({ kind: "create", text: "sibling" }),
                   draft({ kind: "delete", target: 3 })]),
    new Drained("A"), new Pull("B"),
  ]);
});

// The same deletion, read by a replica catching up one journal row per
// window: pt_seed_4's edit row lands in a window before pt_seed_5's move
// out. pt_seed_4 is already gone on the server by then, but its tombstone
// must wait for the window holding its delete row, or its local cascade
// takes the child, whose own row never changes.
test("moved-out child survives a window cut before its old parent's delete", async () => {
  assertPool();
  await runExample(["A", "B"], [
    new Edit("A", [draft({ kind: "move", target: 4, parent: 3 })]),
    new Edit("A", [draft({ kind: "create", parent: 4, text: "child" })]),
    new Drained("A"), new Pull("B"),
    new Edit("A", [draft({ kind: "update_text", target: 3, text: "edited" })]),
    new Edit("A", [draft({ kind: "move", target: 4 })]),
    new Edit("A", [draft({ kind: "delete", target: 3 })]),
    new Drained("A"), new Pull("B"),
  ], { windowLimit: 1 });
});

// A's poison repairs pause its queue, so quiesce's drain of A returns before
// A's last batch is posted, and the post commits while quiesce reads where
// everyone stands. Quiesce must not then call B settled at the old seq.
// The race is timing, so the scenario runs a number of times: read in the
// wrong order, it settled early in about one example in six.
test("quiesce waits for a batch a poison repair held back", async () => {
  for (let i = 0; i < 20; i += 1) {
    await runExample(["A", "B"], [
      new BadBatch("A"), new BadBatch("A"), new BadBatch("A"),
      new Edit("A", [draft({ kind: "move", target: 0, parent: 0, order: 28 })]),
      new Offline("B"),
    ]);
  }
});

// The scenarios below set up a create, move or rename that one side places
// on a different page from the other, or a page only one side has. Pool
// #0 to #4 are pt_seed_1 to pt_seed_5 and #5 to #7 pt_sec_1 to pt_sec_3;
// pages are named by title.
const page = (titleText: (typeof PAGE_TITLES)[number]): number =>
  PAGE_TITLES.indexOf(titleText);
const assertCrossPagePool = (): void => {
  expect(EDIT_TARGETS).toEqual(["pt_seed_1", "pt_seed_2", "pt_seed_3", "pt_seed_4",
                                "pt_seed_5", "pt_sec_1", "pt_sec_2", "pt_sec_3"]);
};

// A moves pt_sec_1 from Second to the top of Proptest. B, not having pulled
// that, moves it to the top of its own page with no title: the server
// shifts Proptest, where the block now is, while B's replica shifted
// Second, where it saw the block. Second's rows never change on the server,
// so nothing re-ships them and B keeps pt_sec_2 and pt_sec_3 one key up.
test("untitled top-level move of a block another device moved to another page", async () => {
  assertCrossPagePool();
  await runExample(["A", "B"], [
    new Edit("A", [draft({ kind: "move", target: 5, page: page("Proptest") })]),
    new Drained("A"),
    new Edit("B", [draft({ kind: "move", target: 5 })]),
    new Drained("B"),
  ]);
});

// A renames Proptest to Third and, before pulling the rename, moves
// pt_seed_1 to the top of "Proptest". The server finds no page by that
// title and creates one; A's replica still calls the renamed page Proptest
// and shifts its blocks, which the server never touched, so A keeps them
// one key up. A create on the old title does the same.
test("top-level move to a title renamed away before the pull", async () => {
  assertCrossPagePool();
  await runExample(["A"], [
    new Rename("A", page("Proptest"), page("Third")),
    new Edit("A", [draft({ kind: "move", target: 0, page: page("Proptest") })]),
  ]);
});

test("top-level create on a title renamed away before the pull", async () => {
  assertCrossPagePool();
  await runExample(["A"], [
    new Rename("A", page("Proptest"), page("Third")),
    new Edit("A", [draft({ kind: "create", page: page("Proptest"), text: "new" })]),
  ]);
});

// A creates a block on Fourth, which no page has yet: its replica makes a
// local page for the title and the server makes the real one. The real one
// is renamed Third before A pulls it, and a local page is reconciled with
// the feed's page by title, so the feed's Third arrives as a new page, the
// block follows it, and the emptied local Fourth stays in A's replica.
test("local page for a create whose page is renamed before the pull", async () => {
  assertCrossPagePool();
  await runExample(["A"], [
    new Edit("A", [draft({ kind: "create", page: page("Fourth"), text: "new" })]),
    new Drained("A"),
    new Rename("A", page("Fourth"), page("Third")),
  ]);
});

// B deletes pt_seed_1; A, not having pulled that, moves it to the top of
// Third, which no page has. The server skips the move of a gone block and,
// skipping it, creates no page; A's replica made a local Third for it,
// which nothing reconciles or removes once the delete arrives.
test("local page for a skipped top-level move to a new title", async () => {
  assertCrossPagePool();
  await runExample(["A", "B"], [
    new Edit("B", [draft({ kind: "delete", target: 0 })]),
    new Drained("B"),
    new Edit("A", [draft({ kind: "move", target: 0, page: page("Third") })]),
  ]);
});

// A moves pt_seed_4 to the top of Second and deletes it. B, not having
// pulled either, moves it to the top of its page with no title. The server
// skips the move of a gone block and re-ships the destination siblings it
// takes the move to have shifted: the top level of the page the block was
// on when it was deleted, Second. B's replica shifted Proptest, where it
// saw the block, and those rows are never re-shipped.
test("untitled top-level move of a block another device moved across pages and deleted", async () => {
  assertCrossPagePool();
  await runExample(["A", "B"], [
    new Edit("A", [draft({ kind: "move", target: 3, page: page("Second") })]),
    new Edit("A", [draft({ kind: "delete", target: 3 })]),
    new Drained("A"),
    new Edit("B", [draft({ kind: "move", target: 3 })]),
    new Drained("B"),
  ]);
});

// B deletes pt_seed_1. A, not having pulled that, moves it under pt_sec_1
// and then to the top level of its page with no title, in one batch. The
// server skips both moves of a gone block; for the second it re-ships the
// top level of the page the block was deleted from, Proptest. A's replica
// placed the block on Second under pt_sec_1 and then shifted Second's top
// level, which nothing re-ships.
test("untitled top-level move after a move to another page, of a block deleted elsewhere", async () => {
  assertCrossPagePool();
  await runExample(["A", "B"], [
    new Edit("B", [draft({ kind: "delete", target: 0 })]),
    new Drained("B"),
    new Edit("A", [draft({ kind: "move", target: 0, parent: 5 }),
                   draft({ kind: "move", target: 0 })]),
  ]);
});

// A deletes pt_sec_2. B, not having pulled that, moves pt_seed_2 under
// pt_sec_2 and then to the top level of its page with no title, in one
// batch. The server skips the first move (its parent is gone), so the
// second finds the block still on Proptest and shifts Proptest; B's replica
// applied the first, so the second shifted Second, which nothing re-ships.
test("untitled top-level move after the batch's own move under a parent deleted elsewhere", async () => {
  assertCrossPagePool();
  await runExample(["A", "B"], [
    new Edit("A", [draft({ kind: "delete", target: 6 })]),
    new Drained("A"),
    new Edit("B", [draft({ kind: "move", target: 1, parent: 6 }),
                   draft({ kind: "move", target: 1 })]),
  ]);
});

// pt_seed_2 is pt_seed_1's child on Proptest, on both clients. A moves
// pt_sec_1 from Second to Proptest; B, not having pulled that, moves
// pt_seed_1 under pt_sec_1. B's replica takes pt_seed_1 and its subtree to
// Second, where it saw pt_sec_1; on the server pt_seed_1 stays on its page,
// so pt_seed_2's row never changes, and the feed corrects pt_seed_1's page
// but never pt_seed_2's.
test("move under a parent another device moved to the block's own page", async () => {
  assertCrossPagePool();
  await runExample(["A", "B"], [
    new Edit("A", [draft({ kind: "move", target: 1, parent: 0 })]),
    new Drained("A"), new Pull("B"),
    new Edit("A", [draft({ kind: "move", target: 5, page: page("Proptest") })]),
    new Drained("A"),
    new Edit("B", [draft({ kind: "move", target: 0, parent: 5 })]),
    new Drained("B"),
  ]);
});

/** The delete-cascade scenarios also name blocks on the Second page. */
const assertSecondPool = (): void => {
  expect(EDIT_TARGETS[0]).toBe("pt_seed_1");
  expect(EDIT_TARGETS[5]).toBe("pt_sec_1");
  expect(EDIT_TARGETS[7]).toBe("pt_sec_3");
};

// Pool: #0 = pt_seed_1 (page Proptest), #5 = pt_sec_1, #7 = pt_sec_3 (page
// Second). A nests sec_1 > sec_3 > seed_1, both batches acked and their echo
// pulled. Offline, A deletes sec_1: the local cascade takes sec_3 and
// seed_1. C meanwhile moves sec_3 to the top level of Second, so the
// server's later delete removes sec_1 alone. The feed ships sec_3 (C's move)
// and sec_1's tombstone; seed_1's row never changes again, so nothing
// re-ships it and A has to restore it from the cascade it recorded.
test("offline delete of a parent whose child another device moved out", async () => {
  assertSecondPool();
  await runExample(["A", "C"], [
    new Edit("A", [draft({ kind: "move", target: 0, parent: 7 })]),
    new Edit("A", [draft({ kind: "move", target: 7, parent: 5 })]),
    new Drained("A"), new Pull("A"), new Pull("C"),
    new Offline("A"),
    new Edit("A", [draft({ kind: "delete", target: 5 })]),
    new Edit("C", [draft({ kind: "move", target: 7 })]),
    new Drained("C"),
  ]);
});

// A's cursor is still behind its first batch's echo when it goes offline.
// The later window re-ships seed_1's row from A's own move, so the replica
// converges even without the recorded cascade.
test("offline delete of a parent whose child another device moved out, own echo not yet pulled", async () => {
  assertSecondPool();
  await runExample(["A", "C"], [
    new Edit("A", [draft({ kind: "move", target: 0, parent: 7 })]),
    new Edit("A", [draft({ kind: "move", target: 7, parent: 5 })]),
    new Drained("A"), new Pull("C"),
    new Offline("A"),
    new Edit("A", [draft({ kind: "delete", target: 5 })]),
    new Edit("C", [draft({ kind: "move", target: 7 })]),
    new Drained("C"),
  ]);
});

// The nesting is made by C, not A: C moves sec_3 under sec_1 and seed_1
// under sec_3, then A pulls, so the replica's view is server-made rather
// than built from A's own batches.
test("offline delete of a parent whose child another device moved out, nesting made by the other device", async () => {
  assertSecondPool();
  await runExample(["A", "C"], [
    new Edit("C", [draft({ kind: "move", target: 0, parent: 7 })]),
    new Edit("C", [draft({ kind: "move", target: 7, parent: 5 })]),
    new Drained("C"), new Pull("A"), new Pull("C"),
    new Offline("A"),
    new Edit("A", [draft({ kind: "delete", target: 5 })]),
    new Edit("C", [draft({ kind: "move", target: 7 })]),
    new Drained("C"),
  ]);
});

// A sets pt_seed_1's text to link [[Second]] while B renames Second to
// Third, unsynchronised. When the batch commits between the rename's read
// of the blocks that reference Second and its write, the rename lands
// after the batch (the batch's link points at the renamed page) without
// rewriting that block's text, which the serial replay of the same order
// does rewrite. The race is timing, so the scenario runs a number of times.
test("rename racing a batch that links the renamed page", async () => {
  for (let i = 0; i < 20; i += 1) {
    await runExample(["A", "B"], [
      new Edit("A", [draft({ kind: "update_text", target: 0, text: "[[Second]]" })]),
      new Rename("B", page("Second"), page("Third")),
    ]);
  }
});

// A's worker dies with a batch on the wire. The next edit goes to the lane
// and is delivered online; once a pull meets the dead worker A is
// online-only, so offline its editor is read-only.
test("a worker that dies mid-session ends offline editing after one pull", async () => {
  await runExample(["A"], [
    new Edit("A", [draft({ kind: "update_text", text: "before the death" })]),
    new WorkerDies("A"),
    new Edit("A", [draft({ kind: "update_text", target: 1, text: "into the lane" })]),
    new Pull("A"),
    new Offline("A"),
    new Edit("A", [draft({ kind: "update_text", target: 2, text: "refused" })]),
  ]);
});

// A's durable row is still queued offline when its worker dies, and nothing
// has pulled since, so the later offline edit is accepted into the lane. At
// settle the lane delivers first and the durable row after the reload.
test("a dead worker's durable rows land after its lane, at the next life", async () => {
  await runExample(["A", "B"], [
    new Offline("A"),
    new Edit("A", [draft({ kind: "update_text", text: "durable, offline" })]),
    new WorkerDies("A"),
    new Edit("A", [draft({ kind: "update_text", text: "lane, offline" })]),
    new Edit("B", [draft({ kind: "update_text", target: 1, text: "B meanwhile" })]),
  ]);
});

// A's first two snapshot fetches answer 503: the mount's start and the first
// connect's both fail, and only the backoff can start it before quiesce.
test("a first bootstrap that fails with the socket up is retried by the backoff", async () => {
  await runExample(["A", "B"], [
    new Edit("B", [draft({ kind: "update_text", text: "B edits" })]),
  ], { firstStart: ["fails", "timesOut"] });
});

/** An example's clients and the commands drawn for exactly those. */
type Drawn = [number, Commands];
/** Each client's first connect, by client order (ExampleOptions). */
type Starts = [number | undefined, number | undefined, number | undefined];

const starts: fc.Arbitrary<Starts> = fc.tuple(connectTiming, connectTiming, connectTiming);

/** One first bootstrap in five fails, half of those by a 503 on its first two
 * snapshot fetches and half by an applySnapshot reply that times out. */
const firstStart: fc.Arbitrary<FirstStart> = fc.oneof(
  { weight: 8, arbitrary: fc.constant<FirstStart>("ok") },
  { weight: 1, arbitrary: fc.constant<FirstStart>("fails") },
  { weight: 1, arbitrary: fc.constant<FirstStart>("timesOut") },
);
type FirstStarts = [FirstStart, FirstStart, FirstStart];
const firstStarts: fc.Arbitrary<FirstStarts> = fc.tuple(firstStart, firstStart, firstStart);

/** Fails the scenario unless the banner rules it is about were checked:
 * the property draws them too rarely to floor. */
const expectBannerRules = (rules: readonly string[]) =>
  (world: World<HarnessClient>): Promise<void> => {
    const missing = rules.filter((r) => !world.banners.seen.has(`Banner rule: ${r}`));
    if (missing.length > 0) {
      throw new Error(`the scenario never reached ${missing.join(", ")}; seen: ${
        [...world.banners.seen].join(", ")}`);
    }
    return Promise.resolve();
  };

// A's feed recovery after the rotation meets a 503 snapshot while the socket
// is up, which raises the stalled banner. Then A's worker dies: Reset needs
// the replica, so the next pull's no-replica report replaces the banner.
test("a stalled banner gives way to the online-only one when the worker dies", async () => {
  await runExample(["A"], [
    new Fault("A", "snapshot5xx"), new RotateGeneration(), new Pull("A"),
    new WorkerDies("A"), new Pull("A"),
  ], { beforeQuiesce: expectBannerRules(["gone over stalled"]) });
});

// A's poison repair is held at its snapshot while A's worker dies; let go,
// the repair meets the dead worker. Its Retry cannot work without one, so
// the online-only banner replaces it, paused while the poison claim holds.
test("a poison repair the worker dies under gives way to the online-only banner", async () => {
  await runExample(["A"], [
    new HoldSnapshots("A"), new BadBatch("A"), new AwaitPoisonRepair("A"),
    new WorkerDies("A"), new ReleaseSnapshots("A"),
  ], { beforeQuiesce: expectBannerRules(["gone over running"]) });
});

/** Two or three clients, equally often. Each branch draws its commands
 * from its own clients alone, so no draw names a client the example lacks.
 * A oneof of whole examples rather than a chain from the count (a chain
 * redraws the commands when the count shrinks). The client count itself does
 * not shrink: fc.oneof without cross-shrink never takes a 3-client example to
 * 2. A 3-client counterexample whose bug needs two still starts C, but the
 * shrinker removes C's commands, so an idle C shows in the report. An integer
 * count with C's commands remapped onto the started clients was rejected: the
 * printed commands would name a client other than the one they acted on. */
const clientsAndCommands: fc.Arbitrary<Drawn> = fc.oneof(
  ...[2, 3].map((n) => fc.tuple(fc.constant(n), fc.commands(
    commandsFor(NAMES.slice(0, n)),
    { maxCommands: MAX_COMMANDS, size: "max", replayPath: REPLAY_PATH }))),
);

/** The started clients' first-connect timings, for the report. */
const showStarts = (n: number, at: Starts): string =>
  NAMES.slice(0, n).map((name, i) =>
    `${name} ${at[i] === undefined ? "after startup" : `tick ${at[i]}`}`).join(", ");

/** The counterexample as the report shows it. */
const show = ([[n, cmds], limit, at, first]: [Drawn, number | undefined, Starts, FirstStarts]):
    string =>
  `counterexample: ${n} clients, ` +
  (limit === undefined ? "no window limit" : `window limit ${limit}`) +
  `, connect at ${showStarts(n, at)}` +
  `, first bootstraps ${first.slice(0, n).join(", ")}` +
  `, ${String(cmds)}`;

test("sync protocol property", async () => {
  await checkGateProperty({
    suite: "sync property", file: "sync/sync.prop.ts",
    // A new arbitrary goes last: an arbitrary's place fixes what a seed and
    // path replay, so the ones before it replay as they did before it was
    // added.
    arbs: [clientsAndCommands, windowLimit, starts, firstStarts],
    predicate: async ([n, cmds], limit, at, first) => {
      count(`examples with ${n} clients`);
      count(limit === undefined ? "examples with no window limit"
                                : `examples with window limit ${limit}`);
      await runExample(NAMES.slice(0, n), cmds,
                       { windowLimit: limit, connectAt: at, firstStart: first });
    },
    numRuns: NUM_RUNS, limitMs: PROPERTY_LIMIT_MS, show,
    tally, showTally: showSyncTally, reach: REACH,
    // The example the time limit cut into is still running: stop it before
    // anything is reported, and before the next file resets the server.
    settle: async () => {
      if (inFlight === null) return;
      inFlight.abandon();
      await within(inFlight.finished.catch(() => undefined), DISPOSE_LIMIT_MS * 2);
    },
  });
});
