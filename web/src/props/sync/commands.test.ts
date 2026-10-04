import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ExampleCancelled } from "./cancel";
import { commandsFor, connectTally, connectTiming, Fault, Offline, offlineBack, Reload,
         Rename, type SyncCommand, type World } from "./commands";
import type { HarnessClient } from "./harnessClient";
import { initialModel } from "./model";

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
  const client = {
    offline: () => { events.push("offline"); },
    online: () => { events.push("online"); return Promise.resolve(); },
    transport: { arm: (kind: string) => { events.push(`arm ${kind}`); } },
    writeFailArmed: () => false,
    unsentInMemory: () => 0,
  } as unknown as HarnessClient;
  return {
    server: {} as World["server"],
    clients: new Map([["A", client]]),
    watch: { observe: () => undefined } as unknown as World["watch"],
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
