// pattern: Imperative Shell
// Fixed scenarios' steps, never drawn by the property: each waits for, holds
// or lets go one thing a scenario needs in place before its next command.
// The sync property's scenarios and the banner teeth share them.
import { repairRunning, viewOf } from "./bannerModel";
import { BadBatch, Discard, Fault, Pull, RotateGeneration, SyncCommand,
         type World } from "./commands";
import type { HarnessClient } from "./harnessClient";
import type { SyncModel } from "./model";
import { TIMED_OUT, within } from "./quiesce";

/** How long a step waits for the state it is after. */
const STEP_WAIT_MS = 5_000;

/** Resolves once `ready()` holds, polling; TIMED_OUT after `ms`. */
export const waitUntil = (ready: () => boolean, ms: number): Promise<void | typeof TIMED_OUT> =>
  within((async () => {
    while (!ready()) await new Promise((resolve) => setTimeout(resolve, 5));
  })(), ms);

export const clientIn = (w: World<HarnessClient>, name: string): HarnessClient => {
  const c = w.clients.get(name);
  if (!c) throw new Error(`no client ${name}`);
  return c;
};

abstract class Step extends SyncCommand {
  constructor(readonly client: string) { super(); }
  protected blocked(m: Readonly<SyncModel>): string | null {
    return m.clients.includes(this.client) ? null : "client not in this example";
  }
}

/** Waits until the client's poison repair has started. */
export class AwaitPoisonRepair extends Step {
  protected readonly kindName = "AwaitPoisonRepair";
  protected async act(_m: SyncModel, w: World<HarnessClient>): Promise<string> {
    const c = clientIn(w, this.client);
    const started = await waitUntil(
      () => c.syncEvents.some((e) => e.type === "repair-started"), STEP_WAIT_MS);
    if (started === TIMED_OUT) throw new Error(`${this.client}'s poison repair never started`);
    return this.toString();
  }
  toString(): string { return `AwaitPoisonRepair(${this.client})`; }
}

/** Waits until the client's banner shows `view` (bannerModel's viewOf). */
export class AwaitBanner extends Step {
  protected readonly kindName = "AwaitBanner";
  constructor(client: string, readonly view: string) { super(client); }
  protected async act(_m: SyncModel, w: World<HarnessClient>): Promise<string> {
    const c = clientIn(w, this.client);
    if (await waitUntil(() => viewOf(c.problem()) === this.view, STEP_WAIT_MS) === TIMED_OUT) {
      throw new Error(`${this.client}'s banner never showed ${this.view}:` +
                      ` it shows ${viewOf(c.problem())}`);
    }
    return this.toString();
  }
  toString(): string { return `AwaitBanner(${this.client}, ${this.view})`; }
}

/** The release of each client's held snapshot fetches (HoldSnapshots). */
const heldSnapshots = new Map<string, () => void>();

/** Holds the client's snapshot fetches until ReleaseSnapshots. */
export class HoldSnapshots extends Step {
  protected readonly kindName = "HoldSnapshots";
  protected act(_m: SyncModel, w: World<HarnessClient>): Promise<string> {
    heldSnapshots.set(this.client,
                      clientIn(w, this.client).transport.stall("/api/sync/snapshot"));
    return Promise.resolve(this.toString());
  }
  toString(): string { return `HoldSnapshots(${this.client})`; }
}

/** Lets the held snapshot fetches go and waits for the client's pulls and
 * for a poison repair running in its life to end. */
export class ReleaseSnapshots extends Step {
  protected readonly kindName = "ReleaseSnapshots";
  protected async act(_m: SyncModel, w: World<HarnessClient>): Promise<string> {
    heldSnapshots.get(this.client)?.();
    heldSnapshots.delete(this.client);
    const c = clientIn(w, this.client);
    await c.replicaSync.idle();
    if (await waitUntil(() => !repairRunning(c.lifeEvents()), STEP_WAIT_MS) === TIMED_OUT) {
      throw new Error(`${this.client}'s poison repair never ended`);
    }
    return this.toString();
  }
  toString(): string { return `ReleaseSnapshots(${this.client})`; }
}

/** A stall (the rotation's recovery meets 503 snapshots while the socket is
 * up), a failed mark's banner over it, then Discard. Three 503s keep the
 * backoff's retries failing for seconds, so the stall outlasts the Discard. */
export const stallBehindMarkThenDiscard = (): SyncCommand[] => [
  new Fault("A", "snapshot5xx"), new Fault("A", "snapshot5xx"),
  new Fault("A", "snapshot5xx"), new RotateGeneration(), new Pull("A"),
  new BadBatch("A", "fails"), new AwaitBanner("A", "rejected-batch mark-failed"),
  new Discard("A"),
];
