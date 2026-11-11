// pattern: Imperative Shell
// Between the commands and quiesce, settleReplicas checks what quiesce's own
// reconnect would hide, then reloads each client whose worker died.
import type { BatchId } from "../../api/brands";
import type { World } from "./commands";
import type { HarnessClient } from "./harnessClient";
import type { SyncModel } from "./model";
import type { BannerWatch } from "./oracle";
import { TIMED_OUT, within } from "./quiesce";
import { waitUntil } from "./steps";

/** How long settleReplicas waits for a failed first bootstrap's backoff
 * retry: well past FAST_RETRY_MS doubled for every failure an example
 * draws. */
const FIRST_START_WAIT_MS = 5_000;
/** How long settleReplicas lets a dead worker's lane drain before its
 * reload. */
const LANE_DRAIN_WAIT_MS = 5_000;
/** How long settleReplicas lets a mark that failed before the faults
 * stopped report itself: its failure is a few microtasks behind the call. */
const MARK_REPORT_WAIT_MS = 20;

/** The replica-mode rules quiesce would hide, then the dead workers'
 * reloads, each after its banner is checked. Faults stop first: a retried
 * bootstrap is owed success only once they have. A failed mark waits for
 * its banner's Retry or Discard, which nothing else gives it: a live client
 * showing one gets the Retry here, a dead one the Discard before its
 * reload. Returns the lane batches a reload destroyed while they were still
 * unsent: they may never land. */
export async function settleReplicas(
  world: World<HarnessClient>, model: SyncModel, banners: BannerWatch,
  count: (key: string) => void,
): Promise<Set<BatchId>> {
  const dropped = new Set<BatchId>();
  for (const c of world.clients.values()) {
    c.transport.clearFaults();
    c.clearMarkFaults();
    c.dieAtDiscovery(false);
  }
  for (const [name, c] of world.clients) {
    // A start held back behind a failed poison repair waits for that
    // repair's own Retry or the next connect, as sync-recovery.md says.
    if (!model.online[name] || model.dead[name] || c.hasStarted() ||
        !c.startAttempted()) continue;
    // So does one behind a failed mark this life has not answered: the
    // mark's claim stops the reconnect's drain until its Retry below.
    if (c.failedMarkUnanswered()) {
      count("settle: first start held back by an unanswered failed mark");
      continue;
    }
    count("settle: first start owed a retry");
    const started = await waitUntil(() => c.hasStarted(), FIRST_START_WAIT_MS);
    if (started === TIMED_OUT) {
      throw new Error(`replica mode: ${name}'s first bootstrap failed with the socket` +
                      ` up and was not retried within ${FIRST_START_WAIT_MS}ms`);
    }
    world.transcript.push(`settle: ${name}'s first start retried by the backoff`);
  }
  await new Promise((resolve) => setTimeout(resolve, MARK_REPORT_WAIT_MS));
  for (const [name, c] of world.clients) {
    const problem = c.problem();
    if (model.dead[name] || problem?.kind !== "rejected-batch" ||
        problem.repair !== "mark-failed") continue;
    count("settle: Retry of a failed mark");
    world.transcript.push(`settle: Retry(${name}) of a failed mark`);
    await c.retry();
  }
  for (const [name, c] of world.clients) {
    if (!model.dead[name]) continue;
    await c.online();
    model.online[name] = true;
    await c.pull();
    world.modes.afterPull(c);
    count(c.hasStarted() ? "settle: dead worker online-only after a pull"
                         : "settle: dead worker never started");
    if (await within(c.queue.drain(), LANE_DRAIN_WAIT_MS) === TIMED_OUT) {
      count("settle: dead worker's lane drain hung");
    }
    const shown = banners.check(c, "with its worker dead, before its reload");
    count(`Problem at settle, worker dead: ${shown}`);
    // The Discard a failed mark offers needs no worker, so the online-only
    // banner must come back once it has run.
    if (shown === "rejected-batch mark-failed") {
      world.transcript.push(`settle: Discard(${name}) with its worker dead`);
      await c.discard();
      count(`Problem at settle, worker dead, after a Discard: ${
        banners.check(c, "with its worker dead, after a Discard")}`);
    }
    const durable = new Set(c.db.select(
      "SELECT batch_id FROM pending_ops", ["batch_id"]).map((r) => r.batch_id));
    // a lost reply's lane copy too: its durable row may never have been
    // stored, when the worker's gate was held past the death
    const unsent = [...c.laneBatches, ...c.lostReplyBatches].filter((id) =>
      !c.transport.committed.has(id) && !durable.has(id));
    if (unsent.length > 0) count("settle: dead worker's reload drops lane batches");
    unsent.forEach((id) => dropped.add(id));
    world.transcript.push(`settle: Reload(${name}) of a dead worker` +
      (unsent.length > 0 ? `, lane unsent: ${unsent.join(", ")}` : ""));
    await c.reload();
    model.dead[name] = false;
  }
  return dropped;
}
