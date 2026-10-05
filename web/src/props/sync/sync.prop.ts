// pattern: Imperative Shell
// The sync protocol property: 2-3 clients running the real web sync stack
// against the real server take a random sequence of edits and faults, then
// are brought to rest and checked by the oracle. One example in three caps
// the changes feed's window at a few journal rows, so a catch-up crosses
// window boundaries (see windowLimit). Half the time a client's first
// connect, and a Reload's, comes at a drawn tick of its startup rather than
// after it (connectTiming in commands.ts). Seventeen fixed scenarios run first,
// through the same commands.
//
// A failure prints the seed, the path, the shrunk command list, what each
// command did in the failing run, the oracle's findings and a replay line.
// How often each command ran or was skipped by its precondition, and how
// often each fault was armed and fired, is printed once, after the file.
import fc from "fast-check";
import { afterAll, beforeAll, expect, test } from "vitest";
import { EDIT_TARGETS, type OpDraft, PAGE_TITLES } from "./arbitraries";
import { cancellable, ExampleCancelled } from "./cancel";
import { BadBatch, commandsFor, connectTally, connectTiming, countSkipsWith, Edit,
         Fault, type FaultKind, NAMES, Nudge, Offline, Pull, Reload, Rename, SyncCommand,
         type World } from "./commands";
import { PATH, REPLAY_PATH, SEED } from "./env";
import { startClient, type HarnessClient } from "./harnessClient";
import { initialModel, type SyncModel } from "./model";
import { checkQuiescent, CursorWatch } from "./oracle";
import { quiesce, TIMED_OUT, within } from "./quiesce";
import { connectServer, type ServerControl } from "./serverControl";

/** Examples per gate run, sized so `proptest/check.sh web` takes about
 * three minutes. */
export const NUM_RUNS = 2100;
const MAX_COMMANDS = 30;
const QUIESCE_LIMIT_MS = 30_000;
/** One example, commands to oracle: well past the quiesce limit, so a
 * liveness failure is quiesce's to report. A command that hangs is caught
 * here instead, as a failing example fast-check can shrink. */
const EXAMPLE_LIMIT_MS = 90_000;
/** The whole property, shrinking included. fast-check abandons the example
 * the limit cuts into, which the property then cancels. Cut off while
 * shrinking, it fails with the smallest counterexample so far; cut off
 * before any failure, it fails as a budget problem, never as a finding. The
 * margin to vitest's testTimeout (vitest.props.config.ts) covers that
 * example's clean-up and the report, so vitest never cuts a report off. */
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
      const c = await startClient(name, guard.server, undefined,
                                  { windowLimit: opts.windowLimit, signal: guard.signal },
                                  { connectAt: at });
      if (guard.cancelled()) {
        // Cancelled while it started: the clean-up ran without it.
        await c.dispose();
        throw new ExampleCancelled(`${name} started after the example was cancelled`);
      }
      clients.set(name, c);
      count(`start ${connectTally(at, c.connectLanded())}`);
      started.push(at === undefined ? name : `${name} (connect at tick ${at})`);
    }
    transcript.push(`start ${started.join(", ")}` +
      (opts.windowLimit === undefined ? "" : `, window limit ${opts.windowLimit}`));
    const model = initialModel([...names]);
    const world: World = {
      server: guard.server, clients, watch: new CursorWatch(), transcript, count,
      cancelled: guard.cancelled,
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
    const fired = Object.entries(firedFaults(all())).filter(([, n]) => n > 0);
    if (fired.length > 0) {
      transcript.push(`faults fired: ${fired.map(([k, n]) => `${k} ${n}`).join(", ")}`);
    }
    transcript.push("quiesce");
    await quiesce(all(), guard.server, QUIESCE_LIMIT_MS);
    world.watch.observe(all());
    const snap = await guard.server.snapshot();
    if (snap.blocks.some((b) => b.text.includes("[[conflict]]"))) count("examples with a conflict");
    if (model.bad.size > 0) count("examples with a rejected batch");
    transcript.push("check");
    await checkQuiescent(all(), guard.server, model);
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
  ({ target: 0, parent: null, page: null, orderIdx: 0, text: "", collapsed: false, ...d });

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
      draft({ kind: "move", target: 3, orderIdx: 0 }),
      draft({ kind: "move", target: 3, orderIdx: 1 }),
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

// The scenarios below set up a create, move or rename that one side places
// on a different page from the other, or a page only one side has. Pool
// #0 to #4 are pt_seed_1 to pt_seed_5 and #5 to #7 pt_sec_1 to pt_sec_3;
// pages are named by title.
const page = (title: (typeof PAGE_TITLES)[number]): number => PAGE_TITLES.indexOf(title);
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

/** An example's clients and the commands drawn for exactly those. */
type Drawn = [number, Commands];
/** Each client's first connect, by client order (ExampleOptions). */
type Starts = [number | undefined, number | undefined, number | undefined];

const starts: fc.Arbitrary<Starts> = fc.tuple(connectTiming, connectTiming, connectTiming);

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
      (details.interrupted ? " (shrinking cut off at the time limit: the smallest" +
                             " counterexample so far)" : ""),
    `seed: ${details.seed}`,
    `path: ${details.counterexamplePath ?? "none"}`,
    `counterexample: ${shown}`,
    `error: ${error}`,
    `replay: proptest/check.sh web --file sync/sync.prop.ts --seed ${details.seed}` +
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
    interruptAfterTimeLimit: PROPERTY_LIMIT_MS, markInterruptAsFailure: false,
  });
  // The example the time limit cut into is still running: stop it before
  // anything is reported, and before the next file resets the server.
  if (inFlight !== null) {
    inFlight.abandon();
    await within(inFlight.finished.catch(() => undefined), DISPOSE_LIMIT_MS * 2);
  }
  // A failure keeps failed set when the time limit cuts its shrinking off,
  // with the smallest counterexample so far. Cut off before any failure,
  // fast-check reports interrupted, and failed as well if no example had
  // finished, but with no counterexample: either way that is the budget.
  if (details.failed && details.counterexample !== null) {
    const text = report(details);
    console.error(text);
    throw new Error(text);
  }
  if (details.interrupted) {
    const text = `sync property ran out of its time budget after ${details.numRuns} of` +
      ` ${NUM_RUNS} runs (no failure found): a budget problem, not a finding\n` +
      `seed: ${details.seed}`;
    console.error(text);
    throw new Error(text);
  }
  if (details.failed) {
    const text = report(details);
    console.error(text);
    throw new Error(text);
  }
});
