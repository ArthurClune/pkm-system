import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { commandsFor, Offline, offlineBack, Reload, type SyncCommand } from "./commands";

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

describe("Reload", () => {
  it("connects once startup completes by default", () => {
    expect(new Reload("A").toString()).toBe("Reload(A)");
  });
});
