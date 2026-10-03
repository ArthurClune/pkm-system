// pattern: Imperative Shell
// The sync protocol property: 2-3 clients running the real web sync stack
// against the real server take a random sequence of edits and faults, then
// are brought to rest and checked by the oracle. Five fixed scenarios run
// first, through the same commands.
//
// A failure prints the seed, the path, the shrunk command list, what each
// command did in the failing run, the oracle's findings and a replay line.
// How often each command and fault ran is printed once, after the file.
import fc from "fast-check";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { OpDraft } from "./arbitraries";
import { allCommands, BadBatch, Edit, Fault, NAMES, Nudge, Offline, Pull, Reload,
         SyncCommand, type World } from "./commands";
import { PATH, REPLAY_PATH, SEED } from "./env";
import { startClient, type HarnessClient } from "./harnessClient";
import { initialModel, type SyncModel } from "./model";
import { checkQuiescent, CursorWatch } from "./oracle";
import { quiesce, TIMED_OUT, within } from "./quiesce";
import { connectServer, type ServerControl } from "./serverControl";

/** Examples per gate run, sized so `proptest/check.sh web` takes about
 * three minutes. */
export const NUM_RUNS = 5;
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
const count = (key: string): void => { tally.set(key, (tally.get(key) ?? 0) + 1); };

let server: ServerControl;

beforeAll(async () => {
  server = await connectServer();
});

afterAll(() => {
  const width = Math.max(0, ...[...tally.keys()].map((k) => k.length));
  console.log(`sync property tally (every run, shrinks included):\n${
    [...tally].sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `  ${k.padEnd(width)}  ${n}`).join("\n")}`);
});

interface ExampleOptions {
  /** Runs after the commands, before quiescence. */
  beforeQuiesce?: (world: World) => Promise<void>;
}

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
    for (const name of names) clients.set(name, await startClient(name, server));
    transcript.push(`start ${names.join(", ")}`);
    const model = initialModel([...names]);
    const world: World = { server, clients, watch: new CursorWatch(), transcript, count };
    const all = (): HarnessClient[] => [...clients.values()];
    world.watch.observe(all());
    await fc.asyncModelRun(() => ({ model, real: world }), cmds);
    await opts.beforeQuiesce?.(world);
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
  constructor(readonly client: string) { super(); }

  check(m: Readonly<SyncModel>): boolean {
    return m.clients.includes(this.client);
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
test("moved-out child survives its old parent's deletion on another device", async () => {
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

/** The failure report: everything needed to read and replay it. */
function report(details: fc.RunDetails<[number, Commands]>): string {
  const counterexample = details.counterexample;
  const shown = counterexample === null ? "none"
    : `${counterexample[0]} clients, ${String(counterexample[1])}`;
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
    fc.integer({ min: 2, max: 3 }),
    fc.commands(allCommands, {
      maxCommands: MAX_COMMANDS, size: "max", replayPath: REPLAY_PATH,
    }),
    async (n, cmds) => {
      count("examples");
      count(`examples with ${n} clients`);
      await runExample(NAMES.slice(0, n), cmds);
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
