// @vitest-environment node
// The worker's recovery lease, driven through buildHandlers by drawn commands
// and checked against a model of the lease's contract (sync-recovery.md
// § The recovery lease): the client sends a deadline and may move it later
// by renewing; once the clock reaches the deadline the lease is expired, the
// gate is freed and the token is refused, unless a commit has begun. A lease
// call that finds the deadline passed expires the lease itself, whether or
// not the timer has run. The clock is the injected one; the timers keep pace
// with it or run ahead of it (`skew`), and a lease call may arrive with the
// clock ahead of the timers (`late`). Calls reach a running commit as soon as
// it begins and from inside its snapshot apply. Invariants:
//   exclusion         no gated call settles while the model holds the lease
//                     or a commit runs
//   bounded hold      once the clock reaches the model's deadline with no
//                     commit begun, every queued gated call settles
//   progress holds    a lease renewed to deadline d is held at every moment
//                     before d; an earlier deadline never shortens it
//   expired is final  renew, commit and abort for the token that last
//                     expired are refused with LEASE_EXPIRED, and the gate
//                     is not taken back; any other token not held is refused
//                     as invalid
//   commit completes  a commit begun before the deadline finishes; the
//                     timer never aborts it, and a renewal, abort or second
//                     commit for its token meanwhile is refused as invalid
//   no wedge          once nothing is held, a gated call succeeds
import fc from "fast-check";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { applySnapshot, type Snapshot } from "./apply";
import { INVALID_TOKEN } from "./recoveryGate";
import { openRawTestDb, type TestDb } from "./testDb";
import { buildHandlers, LEASE_EXPIRED } from "./workerHandlers";
import { batchIdOf, canonicalTitleOf, orderIdxOf, pageIdOf, seqOf, uidOf } from "../test-helpers";

const LEASE = 100;
const PREPARE_EXPIRED = "recovery preparation expired";

const SNAP: Snapshot = {
  generation: "gen-1", plain_space_title_canonicalization: false, seq: seqOf(5),
  pages: [{ id: pageIdOf(1), title: canonicalTitleOf("AI"), created_at: 1, updated_at: 1 }],
  blocks: [{ uid: uidOf("uid_b1"), page_id: pageIdOf(1), parent_uid: null,
    order_idx: orderIdxOf(0), text: "hello", heading: null, view_type: null,
    collapsed: 0, created_at: 1, updated_at: 1, refs: [] }],
  sidebar: [],
};

/** Whose token a lease call carries: the one held (or, inside a commit,
 * the committing one), the one that last expired, one that expired before
 * that, one committed or aborted, or one never issued. */
type Who = "held" | "lastExpired" | "olderExpired" | "retired" | "never";

/** A call made from inside a running commit. */
type Inner =
  | { t: "advance"; ms: number }
  | { t: "renew"; who: Who; ahead: number }
  | { t: "abort"; who: Who }
  | { t: "commit"; who: Who }
  | { t: "enqueue" };

/** `ahead`: the deadline sent, as ms past the clock. `late`: the call
 * arrives with the clock this far ahead of the timers. A commit's `early`
 * calls arrive once it has begun, before its work reads the queue; its
 * `inner` ones arrive during the snapshot apply. */
type Cmd =
  | { t: "prepare"; ahead: number | null }
  | { t: "renew"; who: Who; ahead: number; late: number | null }
  | { t: "advance"; ms: number }
  | { t: "skew"; ms: number }
  | { t: "commit"; kind: "reset" | "rebase"; who: Who; late: number | null;
      early: readonly Inner[]; inner: readonly Inner[] }
  | { t: "abort"; who: Who; late: number | null }
  | { t: "enqueue" }
  | { t: "pendingCount" };

const whoArb: fc.Arbitrary<Who> = fc.oneof(
  { weight: 6, arbitrary: fc.constant<Who>("held") },
  { weight: 2, arbitrary: fc.constant<Who>("lastExpired") },
  { weight: 1, arbitrary: fc.constantFrom<Who>("olderExpired", "retired", "never") },
);
const msArb = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 1, max: LEASE / 2 }) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 2 * LEASE }) },
);
const aheadArb = fc.integer({ min: 0, max: (3 * LEASE) / 2 });
const lateArb = fc.option(fc.integer({ min: 1, max: LEASE }), { freq: 3 });

const innerArb: fc.Arbitrary<Inner> = fc.oneof(
  { weight: 3, arbitrary: msArb.map((ms): Inner => ({ t: "advance", ms })) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("renew" as const), who: whoArb,
                                      ahead: aheadArb }) },
  { weight: 1, arbitrary: whoArb.map((who): Inner => ({ t: "abort", who })) },
  { weight: 1, arbitrary: whoArb.map((who): Inner => ({ t: "commit", who })) },
  { weight: 1, arbitrary: fc.constant<Inner>({ t: "enqueue" }) },
);

/** Weighted to a second commit for the same token, a race that needs
 * nothing else to line up. */
const earlyArb: fc.Arbitrary<Inner> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<Inner>({ t: "commit", who: "held" }) },
  { weight: 2, arbitrary: innerArb },
);

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 3, arbitrary: fc.oneof(
      { weight: 8, arbitrary: fc.integer({ min: 1, max: LEASE }) },
      { weight: 1, arbitrary: fc.constant(0) },
      { weight: 1, arbitrary: fc.constant(null) },
    ).map((ahead): Cmd => ({ t: "prepare", ahead })) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("renew" as const), who: whoArb,
                                      ahead: aheadArb, late: lateArb }) },
  { weight: 4, arbitrary: msArb.map((ms): Cmd => ({ t: "advance", ms })) },
  { weight: 1, arbitrary: msArb.map((ms): Cmd => ({ t: "skew", ms })) },
  { weight: 2, arbitrary: fc.record({
      t: fc.constant("commit" as const),
      kind: fc.constantFrom("reset" as const, "rebase" as const),
      who: whoArb, late: lateArb,
      early: fc.array(earlyArb, { maxLength: 2 }),
      inner: fc.array(innerArb, { maxLength: 4 }),
    }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("abort" as const), who: whoArb,
                                      late: lateArb }) },
  { weight: 2, arbitrary: fc.constant<Cmd>({ t: "enqueue" }) },
  { weight: 1, arbitrary: fc.constant<Cmd>({ t: "pendingCount" }) },
);

/** The model's lease: `first` is the deadline it was granted with. */
interface Lease { token: string; first: number | null; deadline: number | null }

interface Gated { name: string; settled: boolean; error: unknown }

const tally = new Map<string, number>();
const count = (key: string): void => { tally.set(key, (tally.get(key) ?? 0) + 1); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => {
  console.log(`recovery-lease property tally:\n${[...tally].sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `  ${k}  ${n}`).join("\n")}`);
});

/** Every promise chain the handlers started runs to its next timer. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 2; i += 1) await new Promise<void>((done) => setImmediate(done));
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function runExample(cmds: readonly Cmd[]): Promise<string[]> {
  const findings: string[] = [];
  vi.clearAllTimers();
  vi.setSystemTime(0);
  // The worker's clock is the timers' clock plus `shift`.
  let shift = 0;
  let clock = 0;
  let lease: Lease | null = null;
  // The deadline of the lease whose commit is running, and its token.
  let committing: { token: string; deadline: number | null } | null = null;
  let lastExpired: string | null = null;
  const expired: string[] = [];
  const retired: string[] = [];
  const issued = new Set<string>();
  let gated: Gated[] = [];
  // What ended the lease since the last check, for the labels.
  let releasedBy: string | null = null;
  let hook: (() => void) | null = null;
  let minted = 0;

  const t: TestDb = await openRawTestDb();
  const handlers = buildHandlers({
    openDb: async () => t.db,
    clockMs: () => Date.now() + shift,
    applySnapshot: (db, snapshot, nowMs) => {
      const inCommit = hook;
      hook = null;
      inCommit?.();
      return applySnapshot(db, snapshot, nowMs);
    },
  });
  await handlers.init(undefined);
  await handlers.applySnapshot({ snapshot: SNAP, expectedPendingIds: [] });

  const tokenOf = (who: Who): string => {
    const held = committing?.token ?? lease?.token;
    const older = expired.filter((x) => x !== lastExpired);
    const pick = who === "held" ? held
      : who === "lastExpired" ? lastExpired
      : who === "olderExpired" ? older.at(-1)
      : who === "retired" ? retired.at(-1) : undefined;
    return pick ?? "never-issued";
  };
  const refusalOf = (token: string): string =>
    token === lastExpired ? LEASE_EXPIRED : INVALID_TOKEN;

  const expireModel = (how: string): void => {
    if (lease === null) return;
    lastExpired = lease.token;
    expired.push(lease.token);
    lease = null;
    releasedBy = "expiry";
    count(how);
  };
  /** A lease call finds the deadline passed and expires the lease first. */
  const atCall = (): void => {
    if (lease?.deadline != null && clock >= lease.deadline) {
      expireModel("expired at the call, before its timer");
    }
  };

  const gatedCall = (name: string, run: () => Promise<unknown>): void => {
    const g: Gated = { name, settled: false, error: null };
    gated.push(g);
    run().then(() => { g.settled = true; },
               (error: unknown) => { g.settled = true; g.error = error; });
  };
  const enqueue = (): void => {
    minted += 1;
    const batchId = batchIdOf(`b${minted}`);
    gatedCall("enqueue", () => handlers.enqueue({
      ops: [{ op: "update_text", uid: uidOf("uid_b1"), text: `t${minted}` }], batchId,
    }));
  };

  /** The gate against the model, once the handlers have run to rest. */
  const checkGate = (): void => {
    if (lease !== null) {
      const early = gated.filter((g) => g.settled);
      if (early.length > 0) {
        const rule = lease.first !== null && lease.deadline !== lease.first
          ? "progress holds" : "exclusion";
        findings.push(`${rule}: ${early.map((g) => g.name).join(", ")} settled at ${
          clock} under a lease held to ${lease.deadline}`);
      }
      if (lease.first !== null && clock >= lease.first) count("renewed past the first deadline");
      return;
    }
    const stuck = gated.filter((g) => !g.settled);
    if (stuck.length > 0) {
      findings.push(`${releasedBy === "expiry" ? "bounded hold" : "no wedge"}: ${
        stuck.map((g) => g.name).join(", ")} still queued at ${clock} with no lease held`);
    }
    for (const g of gated.filter((x) => x.settled && x.error !== null)) {
      findings.push(`no wedge: ${g.name} failed: ${messageOf(g.error)}`);
    }
    if (gated.length > 0 && releasedBy !== null) count(`gated call released by ${releasedBy}`);
    gated = [];
    releasedBy = null;
  };

  /** `run` must be refused with `want`; `rule` is the invariant it keeps. */
  const expectRefused = async (rule: string, name: string, run: Promise<unknown>,
                               want: string): Promise<void> => {
    try {
      await run;
      findings.push(`${rule}: ${name} answered ok, expected "${want}"`);
    } catch (error: unknown) {
      if (messageOf(error) !== want) {
        findings.push(`${rule}: ${name} was refused with "${messageOf(error)}", expected "${want}"`);
      }
    }
  };
  const expectOk = async (rule: string, name: string, run: Promise<unknown>):
      Promise<void> => {
    try {
      await run;
    } catch (error: unknown) {
      findings.push(`${rule}: ${name} was refused: ${messageOf(error)}`);
    }
  };
  const ruleFor = (want: string): string =>
    want === LEASE_EXPIRED ? "expired is final" : "refusal";

  /** The clock jumps `late` ahead of the timers; `catchUp` lets them follow. */
  const jump = (late: number | null): void => {
    if (late === null) return;
    shift += late;
    clock += late;
  };
  const catchUp = async (late: number | null): Promise<void> => {
    if (late === null) return;
    shift -= late;
    await vi.advanceTimersByTimeAsync(late);
  };

  /** The calls a commit's work makes, synchronously, while it runs. */
  const runInner = (inner: readonly Inner[], checks: Promise<void>[],
                    begun: boolean): void => {
    const running = committing;
    if (running === null) return;
    for (const c of inner) {
      switch (c.t) {
        case "advance":
          clock += c.ms;
          vi.advanceTimersByTime(c.ms);
          if (running.deadline !== null && clock >= running.deadline) {
            count("timer due during a commit");
          }
          break;
        case "renew":
        case "abort":
        case "commit": {
          const token = tokenOf(c.who);
          const own = token === running.token;
          const want = own ? INVALID_TOKEN : refusalOf(token);
          if (own) count(`${c.t} refused: committing`);
          if (own && begun && c.t === "commit") count("second commit as the first begins");
          const call = c.t === "renew"
            ? handlers.renewRecovery({ token, expiresAtMs: clock + c.ahead })
            : c.t === "abort" ? handlers.abortRecovery(token)
            : handlers.commitRecovery({ token, input: { kind: "reset", snapshot: SNAP } });
          checks.push(expectRefused(own ? "commit completes" : ruleFor(want),
                                    `${c.t} during a commit`, call, want));
          break;
        }
        case "enqueue":
          enqueue();
          break;
      }
    }
  };

  const exec = async (cmd: Cmd): Promise<void> => {
    switch (cmd.t) {
      case "prepare": {
        if (lease !== null) return;
        const sent = cmd.ahead === null ? null : clock + cmd.ahead;
        try {
          const r = await handlers.prepareRecovery(
            sent === null ? undefined : { expiresAtMs: sent });
          if (cmd.ahead === 0) findings.push("refusal: a prepare at its deadline was granted");
          if (issued.has(r.token)) findings.push(`refusal: token ${r.token} issued twice`);
          issued.add(r.token);
          lease = { token: r.token, first: sent, deadline: sent };
          if (sent === null) count("prepare without a deadline");
          // a waiter, so the lease's hold is always observable
          gatedCall("pendingCount behind the lease", () => handlers.pendingCount(undefined));
        } catch (error: unknown) {
          if (cmd.ahead !== 0 || messageOf(error) !== PREPARE_EXPIRED) {
            findings.push(`no wedge: prepare failed: ${messageOf(error)}`);
          } else {
            count("prepare refused: already expired");
          }
        }
        break;
      }
      case "renew": {
        jump(cmd.late);
        const token = tokenOf(cmd.who);
        atCall();
        const sent = clock + cmd.ahead;
        const call = handlers.renewRecovery({ token, expiresAtMs: sent });
        if (lease?.token === token) {
          await expectOk("progress holds", "a renewal of the held lease", call);
          if (lease.deadline === null) count("renewal of a lease without a deadline");
          else if (sent < lease.deadline) count("out-of-order renewal");
          else {
            if (sent > lease.deadline) count("renewal moved the deadline");
            lease.deadline = sent;
          }
        } else {
          const want = refusalOf(token);
          if (want === LEASE_EXPIRED) count("renew refused: expired");
          await expectRefused(ruleFor(want), "renewal", call, want);
        }
        await catchUp(cmd.late);
        break;
      }
      case "advance":
        await vi.advanceTimersByTimeAsync(cmd.ms);
        clock += cmd.ms;
        if (lease?.deadline != null && clock >= lease.deadline) expireModel("expired by its timer");
        break;
      case "skew":
        if (lease?.deadline != null && lease.deadline - clock <= cmd.ms) {
          count("stale timer fire");
        }
        shift -= cmd.ms;
        await vi.advanceTimersByTimeAsync(cmd.ms);
        break;
      case "commit": {
        jump(cmd.late);
        const token = tokenOf(cmd.who);
        atCall();
        const proceeds = lease?.token === token;
        const want = refusalOf(token);
        const checks: Promise<void>[] = [];
        let ran = false;
        hook = () => {
          ran = true;
          if (gated.some((g) => g.settled)) {
            findings.push("exclusion: a gated call settled before the commit's work");
          }
          runInner(cmd.inner, checks, false);
        };
        if (proceeds && lease !== null) {
          committing = { token, deadline: lease.deadline };
          lease = null;
        }
        const input = cmd.kind === "reset" ? { kind: "reset" as const, snapshot: SNAP }
                                           : { kind: "rebase" as const, snapshot: SNAP, acked: [] };
        const call = handlers.commitRecovery({ token, input });
        if (proceeds) {
          runInner(cmd.early, checks, true);
          await expectOk("commit completes", `a ${cmd.kind} commit`, call);
          if (!ran) findings.push("commit completes: the commit never reached its work");
          committing = null;
          retired.push(token);
          releasedBy = "commit";
        } else {
          if (want === LEASE_EXPIRED) count("commit refused: expired");
          await expectRefused(ruleFor(want), "commit", call, want);
          if (ran) findings.push(`${ruleFor(want)}: a refused commit reached its work`);
        }
        hook = null;
        await Promise.all(checks);
        await catchUp(cmd.late);
        break;
      }
      case "abort": {
        jump(cmd.late);
        const token = tokenOf(cmd.who);
        atCall();
        const call = handlers.abortRecovery(token);
        if (lease?.token === token) {
          await expectOk("no wedge", "an abort of the held lease", call);
          lease = null;
          retired.push(token);
          releasedBy = "abort";
        } else {
          const want = refusalOf(token);
          if (want === LEASE_EXPIRED) count("abort refused: expired");
          await expectRefused(ruleFor(want), "abort", call, want);
        }
        await catchUp(cmd.late);
        break;
      }
      case "enqueue":
        enqueue();
        break;
      case "pendingCount":
        gatedCall("pendingCount", () => handlers.pendingCount(undefined));
        break;
    }
    await flush();
    checkGate();
  };

  /** Whatever is still held ends, and the gate then serves a call. */
  const drain = async (): Promise<void> => {
    if (lease?.deadline != null) await exec({ t: "advance", ms: lease.deadline - clock });
    else if (lease !== null) await exec({ t: "abort", who: "held", late: null });
    await exec({ t: "pendingCount" });
  };

  for (const cmd of cmds) {
    if (findings.length > 0) break;
    await exec(cmd);
  }
  if (findings.length === 0) await drain();
  t.close();
  return findings;
}

test("the recovery lease frees the gate at its deadline, follows renewals and never revives",
async () => {
  await fc.assert(fc.asyncProperty(fc.array(cmdArb, { maxLength: 40, size: "medium" }),
                                   async (cmds) => {
    const findings = await runExample(cmds);
    if (findings.length > 0) throw new Error(findings.join("\n"));
  }), { numRuns: 200 });
  for (const label of ["renewed past the first deadline", "out-of-order renewal",
                       "stale timer fire", "renew refused: expired", "commit refused: expired",
                       "abort refused: expired", "renew refused: committing",
                       "gated call released by expiry", "gated call released by commit",
                       "timer due during a commit", "expired at the call, before its timer",
                       "commit refused: committing", "abort refused: committing",
                       "second commit as the first begins"]) {
    expect(tally.get(label) ?? 0, label).toBeGreaterThan(0);
  }
}, 120_000);
