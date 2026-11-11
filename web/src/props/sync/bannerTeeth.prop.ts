// pattern: Imperative Shell
// Does the banner check have teeth? Each mutant bends transitionSync's
// result on one rule of sync-recovery.md § What the UI shows, and a fixed
// scenario that reaches the rule must then fail BannerWatch; run clean, the
// same scenario must pass. The property draws some of these paths too
// rarely to rely on, so each scenario reaches its rule by construction.
//   paused dropped   the online-only banner never says delivery is paused
//   kept replaced    the replica gone, a failed mark's banner is replaced,
//                    though its Discard needs no worker
//   not back         the online-only banner does not return when a kept
//                    problem ends
//   stall kept       a stalled banner survives the replica's loss
//   running kept     a running repair's banner survives the replica's loss
import fc from "fast-check";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { SyncProblem, SyncState } from "../../sync/syncState";
import { BadBatch, Discard, Fault, Pull, Reload, RotateGeneration, type SyncCommand,
         WorkerDies, type World } from "./commands";
import { type HarnessClient, startClient } from "./harnessClient";
import { initialModel, type SyncModel } from "./model";
import { BannerWatch, CursorWatch, ModeWatch } from "./oracle";
import { connectServer, type ServerControl } from "./serverControl";
import { AwaitBanner, AwaitPoisonRepair, HoldSnapshots, ReleaseSnapshots } from "./steps";
import { captureFaultWarnings } from "../warningsCapture";

captureFaultWarnings("sync banner teeth");

type Mutant = "pausedDropped" | "keptReplaced" | "notBack" | "stallKept" | "runningKept";

const mutants = vi.hoisted(() => ({ armed: null as string | null }));

/** The mutant's bend of one transition's result. */
function bend(mutant: string | null, before: SyncState, after: SyncState,
              eventType: string): SyncProblem | undefined {
  const p = after.problem;
  const unusable = p?.kind === "replica-unusable";
  switch (mutant) {
    case "pausedDropped":
      return unusable ? { kind: "replica-unusable", error: p.error } : p;
    case "keptReplaced":
      return after.replicaGone !== undefined && p?.kind === "rejected-batch" &&
        p.repair === "mark-failed"
        ? { kind: "replica-unusable", error: after.replicaGone } : p;
    case "notBack":
      return eventType === "poison-intents-discarded" && unusable ? undefined : p;
    case "stallKept":
      return unusable && before.problem?.kind === "replica-stalled" ? before.problem : p;
    case "runningKept":
      return unusable && before.problem?.kind === "rejected-batch" &&
        before.problem.repair === "running" ? before.problem : p;
    default:
      return p;
  }
}

vi.mock("../../sync/syncState", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../sync/syncState")>();
  return {
    ...real,
    transitionSync: (...[state, event]: Parameters<typeof real.transitionSync>) => {
      const t = real.transitionSync(state, event);
      const problem = bend(mutants.armed, state, t.state, event.type);
      return problem === t.state.problem ? t : { ...t, state: { ...t.state, problem } };
    },
  };
});

let server: ServerControl;
let clients: HarnessClient[] = [];

beforeAll(async () => {
  server = await connectServer();
});

afterEach(async () => {
  mutants.armed = null;
  await Promise.all(clients.map((c) => c.dispose()));
  clients = [];
});

/** Runs `cmds` on one client A; the banner failure it met, or null. */
async function bannerFailure(cmds: readonly SyncCommand[]): Promise<string | null> {
  await server.reset();
  const a = await startClient("A", server);
  clients.push(a);
  const model: SyncModel = initialModel(["A"]);
  const world: World<HarnessClient> = {
    server, clients: new Map([["A", a]]), watch: new CursorWatch(), modes: new ModeWatch(),
    banners: new BannerWatch(), transcript: [], count: () => undefined,
    cancelled: () => false,
  };
  try {
    await fc.asyncModelRun(() => ({ model, real: world }), cmds);
  } catch (error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    if (text.startsWith("banner: ")) return text;
    throw error;
  }
  return null;
}

const markFailedThenDead = (): SyncCommand[] => [
  new BadBatch("A", "fails"), new AwaitBanner("A", "rejected-batch mark-failed"),
  new WorkerDies("A"), new Pull("A"),
];

const scenarios: Record<Mutant, { reaches: string; cmds: () => SyncCommand[] }> = {
  pausedDropped: {
    reaches: "a reload whose worker dies at discovery: online-only, paused for startup",
    cmds: () => [new Reload("A", undefined, true)],
  },
  keptReplaced: {
    reaches: "a failed mark, then the worker dies",
    cmds: markFailedThenDead,
  },
  notBack: {
    reaches: "a failed mark, the worker dies, then Discard",
    cmds: () => [...markFailedThenDead(), new Discard("A")],
  },
  stallKept: {
    reaches: "a stalled banner, then the worker dies",
    cmds: () => [new Fault("A", "snapshot5xx"), new RotateGeneration(), new Pull("A"),
                 new WorkerDies("A"), new Pull("A")],
  },
  runningKept: {
    reaches: "a poison repair the worker dies under",
    cmds: () => [new HoldSnapshots("A"), new BadBatch("A"), new AwaitPoisonRepair("A"),
                 new WorkerDies("A"), new ReleaseSnapshots("A")],
  },
};

for (const [mutant, { reaches, cmds }] of Object.entries(scenarios)) {
  test(`banner clean: ${reaches}`, async () => {
    expect(await bannerFailure(cmds())).toBeNull();
  });

  test(`banner catches ${mutant}: ${reaches}`, async () => {
    mutants.armed = mutant;
    const failure = await bannerFailure(cmds());
    console.log(`teeth banner ${mutant}: ${failure ?? "survived"}`);
    expect(failure).not.toBeNull();
  });
}
