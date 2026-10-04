// pattern: Imperative Shell
// The sync property's commands, one class per drawn command (an Offline
// carries its own return), each acting on the real clients and server through the harness.
//
// Every command's run ends the same way (SyncCommand.run): a client whose
// Offline drew a return and whose countdown this command finished comes back
// online, the cursor watch looks at every client, and the model's
// armedWriteFails is brought up to date from the clients, since only they
// know when a lane has drained.
// Preconditions read the model only, and every rejection is counted (see
// countSkipsWith). The model is never less cautious than the clients, so
// Reload and BadBatch assert in run that the real client agrees with it: a
// drift between the two fails the example instead of passing unnoticed.
//
// fc.commands draws the commands before the run, so their arguments name
// clients and op drafts; an Edit resolves its drafts against the model when
// it runs. Every run appends a resolved line to the world's transcript, which
// a failing example prints.
import fc from "fast-check";
import type { BlockUid, OrderIdx, SyncSeq } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import { ApiError } from "../../api/client";
import { BAD_UID, editDrafts, PAGE_TITLES, pageTitle, resolveOps, SEED_PAGE, showDraft,
         showOp, targetPool, type OpDraft } from "./arbitraries";
import type { ConnectLanding, HarnessClient } from "./harnessClient";
import { countDown, FALL_BACK, midnightCrossing, type MidnightDay, type OfflineBack,
         SPRING_FORWARD, type SyncModel } from "./model";
import type { CursorWatch } from "./oracle";
import { ExampleCancelled } from "./cancel";
import type { ServerControl } from "./serverControl";

export interface World {
  server: ServerControl;
  clients: Map<string, HarnessClient>;
  watch: CursorWatch;
  /** One resolved line per command run, for the failure report. */
  transcript: string[];
  /** Counts what ran, by name (see tally). */
  count(key: string): void;
  /** True once the example is over or abandoned: no command may run. */
  cancelled(): boolean;
}

export type FaultKind = "dropAck" | "duplicate" | "lostPull" | "writeFails";
export type NudgeKind = "latest" | "stale" | "duplicate" | "ahead";

/** How far past the journal an "ahead" nudge points. */
const AHEAD_BY = 5;

const clientOf = (w: World, name: string): HarnessClient => {
  const c = w.clients.get(name);
  if (!c) throw new Error(`no client ${name}`);
  return c;
};

let noteSkip: (key: string) => void = () => undefined;

/** Where check() rejections are counted, as `<kind> skipped: <reason>`.
 * fc.asyncModelRun hands check the model alone, so the count goes here. */
export function countSkipsWith(count: (key: string) => void): void {
  noteSkip = count;
}

const NOT_STARTED = "client not in this example";
const LANE_BUSY = "write failure armed or lane unsent";

/** Why `client` cannot take a command that needs it, or null. The property
 * draws only the clients it starts (commandsFor), so this catches a fixed
 * scenario naming a client it did not start. */
const notStarted = (m: Readonly<SyncModel>, client: string): string | null =>
  m.clients.includes(client) ? null : NOT_STARTED;

/** Throws when the real client has a lane or an armed write failure that the
 * model says it has not. */
const assertNoLane = (cmd: SyncCommand, c: HarnessClient): void => {
  if (c.writeFailArmed() || c.unsentInMemory() > 0) {
    throw new Error(`model drift: ${cmd.toString()} passed its check, but the client` +
      ` has write failure armed ${c.writeFailArmed()}, lane ${c.unsentInMemory()}`);
  }
};

export abstract class SyncCommand implements fc.AsyncCommand<SyncModel, World> {
  /** The tally's name for this command: its kind, without the client. */
  protected abstract readonly kindName: string;
  /** Why this command cannot run on `m`, or null when it can. */
  protected abstract blocked(m: Readonly<SyncModel>): string | null;
  abstract toString(): string;

  check(m: Readonly<SyncModel>): boolean {
    const why = this.blocked(m);
    if (why !== null) noteSkip(`${this.kindName} skipped: ${why}`);
    return why === null;
  }
  /** What the command does; returns its transcript line. */
  protected abstract act(m: SyncModel, w: World): Promise<string>;

  async run(m: SyncModel, w: World): Promise<void> {
    // An abandoned example's command loop may still be going: it must not
    // act on clients or a server the next example now owns.
    if (w.cancelled()) {
      throw new ExampleCancelled(`${this.toString()} refused: the example was cancelled`);
    }
    // Counted before act, so the Offline that starts a countdown is not one
    // of its commands; a skipped command never gets here and does not count.
    const { backAfter, due } = countDown(m.backAfter);
    m.backAfter = backAfter;
    w.transcript.push(await this.act(m, w));
    for (const { client, after } of due) {
      await clientOf(w, client).online();
      m.online[client] = true;
      w.transcript.push(`Online(${client}) (after ${after} command${after === 1 ? "" : "s"})`);
      w.count(`Online after ${after}`);
    }
    w.watch.observe([...w.clients.values()]);
    for (const [name, c] of w.clients) {
      // writeFails stays armed until its INSERT has failed and the lane it
      // pushed the ops into has drained.
      m.armedWriteFails[name] = c.writeFailArmed() || c.unsentInMemory() > 0;
    }
  }
}

export class Edit extends SyncCommand {
  protected readonly kindName = "Edit";
  constructor(readonly client: string, readonly drafts: readonly OpDraft[]) { super(); }

  protected blocked(m: Readonly<SyncModel>): string | null {
    return notStarted(m, this.client);
  }

  protected async act(m: SyncModel, w: World): Promise<string> {
    const { ops, used } = resolveOps(this.drafts, targetPool(m),
                                     m.freshUids[this.client] ?? []);
    m.freshUids[this.client] = (m.freshUids[this.client] ?? []).slice(used.length);
    m.createdUids.push(...used);
    w.count("Edit");
    for (const op of ops) {
      w.count(`Edit op ${op.op}`);
      // Where a title places the op: a top-level create's page, and whether
      // a top-level move names one.
      if (op.op === "create" && op.parent_uid === null) {
        w.count(`Edit op create top of ${op.page_title}`);
      } else if (op.op === "move" && op.parent_uid === null) {
        w.count(op.page_title ? `Edit op move top of ${op.page_title}` : "Edit op move top untitled");
      }
    }
    const id = await clientOf(w, this.client).edit(ops);
    m.good.get(this.client)?.push(id);
    return `Edit(${this.client}) ${id}: ${ops.map(showOp).join("; ")}`;
  }

  toString(): string {
    return `Edit(${this.client}, [${this.drafts.map(showDraft).join("; ")}])`;
  }
}

/** A create of a uid live in every replica and on the server: the replica
 * keeps it as a replay, the server rejects it with a 400. Only on the
 * durable path: no armed write failure and nothing unsent in memory. */
export class BadBatch extends SyncCommand {
  protected readonly kindName = "BadBatch";
  constructor(readonly client: string) { super(); }

  protected blocked(m: Readonly<SyncModel>): string | null {
    return notStarted(m, this.client) ??
      (m.armedWriteFails[this.client] ? LANE_BUSY : null);
  }

  protected async act(m: SyncModel, w: World): Promise<string> {
    const c = clientOf(w, this.client);
    assertNoLane(this, c);
    const ops: BlockOp[] = [{
      op: "create", uid: BAD_UID as BlockUid, page_title: SEED_PAGE,
      parent_uid: null, order_idx: 60 as OrderIdx, text: "a create of a live uid",
    }];
    w.count("BadBatch");
    const id = await c.edit(ops);
    m.bad.add(id);
    return `BadBatch(${this.client}) ${id}`;
  }

  toString(): string { return `BadBatch(${this.client})`; }
}

/** The socket going down, and when it comes back: once `back` more
 * commands have run (SyncCommand.run brings it up), or not before quiesce.
 * There is no Online command: drawn on its own it mostly met a client
 * already online and was skipped, so most offline periods lasted until
 * quiesce and short blips went unexplored. */
export class Offline extends SyncCommand {
  protected readonly kindName = "Offline";
  constructor(readonly client: string, readonly back: OfflineBack = "quiesce") { super(); }

  protected blocked(m: Readonly<SyncModel>): string | null {
    return notStarted(m, this.client) ?? (m.online[this.client] ? null : "already offline");
  }

  protected act(m: SyncModel, w: World): Promise<string> {
    clientOf(w, this.client).offline();
    m.online[this.client] = false;
    m.backAfter[this.client] = this.back === "quiesce" ? null
      : { after: this.back, left: this.back };
    w.count("Offline");
    return Promise.resolve(this.toString());
  }

  toString(): string {
    return this.back === "quiesce" ? `Offline(${this.client})`
      : `Offline(${this.client}, back after ${this.back})`;
  }
}

export class Fault extends SyncCommand {
  constructor(readonly client: string, readonly kind: FaultKind) { super(); }

  protected get kindName(): string { return `Fault ${this.kind}`; }

  protected blocked(m: Readonly<SyncModel>): string | null {
    return notStarted(m, this.client) ??
      (this.kind === "writeFails" && m.armedWriteFails[this.client] ? LANE_BUSY : null);
  }

  protected act(m: SyncModel, w: World): Promise<string> {
    const c = clientOf(w, this.client);
    if (this.kind === "writeFails") {
      c.failNextWrite();
      m.armedWriteFails[this.client] = true;
    } else {
      c.transport.arm(this.kind);
    }
    w.count(`Fault ${this.kind}`);
    return Promise.resolve(this.toString());
  }

  toString(): string { return `Fault(${this.client}, ${this.kind})`; }
}

export class Pull extends SyncCommand {
  constructor(readonly client: string) { super(); }

  protected readonly kindName = "Pull";

  /** A pull needs the network; offline, the socket that prompts one is down. */
  protected blocked(m: Readonly<SyncModel>): string | null {
    return notStarted(m, this.client) ?? (m.online[this.client] ? null : "offline");
  }

  protected async act(_m: SyncModel, w: World): Promise<string> {
    const c = clientOf(w, this.client);
    w.count("Pull");
    await c.pull();
    return `Pull(${this.client}) cursor ${c.cursor()}`;
  }

  toString(): string { return `Pull(${this.client})`; }
}

/** A websocket seq frame, not awaited, so its pull overlaps whatever runs
 * next. Frames arrive only while the socket is up. */
export class Nudge extends SyncCommand {
  constructor(readonly client: string, readonly kind: NudgeKind) { super(); }

  protected get kindName(): string { return `Nudge ${this.kind}`; }

  protected blocked(m: Readonly<SyncModel>): string | null {
    return notStarted(m, this.client) ?? (m.online[this.client] ? null : "offline");
  }

  protected async act(_m: SyncModel, w: World): Promise<string> {
    const c = clientOf(w, this.client);
    const cursor = c.cursor();
    let seq: number;
    switch (this.kind) {
      case "latest": seq = await w.server.latestSeq(); break;
      case "stale": seq = Math.max(0, cursor - 1); break;
      case "duplicate": seq = cursor; break;
      case "ahead": seq = (await w.server.latestSeq()) + AHEAD_BY; break;
    }
    c.nudge(seq as SyncSeq);
    w.count(`Nudge ${this.kind}`);
    return `Nudge(${this.client}, ${this.kind}) seq ${seq}, cursor ${cursor}`;
  }

  toString(): string { return `Nudge(${this.client}, ${this.kind})`; }
}

/** A page reload. Ops only in the in-memory lane die with the page by
 * design (the beforeunload guard's job), so it needs an empty lane and no
 * write failure armed to put anything there. An online client's new life
 * connects `connectAt` ticks into its startup, or once the startup has
 * finished when that is absent (HarnessClient.reload). */
export class Reload extends SyncCommand {
  protected readonly kindName = "Reload";
  constructor(readonly client: string, readonly connectAt?: number) { super(); }

  protected blocked(m: Readonly<SyncModel>): string | null {
    return notStarted(m, this.client) ??
      (m.armedWriteFails[this.client] ? LANE_BUSY : null);
  }

  protected async act(_m: SyncModel, w: World): Promise<string> {
    const c = clientOf(w, this.client);
    assertNoLane(this, c);
    w.count("Reload");
    await c.reload(this.connectAt);
    const landed = c.connectLanded();
    w.count(`Reload ${connectTally(this.connectAt, landed)}`);
    // An offline load ignores its timing; the report says so rather than
    // implying the tick mattered.
    return this.connectAt !== undefined && landed === null
      ? `${this.toString()} (offline: timing unused)` : this.toString();
  }

  toString(): string {
    return this.connectAt === undefined ? `Reload(${this.client})`
      : `Reload(${this.client}, connect at tick ${this.connectAt})`;
  }
}

/** The tally's word on a page load's first connect: untimed, a timing an
 * offline load ignored, or where a timed connect landed in the startup. */
export function connectTally(connectAt: number | undefined,
                             landed: ConnectLanding | null): string {
  if (connectAt === undefined) return "connect untimed";
  return landed === null ? "connect timed, offline" : `connect timed, landed ${landed}`;
}

/** Every client's next pull runs rebase recovery. */
export class RotateGeneration extends SyncCommand {
  protected readonly kindName = "RotateGeneration";
  protected blocked(): string | null { return null; }

  protected async act(_m: SyncModel, w: World): Promise<string> {
    w.count("RotateGeneration");
    await w.server.rotateGeneration();
    return this.toString();
  }

  toString(): string { return "RotateGeneration"; }
}

/** The server clock to 23:59:55 local, then ten seconds on. */
export class CrossMidnight extends SyncCommand {
  protected readonly kindName = "CrossMidnight";
  constructor(readonly day: MidnightDay) { super(); }

  protected blocked(): string | null { return null; }

  protected async act(m: SyncModel, w: World): Promise<string> {
    const crossing = midnightCrossing(m.clockMs, this.day);
    w.count(crossing.fellBack ? "CrossMidnight fell back to model date"
                              : `CrossMidnight ${this.day}`);
    await w.server.setClock(crossing.before);
    await w.server.setClock(crossing.after);
    m.clockMs = crossing.after;
    return `CrossMidnight(${this.day}) on ${crossing.date}` +
      (crossing.fellBack ? " (changeover behind the clock)" : "");
  }

  toString(): string { return `CrossMidnight(${this.day})`; }
}

/** Statuses the rename route refuses a drawn rename with: 404 when no page
 * has the old title (renamed away, or never made), 409 when a page has the
 * new one, 400 when they are the same title. */
const REFUSED = new Set([400, 404, 409]);

/** A page rename from the title pool, as the SPA's PageTitle commits one:
 * the rename route straight through this client's network, not an op, and
 * never a merge. Offline it runs and fails, as a user's attempt does. The
 * other clients learn of it only from the feed, so their queued and later
 * ops may still name the old title. */
export class Rename extends SyncCommand {
  protected readonly kindName = "Rename";
  constructor(readonly client: string, readonly from: number, readonly to: number) { super(); }

  protected blocked(m: Readonly<SyncModel>): string | null {
    return notStarted(m, this.client);
  }

  protected async act(_m: SyncModel, w: World): Promise<string> {
    const c = clientOf(w, this.client);
    const [from, to] = [pageTitle(this.from), pageTitle(this.to)];
    let outcome: string;
    try {
      await c.transport.fetchJson(`/api/page/${encodeURIComponent(from)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_title: to, allow_merge: false }),
      });
      outcome = "renamed";
    } catch (error: unknown) {
      if (error instanceof ApiError && REFUSED.has(error.status)) {
        outcome = `refused ${error.status}`;
      } else if (error instanceof TypeError) {
        // The transport's dead network: offline, as the model says.
        outcome = "failed offline";
      } else {
        throw error;
      }
    }
    w.count(`Rename ${outcome}`);
    return `${this.toString()}: ${outcome}`;
  }

  toString(): string {
    return `Rename(${this.client}, ${pageTitle(this.from)} -> ${pageTitle(this.to)})`;
  }
}

/** A Rename's two titles: any pool title, and a different one. */
const renameTitles: fc.Arbitrary<[number, number]> = fc.tuple(
  fc.nat({ max: PAGE_TITLES.length - 1 }), fc.integer({ min: 1, max: PAGE_TITLES.length - 1 }),
).map(([from, step]) => [from, (from + step) % PAGE_TITLES.length]);

/** The clients an example may start, in order: an example with two
 * starts A and B. */
export const NAMES = ["A", "B", "C"] as const;

/** An Offline's return: until quiesce one time in four, else after 1, 2, 3
 * or 5 commands, each about one time in five. Until quiesce is the only
 * period that spans every later command, so it is drawn a little more often
 * than any one short blip; it comes first, so a shrink moves toward the
 * fixed scenarios' plain Offline. */
export const offlineBack: fc.Arbitrary<OfflineBack> = fc.oneof(
  { withCrossShrink: true },
  { weight: 1, arbitrary: fc.constant<OfflineBack>("quiesce") },
  { weight: 3, arbitrary: fc.constantFrom<OfflineBack>(1, 2, 3, 5) },
);

/** When a page load's first connect comes, in ticks after its mount
 * begins; absent half the time, when it comes once the startup has
 * finished. A startup spans a few ticks: measured over the property's own
 * examples, a first start finished after 2 to 5 (mostly 3 or 4), a reload
 * after 1 to 7 (median 3, with a long tail). Ticks 1
 * to 7 land a connect before the startup's first reply, inside it, and
 * after it, for both. Never tick 0: the socket's open event is a macrotask
 * of its own, so in the app at least one turn passes after the mount. */
export const connectTiming: fc.Arbitrary<number | undefined> =
  fc.option(fc.integer({ min: 1, max: 7 }), { nil: undefined, freq: 2 });

/** Every command, naming only `names` (the clients the example starts), so
 * no draw is spent on a client the example lacks. Weighted as calibrated:
 * Edit 10, Pull 3, Nudge 3, Offline 3, Fault 3, Reload 2, BadBatch 1,
 * RotateGeneration 1, CrossMidnight 1, Rename 1, so a BadBatch is about one
 * command in twenty-eight. An Offline's three units buy a whole offline
 * period, its return included. */
export function commandsFor(names: readonly string[]): fc.Arbitrary<SyncCommand>[] {
  const client = fc.constantFrom(...names);
  return [fc.oneof(
    { weight: 10, arbitrary: fc.tuple(client, editDrafts).map(([c, d]) => new Edit(c, d)) },
    { weight: 3, arbitrary: client.map((c) => new Pull(c)) },
    { weight: 3, arbitrary: fc.tuple(client, fc.constantFrom<NudgeKind>(
        "latest", "stale", "duplicate", "ahead")).map(([c, k]) => new Nudge(c, k)) },
    { weight: 3, arbitrary: fc.tuple(client, offlineBack)
        .map(([c, back]) => new Offline(c, back)) },
    { weight: 3, arbitrary: fc.tuple(client, fc.constantFrom<FaultKind>(
        "dropAck", "duplicate", "lostPull", "writeFails")).map(([c, k]) => new Fault(c, k)) },
    { weight: 2, arbitrary: fc.tuple(client, connectTiming)
        .map(([c, at]) => new Reload(c, at)) },
    { weight: 1, arbitrary: client.map((c) => new BadBatch(c)) },
    { weight: 1, arbitrary: fc.constant(null).map(() => new RotateGeneration()) },
    // One crossing in four lands on a BST/GMT changeover date.
    { weight: 1, arbitrary: fc.oneof(
        { weight: 3, arbitrary: fc.constant<MidnightDay>("model") },
        { weight: 1, arbitrary: fc.constantFrom<MidnightDay>(SPRING_FORWARD, FALL_BACK) },
      ).map((day) => new CrossMidnight(day)) },
    { weight: 1, arbitrary: fc.tuple(client, renameTitles)
        .map(([c, [from, to]]) => new Rename(c, from, to)) },
  )];
}
