// pattern: Imperative Shell
// The sync property's commands, one class per row of the spec's command
// table, each acting on the real clients and server through the harness.
//
// Every command's run ends the same way (SyncCommand.run): the cursor watch
// looks at every client, and the model's armedWriteFails is brought up to
// date from the clients, since only they know when a lane has drained.
// Preconditions read the model only; Reload and BadBatch re-check the real
// client in run and record a no-op rather than break their precondition.
//
// fc.commands draws the commands before the run, so their arguments name
// clients and op drafts; an Edit resolves its drafts against the model when
// it runs. Every run appends a resolved line to the world's transcript, which
// a failing example prints.
import fc from "fast-check";
import type { BlockUid, OrderIdx, SyncSeq } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import { BAD_UID, editDrafts, resolveOps, SEED_PAGE, showDraft, showOp,
         targetPool, type OpDraft } from "./arbitraries";
import type { HarnessClient } from "./harnessClient";
import { FALL_BACK, midnightCrossing, type MidnightDay, SPRING_FORWARD,
         type SyncModel } from "./model";
import type { CursorWatch } from "./oracle";
import type { ServerControl } from "./serverControl";

export interface World {
  server: ServerControl;
  clients: Map<string, HarnessClient>;
  watch: CursorWatch;
  /** One resolved line per command run, for the failure report. */
  transcript: string[];
  /** Counts what ran, by name (see tally). */
  count(key: string): void;
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

export abstract class SyncCommand implements fc.AsyncCommand<SyncModel, World> {
  abstract check(m: Readonly<SyncModel>): boolean;
  abstract toString(): string;
  /** What the command does; returns its transcript line. */
  protected abstract act(m: SyncModel, w: World): Promise<string>;

  async run(m: SyncModel, w: World): Promise<void> {
    w.transcript.push(await this.act(m, w));
    w.watch.observe([...w.clients.values()]);
    for (const [name, c] of w.clients) {
      // writeFails stays armed until its INSERT has failed and the lane it
      // pushed the ops into has drained.
      m.armedWriteFails[name] = c.writeFailArmed() || c.unsentInMemory() > 0;
    }
  }
}

export class Edit extends SyncCommand {
  constructor(readonly client: string, readonly drafts: readonly OpDraft[]) { super(); }

  check(m: Readonly<SyncModel>): boolean {
    return m.clients.includes(this.client);
  }

  protected async act(m: SyncModel, w: World): Promise<string> {
    const { ops, used } = resolveOps(this.drafts, targetPool(m),
                                     m.freshUids[this.client] ?? []);
    m.freshUids[this.client] = (m.freshUids[this.client] ?? []).slice(used.length);
    m.createdUids.push(...used);
    w.count("Edit");
    for (const op of ops) w.count(`Edit op ${op.op}`);
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
  constructor(readonly client: string) { super(); }

  check(m: Readonly<SyncModel>): boolean {
    return m.clients.includes(this.client) && !m.armedWriteFails[this.client];
  }

  protected async act(m: SyncModel, w: World): Promise<string> {
    const c = clientOf(w, this.client);
    if (c.writeFailArmed() || c.unsentInMemory() > 0) {
      w.count("BadBatch no-op");
      return `BadBatch(${this.client}) no-op: lane ${c.unsentInMemory()}`;
    }
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

export class Offline extends SyncCommand {
  constructor(readonly client: string) { super(); }

  check(m: Readonly<SyncModel>): boolean {
    return m.clients.includes(this.client) && m.online[this.client];
  }

  protected act(m: SyncModel, w: World): Promise<string> {
    clientOf(w, this.client).offline();
    m.online[this.client] = false;
    w.count("Offline");
    return Promise.resolve(this.toString());
  }

  toString(): string { return `Offline(${this.client})`; }
}

export class Online extends SyncCommand {
  constructor(readonly client: string) { super(); }

  check(m: Readonly<SyncModel>): boolean {
    return m.clients.includes(this.client) && !m.online[this.client];
  }

  protected async act(m: SyncModel, w: World): Promise<string> {
    await clientOf(w, this.client).online();
    m.online[this.client] = true;
    w.count("Online");
    return this.toString();
  }

  toString(): string { return `Online(${this.client})`; }
}

export class Fault extends SyncCommand {
  constructor(readonly client: string, readonly kind: FaultKind) { super(); }

  check(m: Readonly<SyncModel>): boolean {
    return m.clients.includes(this.client) &&
      (this.kind !== "writeFails" || !m.armedWriteFails[this.client]);
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

  /** A pull needs the network; offline, the socket that prompts one is down. */
  check(m: Readonly<SyncModel>): boolean {
    return m.clients.includes(this.client) && m.online[this.client];
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

  check(m: Readonly<SyncModel>): boolean {
    return m.clients.includes(this.client) && m.online[this.client];
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
 * write failure armed to put anything there. */
export class Reload extends SyncCommand {
  constructor(readonly client: string) { super(); }

  check(m: Readonly<SyncModel>): boolean {
    return m.clients.includes(this.client) && !m.armedWriteFails[this.client];
  }

  protected async act(_m: SyncModel, w: World): Promise<string> {
    const c = clientOf(w, this.client);
    if (c.writeFailArmed() || c.unsentInMemory() > 0) {
      w.count("Reload no-op");
      return `Reload(${this.client}) no-op: lane ${c.unsentInMemory()}`;
    }
    w.count("Reload");
    await c.reload();
    return this.toString();
  }

  toString(): string { return `Reload(${this.client})`; }
}

/** Every client's next pull runs rebase recovery. */
export class RotateGeneration extends SyncCommand {
  check(): boolean { return true; }

  protected async act(_m: SyncModel, w: World): Promise<string> {
    w.count("RotateGeneration");
    await w.server.rotateGeneration();
    return this.toString();
  }

  toString(): string { return "RotateGeneration"; }
}

/** The server clock to 23:59:55 local, then ten seconds on. */
export class CrossMidnight extends SyncCommand {
  constructor(readonly day: MidnightDay) { super(); }

  check(): boolean { return true; }

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

/** The clients an example may start, in order: an example with two
 * starts A and B. */
export const NAMES = ["A", "B", "C"] as const;
const client = fc.constantFrom(...NAMES);

/** Every command, weighted as calibrated: Edit 10, Pull 3, Nudge 3,
 * Offline 3, Online 3, Fault 3, Reload 2, BadBatch 1, RotateGeneration 1,
 * CrossMidnight 1, so a BadBatch is about one command in thirty. A command
 * naming a client the example did not start fails its check and is
 * skipped. */
export const allCommands: fc.Arbitrary<SyncCommand>[] = [fc.oneof(
  { weight: 10, arbitrary: fc.tuple(client, editDrafts).map(([c, d]) => new Edit(c, d)) },
  { weight: 3, arbitrary: client.map((c) => new Pull(c)) },
  { weight: 3, arbitrary: fc.tuple(client, fc.constantFrom<NudgeKind>(
      "latest", "stale", "duplicate", "ahead")).map(([c, k]) => new Nudge(c, k)) },
  { weight: 3, arbitrary: client.map((c) => new Offline(c)) },
  { weight: 3, arbitrary: client.map((c) => new Online(c)) },
  { weight: 3, arbitrary: fc.tuple(client, fc.constantFrom<FaultKind>(
      "dropAck", "duplicate", "lostPull", "writeFails")).map(([c, k]) => new Fault(c, k)) },
  { weight: 2, arbitrary: client.map((c) => new Reload(c)) },
  { weight: 1, arbitrary: client.map((c) => new BadBatch(c)) },
  { weight: 1, arbitrary: fc.constant(null).map(() => new RotateGeneration()) },
  // One crossing in four lands on a BST/GMT changeover date.
  { weight: 1, arbitrary: fc.oneof(
      { weight: 3, arbitrary: fc.constant<MidnightDay>("model") },
      { weight: 1, arbitrary: fc.constantFrom<MidnightDay>(SPRING_FORWARD, FALL_BACK) },
    ).map((day) => new CrossMidnight(day)) },
)];
