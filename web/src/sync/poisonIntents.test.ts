import { describe, expect, it } from "vitest";
import {
  parseStoredIntents,
  serialiseIntents,
  validPoisonEvent,
  withIntent,
  type PoisonEvent,
} from "./poisonIntents";

const event = (id: number, batchId: string, message = "m"): PoisonEvent => ({
  id: id as PoisonEvent["id"], batch_id: batchId, ops: [], status: 400, message,
});

describe("parseStoredIntents", () => {
  it("reads what the current build writes, sorted by id", () => {
    const raw = JSON.stringify({ version: 1, intents: [
      { id: 2, batch_id: "b", ops: [], status: 400, message: "m" },
      { id: 1, batch_id: "a", ops: [], status: 400, message: "m" },
    ] });
    expect(parseStoredIntents(raw)).toEqual([event(1, "a"), event(2, "b")]);
  });

  it("returns nothing for an absent value", () => {
    expect(parseStoredIntents(null)).toEqual([]);
    expect(parseStoredIntents(undefined)).toEqual([]);
  });

  it("returns nothing for another version", () => {
    expect(parseStoredIntents(JSON.stringify({
      version: 2, intents: [event(1, "a")],
    }))).toEqual([]);
  });

  it("returns nothing for malformed JSON", () => {
    expect(parseStoredIntents("{not json")).toEqual([]);
  });

  it("returns nothing when intents is not an array", () => {
    expect(parseStoredIntents(JSON.stringify({ version: 1, intents: {} })))
      .toEqual([]);
  });

  it("drops invalid entries and keeps the valid ones", () => {
    const raw = JSON.stringify({ version: 1, intents: [
      event(1, "a"),
      { id: 1.5, batch_id: "x", ops: [], status: 400, message: "m" },
      { id: 3, batch_id: 7, ops: [], status: 400, message: "m" },
      null,
      "text",
    ] });
    expect(parseStoredIntents(raw)).toEqual([event(1, "a")]);
  });

  it("keeps the last of two entries with the same row and batch", () => {
    const raw = JSON.stringify({ version: 1, intents: [
      event(1, "a", "first"), event(1, "a", "second"),
    ] });
    expect(parseStoredIntents(raw)).toEqual([event(1, "a", "second")]);
  });

  it("orders the same row by batch id", () => {
    const raw = JSON.stringify({ version: 1, intents: [
      event(1, "b"), event(1, "a"),
    ] });
    expect(parseStoredIntents(raw).map((e) => e.batch_id)).toEqual(["a", "b"]);
  });
});

describe("validPoisonEvent", () => {
  it("accepts a complete event and rejects partial ones", () => {
    expect(validPoisonEvent(event(1, "a"))).toBe(true);
    expect(validPoisonEvent({ ...event(1, "a"), ops: "x" })).toBe(false);
    expect(validPoisonEvent({ ...event(1, "a"), status: "400" })).toBe(false);
    expect(validPoisonEvent({ ...event(1, "a"), message: undefined })).toBe(false);
    expect(validPoisonEvent(null)).toBe(false);
  });
});

describe("withIntent", () => {
  it("replaces an event with the same key and keeps the sort order", () => {
    const intents = [event(1, "a"), event(3, "c")];
    const next = withIntent(intents, event(1, "a", "newer"));
    expect(next).toEqual([event(1, "a", "newer"), event(3, "c")]);
  });

  it("inserts a new event in order", () => {
    const next = withIntent([event(1, "a"), event(3, "c")], event(2, "b"));
    expect(next.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("does not mutate its input", () => {
    const intents = [event(1, "a")];
    withIntent(intents, event(0, "z"));
    expect(intents).toEqual([event(1, "a")]);
  });
});

describe("serialiseIntents", () => {
  it("writes the version-1 envelope", () => {
    expect(JSON.parse(serialiseIntents([event(1, "a")]))).toEqual({
      version: 1, intents: [event(1, "a")],
    });
  });

  it("round-trips through parseStoredIntents", () => {
    const intents = [event(1, "a"), event(2, "b")];
    expect(parseStoredIntents(serialiseIntents(intents))).toEqual(intents);
  });
});
