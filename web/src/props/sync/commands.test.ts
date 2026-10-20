import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import { FIXTURE_PAGE, PAGE_TITLES } from "./arbitraries";
import { ExampleCancelled } from "./cancel";
import { type ClientPort, commandsFor, connectTally, connectTiming, DeletePage, Fault, Offline, offlineBack, Reload,
         Rename, type SyncCommand, type World } from "./commands";
import { initialModel } from "./model";
import type { ServerControl } from "./serverControl";

const unstubbed = (what: string) => (): never => {
  throw new Error(`stub client: ${what} was not stubbed`);
};

/** A client whose every member throws unless `over` replaces it. */
const stubClient = (over: Partial<ClientPort> = {}): ClientPort => ({
  name: "A",
  writeFailArmed: () => false,
  unsentInMemory: () => 0,
  online: unstubbed("online"),
  offline: unstubbed("offline"),
  edit: unstubbed("edit"),
  pull: unstubbed("pull"),
  nudge: unstubbed("nudge"),
  failNextWrite: unstubbed("failNextWrite"),
  reload: unstubbed("reload"),
  connectLanded: unstubbed("connectLanded"),
  cursor: unstubbed("cursor"),
  transport: { arm: unstubbed("arm"), fetchJson: unstubbed("fetchJson") },
  ...over,
});

/** A server whose every member throws: no command in these tests reaches it. */
const stubServer = (): ServerControl => ({
  cookie: "",
  reset: unstubbed("reset"),
  setClock: unstubbed("setClock"),
  rotateGeneration: unstubbed("rotateGeneration"),
  applied: unstubbed("applied"),
  renames: unstubbed("renames"),
  deletes: unstubbed("deletes"),
  conflicts: unstubbed("conflicts"),
  snapshot: unstubbed("snapshot"),
  takeEcho: unstubbed("takeEcho"),
  setEchoTeeth: unstubbed("setEchoTeeth"),
  setStaleTeeth: unstubbed("setStaleTeeth"),
  setRewriteTeeth: unstubbed("setRewriteTeeth"),
  changes: unstubbed("changes"),
  latestSeq: unstubbed("latestSeq"),
  postRaw: unstubbed("postRaw"),
  postRename: unstubbed("postRename"),
  postDelete: unstubbed("postDelete"),
  withSignal: unstubbed("withSignal"),
});

/** The client a command names, or null for one that names none. */
const clientOf = (cmd: SyncCommand): string | null =>
  "client" in cmd && typeof cmd.client === "string" ? cmd.client : null;

describe("commandsFor", () => {
  it("draws commands naming only the clients it is given", () => {
    const [arb] = commandsFor(["A", "B"]);
    const named = new Set(fc.sample(arb, { numRuns: 2000, seed: 1 })
      .map(clientOf).filter((c) => c !== null));
    expect([...named].sort()).toEqual(["A", "B"]);
  });

  it("draws one client's commands for a single name", () => {
    const [arb] = commandsFor(["C"]);
    const named = new Set(fc.sample(arb, { numRuns: 500, seed: 2 })
      .map(clientOf).filter((c) => c !== null));
    expect([...named]).toEqual(["C"]);
  });
});

describe("Rename", () => {
  it("names its titles, and never draws a rename to the same title", () => {
    expect(new Rename("A", 1, 2).toString()).toBe("Rename(A, Second -> Third)");
    const renames = fc.sample(commandsFor(["A"])[0], { numRuns: 3000, seed: 6 })
      .filter((c): c is Rename => c instanceof Rename);
    expect(renames.length).toBeGreaterThan(0);
    for (const r of renames) expect(r.from).not.toBe(r.to);
    expect(new Set(renames.map((r) => `${r.from}${r.to}`)).size).toBe(12);
  });
});

describe("DeletePage", () => {
  it("names its title, and is drawn", () => {
    expect(new DeletePage("A", 1).toString()).toBe("DeletePage(A, Second)");
    const deletes = fc.sample(commandsFor(["A"])[0], { numRuns: 3000, seed: 7 })
      .filter((c): c is DeletePage => c instanceof DeletePage);
    expect(deletes.length).toBeGreaterThan(0);
    expect(new Set(deletes.map((d) => d.titleIndex)).size).toBe(4);
    // Every pool page is a delete target; the page holding BAD_UID is not in
    // the pool.
    expect(PAGE_TITLES).not.toContain(FIXTURE_PAGE);
  });

  /** Runs a delete of Second whose transport rejects with `error`, or
   * resolves when null. */
  async function outcomeOf(error: Error | null):
      Promise<{ line: string; counted: string[]; url: string }> {
    const counted: string[] = [];
    let url = "";
    const client = stubClient({
      transport: {
        arm: unstubbed("arm"),
        fetchJson: async (u: string, init?: RequestInit) => {
          url = `${init?.method} ${u}`;
          if (error !== null) throw error;
          return {};
        },
      },
    });
    const w: World = { ...stubWorld([]), clients: new Map([["A", client]]),
                       count: (k: string) => { counted.push(k); } };
    await new DeletePage("A", 1).run(initialModel(["A"]), w);
    return { line: w.transcript.join("\n"), counted, url };
  }

  it("deletes through the client's transport and counts each outcome", async () => {
    const ok = await outcomeOf(null);
    expect(ok.url).toBe("DELETE /api/page/Second");
    expect(ok.counted).toEqual(["DeletePage deleted"]);
    expect(ok.line).toContain("deleted");
    expect((await outcomeOf(new ApiError(404, "/api/page/Second"))).counted).toEqual(["DeletePage refused 404"]);
    expect((await outcomeOf(new ApiError(409, "/api/page/Second"))).counted).toEqual(["DeletePage refused 409"]);
    expect((await outcomeOf(new TypeError("fetch failed"))).counted).toEqual(["DeletePage failed offline"]);
    await expect(outcomeOf(new ApiError(500, "/api/page/Second"))).rejects.toBeInstanceOf(ApiError);
  });
});

describe("Offline", () => {
  it("is offline until quiesce by default", () => {
    expect(new Offline("A").back).toBe("quiesce");
    expect(new Offline("A").toString()).toBe("Offline(A)");
  });

  it("shows a drawn return", () => {
    expect(new Offline("B", 2).toString()).toBe("Offline(B, back after 2)");
  });

  it("draws a return of 1, 2, 3 or 5 commands, or until quiesce", () => {
    const drawn = new Set(fc.sample(offlineBack, { numRuns: 500, seed: 3 }));
    expect([...drawn].map(String).sort()).toEqual(["1", "2", "3", "5", "quiesce"]);
  });
});

describe("connect timing", () => {
  it("shows a Reload's timing, and none when it connects after startup", () => {
    expect(new Reload("A").toString()).toBe("Reload(A)");
    expect(new Reload("A", 3).toString()).toBe("Reload(A, connect at tick 3)");
    expect(new Reload("B", 1).toString()).toBe("Reload(B, connect at tick 1)");
  });

  it("draws no timing, or a tick from 1 to 7, never 0", () => {
    const drawn = fc.sample(connectTiming, { numRuns: 1000, seed: 4 });
    expect(drawn).toContain(undefined);
    const timed = drawn.filter((t) => t !== undefined);
    expect(new Set(timed)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
  });

  it("tallies where a connect landed", () => {
    expect(connectTally(undefined, null)).toBe("connect untimed");
    expect(connectTally(2, null)).toBe("connect timed, offline");
    expect(connectTally(2, "mid-startup")).toBe("connect timed, landed mid-startup");
    expect(connectTally(6, "after startup")).toBe("connect timed, landed after startup");
  });
});

describe("offlineBack", () => {
  it("shrinks a drawn return to quiesce", () => {
    // Every value fails, so each counterexample shrinks as far as it can:
    // only a cross-shrink gets a number to quiesce.
    for (let seed = 1; seed <= 20; seed += 1) {
      const result = fc.check(fc.property(offlineBack, () => false), { seed });
      expect(result.counterexample?.[0]).toBe("quiesce");
    }
  });
});

/** A world with one client "A" whose calls land in `events`. */
function stubWorld(events: string[], cancelled = false): World {
  const client = stubClient({
    offline: () => { events.push("offline"); },
    online: () => { events.push("online"); return Promise.resolve(); },
    transport: { arm: (kind) => { events.push(`arm ${kind}`); },
                 fetchJson: unstubbed("fetchJson") },
  });
  return {
    server: stubServer(),
    clients: new Map([["A", client]]),
    watch: { observe: () => undefined },
    transcript: [],
    count: () => undefined,
    cancelled: () => cancelled,
  };
}

describe("SyncCommand.run", () => {
  it("brings a client back only after the command that finishes its countdown", async () => {
    for (const back of [1, 2] as const) {
      const events: string[] = [];
      const w = stubWorld(events);
      const m = initialModel(["A"]);
      await new Offline("A", back).run(m, w);
      expect(events).toEqual(["offline"]);
      if (back === 2) {
        await new Fault("A", "dropAck").run(m, w);
        expect(events).toEqual(["offline", "arm dropAck"]);
      }
      await new Fault("A", "dropAck").run(m, w);
      expect(events.filter((e) => e === "online")).toHaveLength(1);
      expect(events.at(-1)).toBe("online");
      expect(events.indexOf("online")).toBeGreaterThan(events.lastIndexOf("arm dropAck") - 1);
      expect(m.online.A).toBe(true);
    }
  });

  it("refuses a cancelled example before its act touches a client", async () => {
    const events: string[] = [];
    const w = stubWorld(events, true);
    await expect(new Offline("A", 1).run(initialModel(["A"]), w))
      .rejects.toBeInstanceOf(ExampleCancelled);
    expect(events).toEqual([]);
  });
});
