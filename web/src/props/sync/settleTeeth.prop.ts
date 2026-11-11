// pattern: Imperative Shell
// Does settleReplicas still see a failed first bootstrap that nothing
// retries? Its check exempts one case only: a start held back behind an
// injected mark failure the life has not answered with Retry or Discard.
// The mutant never retries a failed first start: the backoff waits past
// the example and every later start() call answers false. Each case starts
// a client whose first bootstrap fails.
//   clean               the backoff retries it: settle passes
//   no retry            settle fails on it
//   held by a repair    a poison claim that a running repair holds is not
//                       the exempt case: settle fails on it
//   unanswered mark     the exempt case: settle passes the start by
import fc from "fast-check";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { BadBatch, type SyncCommand, type World } from "./commands";
import { type HarnessClient, startClient } from "./harnessClient";
import { initialModel } from "./model";
import { BannerWatch, CursorWatch, ModeWatch } from "./oracle";
import { connectServer, type ServerControl } from "./serverControl";
import { settleReplicas } from "./settle";
import { AwaitBanner, AwaitPoisonRepair, HoldSnapshots } from "./steps";
import { captureFaultWarnings } from "../warningsCapture";

captureFaultWarnings("sync settle teeth");

const mutants = vi.hoisted(() => ({ noRetry: false }));

vi.mock("../../sync/replicaSync", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../sync/replicaSync")>();
  return {
    ...real,
    createReplicaSync: (deps: Parameters<typeof real.createReplicaSync>[0]) => {
      if (!mutants.noRetry) return real.createReplicaSync(deps);
      const sync = real.createReplicaSync({ ...deps, retryBaseMs: 3_600_000 });
      let failed = false;
      return {
        ...sync,
        start: () => failed ? Promise.resolve(false)
          : sync.start().catch((error: unknown) => { failed = true; throw error; }),
      };
    },
  };
});

let server: ServerControl;
let clients: HarnessClient[] = [];

beforeAll(async () => {
  server = await connectServer();
});

afterEach(async () => {
  mutants.noRetry = false;
  await Promise.all(clients.map((c) => c.dispose()));
  clients = [];
});

/** Starts A with a failing first bootstrap, runs `cmds`, then settles:
 * settle's error, or null, and what it counted. */
async function settle(cmds: readonly SyncCommand[]): Promise<{
  error: string | null; counted: string[];
}> {
  await server.reset();
  const a = await startClient("A", server, undefined, {}, { firstStart: "fails" });
  clients.push(a);
  const model = initialModel(["A"]);
  const counted: string[] = [];
  const world: World<HarnessClient> = {
    server, clients: new Map([["A", a]]), watch: new CursorWatch(), modes: new ModeWatch(),
    banners: new BannerWatch(), transcript: [], count: (k) => { counted.push(k); },
    cancelled: () => false,
  };
  await fc.asyncModelRun(() => ({ model, real: world }), cmds);
  try {
    await settleReplicas(world, model, new BannerWatch(), (k) => { counted.push(k); });
    return { error: null, counted };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error), counted };
  }
}

const NOT_RETRIED = /A's first bootstrap failed with the socket up and was not retried/;

test("settle clean: a failed first bootstrap is retried by the backoff", async () => {
  expect((await settle([])).error).toBeNull();
});

test("settle catches: a failed first bootstrap that nothing retries", async () => {
  mutants.noRetry = true;
  expect((await settle([])).error).toMatch(NOT_RETRIED);
});

test("settle catches: a start held back by a running repair is not exempt", async () => {
  mutants.noRetry = true;
  const { error, counted } = await settle([
    new HoldSnapshots("A"), new BadBatch("A"), new AwaitPoisonRepair("A"),
  ]);
  expect(error).toMatch(NOT_RETRIED);
  expect(counted).not.toContain("settle: first start held back by an unanswered failed mark");
});

test("settle exempts: a start held back by an unanswered failed mark", async () => {
  mutants.noRetry = true;
  const { error, counted } = await settle([
    new BadBatch("A", "fails"), new AwaitBanner("A", "rejected-batch mark-failed"),
  ]);
  expect(error === null || !NOT_RETRIED.test(error)).toBe(true);
  expect(counted).toContain("settle: first start held back by an unanswered failed mark");
});
