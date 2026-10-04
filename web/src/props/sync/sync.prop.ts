// pattern: Imperative Shell
// The sync protocol property: 2-3 clients running the real web sync stack
// against the real server take a random sequence of edits and faults, then
// are brought to rest and checked by the oracle. One example in three caps
// the changes feed's window at a few journal rows, so a catch-up crosses
// window boundaries (see windowLimit). Half the time a client's first
// connect, and a Reload's, comes at a drawn tick of its startup rather than
// after it (connectTiming in commands.ts). Seven fixed scenarios run first,
// through the same commands.
//
// A failure prints the seed, the path, the shrunk command list, what each
// command did in the failing run, the oracle's findings and a replay line.
// How often each command ran or was skipped by its precondition, and how
// often each fault was armed and fired, is printed once, after the file.
import fc from "fast-check";
import { afterAll, beforeAll, expect, test } from "vitest";
import { EDIT_TARGETS, type OpDraft } from "./arbitraries";
import { BadBatch, commandsFor, connectTally, connectTiming, countSkipsWith, Edit,
         Fault, type FaultKind, NAMES, Nudge, Offline, Pull, Reload, SyncCommand,
         type World } from "./commands";
import { PATH, REPLAY_PATH, SEED } from "./env";
import { startClient, type HarnessClient } from "./harnessClient";
import { initialModel, type SyncModel } from "./model";
import { checkQuiescent, CursorWatch } from "./oracle";
import { quiesce, TIMED_OUT, within } from "./quiesce";
import { connectServer, type ServerControl } from "./serverControl";

/** Examples per gate run, sized so `proptest/check.sh web` takes about
 * three minutes. */
export const NUM_RUNS = 3200;
const MAX_COMMANDS = 30;
const QUIESCE_LIMIT_MS = 30_000;
/** One example, commands to oracle: well past the quiesce limit, so a
 * liveness failure is quiesce's to report. A command that hangs is caught
 * here instead, as a failing example fast-check can shrink. */
const EXAMPLE_LIMIT_MS = 90_000;
/** The whole property, shrinking included. Interrupted, it fails with the
 * smallest counterexample so far; the margin to vitest's testTimeout
 * (vitest.props.config.ts) covers the example in flight, so vitest never
 * cuts a report off. */
const PROPERTY_LIMIT_MS = 420_000;
const DISPOSE_LIMIT_MS = 10_000;
/** How long a fixed scenario waits for the state it sets up. */
const REPRO_WAIT_MS = 5_000;

type Commands = Iterable<fc.AsyncCommand<SyncModel, World, boolean>>;

const tally = new Map<string, number>();
const count = (key: string, n = 1): void => { tally.set(key, (tally.get(key) ?? 0) + n); };
countSkipsWith(count);

const FAULT_KINDS: readonly FaultKind[] = ["dropAck", "duplicate", "lostPull", "writeFails"];

/** How many of each fault kind fired across these clients: transport faults
 * that met a request, and failed local writes that pushed a batch into the
 * lane. */
const firedFaults = (clients: Iterable<HarnessClient>): Record<FaultKind, number> => {
  const fired: Record<FaultKind, number> = { dropAck: 0, duplicate: 0, lostPull: 0, writeFails: 0 };
  for (const c of clients) {
    fired.dropAck += c.transport.fired("dropAck");
    fired.duplicate += c.transport.fired("duplicate");
    fired.lostPull += c.transport.fired("lostPull");
    fired.writeFails += c.lanePushes();
  }
  return fired;
};

let server: ServerControl;

beforeAll(async () => {
  server = await connectServer();
});

/** Fault rows read armed and fired side by side; everything else is one
 * count per key. */
afterAll(() => {
  const isFault = (k: string): boolean => /^Fault \S+( fired)?$/.test(k);
  const rest = [...tally].filter(([k]) => !isFault(k));
  const width = Math.max(0, ...rest.map(([k]) => k.length));
  const faults = FAULT_KINDS.map((kind) =>
    `  Fault ${kind.padEnd(10)}  armed ${String(tally.get(`Fault ${kind}`) ?? 0).padStart(6)}` +
    `  fired ${String(tally.get(`Fault ${kind} fired`) ?? 0).padStart(6)}`);
  console.log(`sync property tally (every run, shrinks included):\n${
    rest.sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `  ${k.padEnd(width)}  ${n}`).join("\n")}\n${faults.join("\n")}`);
});

interface ExampleOptions {
  /** Runs after the commands, before quiescence. */
  beforeQuiesce?: (world: World) => Promise<void>;
  /** Every client's changes-feed window, in journal rows; absent, the
   * server's default. */
  windowLimit?: number;
  /** Each client's first connect, by client order, in ticks after its
   * mount begins (StartOptions); absent, once its startup has finished. */
  connectAt?: readonly (number | undefined)[];
}

/** No cap two times in three, else a window of one to five journal rows:
 * small enough that a catch-up over a few edits crosses several window
 * boundaries, where block tombstones wait for the window at the journal
 * head (see "The changes feed" in docs/architecture/sync-and-offline.md). */
const windowLimit: fc.Arbitrary<number | undefined> = fc.oneof(
  { weight: 2, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 5 }) },
);

/** One example: reset the server, start the clients, run the commands
 * (watching every cursor after each), bring everything to rest, and run
 * the oracle. The serial replay leaves the server in its replayed state,
 * which the next example's reset clears. */
async function runExample(names: readonly string[], cmds: Commands,
                          opts: ExampleOptions = {}): Promise<void> {
  const clients = new Map<string, HarnessClient>();
  const transcript: string[] = [];
  const body = async (): Promise<void> => {
    await server.reset();
    const started: string[] = [];
    for (const [i, name] of names.entries()) {
      const at = opts.connectAt?.[i];
      const c = await startClient(name, server, undefined,
                                  { windowLimit: opts.windowLimit }, { connectAt: at });
      clients.set(name, c);
      count(`start ${connectTally(at, c.connectLanded())}`);
      started.push(at === undefined ? name : `${name} (connect at tick ${at})`);
    }
    transcript.push(`start ${started.join(", ")}` +
      (opts.windowLimit === undefined ? "" : `, window limit ${opts.windowLimit}`));
    const model = initialModel([...names]);
    const world: World = { server, clients, watch: new CursorWatch(), transcript, count };
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
    const fired = Object.entries(firedFaults(all())).filter(([, n]) => n > 0);
    if (fired.length > 0) {
      transcript.push(`faults fired: ${fired.map(([k, n]) => `${k} ${n}`).join(", ")}`);
    }
    transcript.push("quiesce");
    await quiesce(all(), server, QUIESCE_LIMIT_MS);
    world.watch.observe(all());
    const snap = await server.snapshot();
    if (snap.blocks.some((b) => b.text.includes("[[conflict]]"))) count("examples with a conflict");
    if (model.bad.size > 0) count("examples with a rejected batch");
    transcript.push("check");
    await checkQuiescent(all(), server, model);
  };
  const running = body();
  // An abandoned run may still fail later; its failure is already reported.
  running.catch(() => undefined);
  try {
    const outcome = await within(running, EXAMPLE_LIMIT_MS);
    if (outcome === TIMED_OUT) {
      throw new Error(`example did not finish in ${EXAMPLE_LIMIT_MS}ms (a command hung)`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(`${message}\n-- what each command did --\n${transcript.join("\n")}`,
                    { cause: error });
  } finally {
    for (const [kind, n] of Object.entries(firedFaults(clients.values()))) {
      if (n > 0) count(`Fault ${kind} fired`, n);
    }
    const disposed = Promise.all([...clients.values()].map((c) => c.dispose()));
    disposed.catch(() => undefined);
    await within(disposed, DISPOSE_LIMIT_MS);
  }
}

test("reload during an in-flight post", async () => {
  await runExample(["A"], [
    new Edit("A", [{ kind: "update_text", target: 0, parent: null, orderIdx: 0,
                     text: "posted, then reloaded", collapsed: false }]),
    new Reload("A"),
  ]);
});

test("a nudge ahead of the journal", async () => {
  await runExample(["A"], [new Nudge("A", "ahead")], {
    beforeQuiesce: async (world) => {
      const a = world.clients.get("A");
      if (!a) throw new Error("no client A");
      await a.replicaSync.idle();
      expect(a.cursor()).toBeLessThanOrEqual(await server.latestSeq());
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
      { kind: "move", target: 3, parent: null, orderIdx: 0, text: "", collapsed: false },
      { kind: "move", target: 3, parent: null, orderIdx: 1, text: "", collapsed: false },
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
      const pending = a.db.select<{ n: number }>(
        "SELECT COUNT(*) AS n FROM pending_ops")[0].n;
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

  protected async act(_m: SyncModel, w: World): Promise<string> {
    const c = w.clients.get(this.client);
    if (!c) throw new Error(`no client ${this.client}`);
    const pending = (): number => c.db.select<{ n: number }>(
      "SELECT COUNT(*) AS n FROM pending_ops")[0].n;
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

const draft = (d: Partial<OpDraft> & Pick<OpDraft, "kind">): OpDraft =>
  ({ target: 0, parent: null, orderIdx: 0, text: "", collapsed: false, ...d });

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
      new Edit("A", [draft({ kind: "move", target: 0, parent: 0, orderIdx: 28 })]),
      new Offline("B"),
    ]);
  }
});

/** An example's clients and the commands drawn for exactly those. */
type Drawn = [number, Commands];
/** Each client's first connect, by client order (ExampleOptions). */
type Starts = [number | undefined, number | undefined, number | undefined];

const starts: fc.Arbitrary<Starts> = fc.tuple(connectTiming, connectTiming, connectTiming);

/** Two or three clients, equally often. Each branch draws its commands
 * from its own clients alone, so no draw names a client the example lacks.
 * A oneof of whole examples rather than a chain from the count: a chain
 * redraws the commands when the count shrinks, so it shrinks badly. */
const clientsAndCommands: fc.Arbitrary<Drawn> = fc.oneof(
  ...[2, 3].map((n) => fc.tuple(fc.constant(n), fc.commands(
    commandsFor(NAMES.slice(0, n)),
    { maxCommands: MAX_COMMANDS, size: "max", replayPath: REPLAY_PATH }))),
);

/** The started clients' first-connect timings, for the report. */
const showStarts = (n: number, at: Starts): string =>
  NAMES.slice(0, n).map((name, i) =>
    `${name} ${at[i] === undefined ? "after startup" : `tick ${at[i]}`}`).join(", ");

/** The failure report: everything needed to read and replay it. */
function report(details: fc.RunDetails<[Drawn, number | undefined, Starts]>): string {
  const counterexample = details.counterexample;
  const shown = counterexample === null ? "none"
    : `${counterexample[0][0]} clients, ` +
      (counterexample[1] === undefined ? "no window limit"
                                       : `window limit ${counterexample[1]}`) +
      `, connect at ${showStarts(counterexample[0][0], counterexample[2])}` +
      `, ${String(counterexample[0][1])}`;
  const replay = /replayPath="([^"]*)"/.exec(shown)?.[1];
  const error = details.errorInstance instanceof Error
    ? details.errorInstance.message : String(details.errorInstance);
  return [
    `sync property failed after ${details.numRuns} runs and ${details.numShrinks} shrinks` +
      (details.interrupted ? " (interrupted at the time limit)" : ""),
    `seed: ${details.seed}`,
    `path: ${details.counterexamplePath ?? "none"}`,
    `counterexample: ${shown}`,
    `error: ${error}`,
    `replay: proptest/check.sh web --seed ${details.seed}` +
      (details.counterexamplePath ? ` --path '${details.counterexamplePath}'` : "") +
      (replay ? ` --replay-path '${replay}'` : ""),
  ].join("\n");
}

test("sync protocol property", async () => {
  const details = await fc.check(fc.asyncProperty(
    clientsAndCommands,
    // A new arbitrary goes last: an arbitrary's place fixes what a seed and
    // path replay, so the ones before it replay as they did before it was
    // added.
    windowLimit,
    starts,
    async ([n, cmds], limit, at) => {
      count("examples");
      count(`examples with ${n} clients`);
      count(limit === undefined ? "examples with no window limit"
                                : `examples with window limit ${limit}`);
      await runExample(NAMES.slice(0, n), cmds, { windowLimit: limit, connectAt: at });
    },
  ), {
    numRuns: NUM_RUNS, seed: SEED, path: PATH,
    interruptAfterTimeLimit: PROPERTY_LIMIT_MS, markInterruptAsFailure: true,
  });
  if (details.failed) {
    const text = report(details);
    console.error(text);
    throw new Error(text);
  }
});
