import { expect, it } from "vitest";
import { parseTombstoneId, tombstoneIdOfWire, wsFrameOfWire } from "./wire";
import type { SyncTombstone } from "../replica/apply";

it("reads a tombstone's text entity id as the id its kind names", () => {
  expect(tombstoneIdOfWire({ kind: "block", entity_id: "abcdef" }))
    .toEqual({ kind: "block", id: "abcdef" });
  expect(tombstoneIdOfWire({ kind: "page", entity_id: "12" }))
    .toEqual({ kind: "page", id: 12 });
  expect(tombstoneIdOfWire({ kind: "sidebar", entity_id: "5" }))
    .toEqual({ kind: "sidebar", id: 5 });
});

it("reads a kind it does not know as null", () => {
  const future = { kind: "comment", entity_id: "1" } as unknown as SyncTombstone;
  expect(tombstoneIdOfWire(future)).toBeNull();
});

it("rejects a known kind whose entity id is not that kind's id", () => {
  expect(() => tombstoneIdOfWire({ kind: "block", entity_id: "no good" }))
    .toThrow(/malformed block tombstone/);
  expect(() => tombstoneIdOfWire({ kind: "page", entity_id: "" }))
    .toThrow(/malformed page tombstone/);
  expect(() => tombstoneIdOfWire({ kind: "page", entity_id: "-3" }))
    .toThrow(/malformed page tombstone/);
  expect(() => tombstoneIdOfWire({ kind: "sidebar", entity_id: "2.5" }))
    .toThrow(/malformed sidebar tombstone/);
});

it("parseTombstoneId reads null for an id its kind cannot hold", () => {
  expect(parseTombstoneId("block", "abcdef")).toEqual({ kind: "block", id: "abcdef" });
  expect(parseTombstoneId("block", "a")).toBeNull();
  expect(parseTombstoneId("page", "007")).toEqual({ kind: "page", id: 7 });
  expect(parseTombstoneId("page", "1e3")).toBeNull();
});

it("narrows a seq frame, a batch frame, and ignores anything else", () => {
  const seq = { type: "seq", seq: 4, force: true };
  expect(wsFrameOfWire(JSON.stringify(seq))).toEqual({ kind: "seq", frame: seq });
  const batch = { client_id: "c", ts: 1, ops: [] };
  expect(wsFrameOfWire(JSON.stringify(batch)))
    .toEqual({ kind: "batch", frame: batch });
  expect(wsFrameOfWire("null")).toBeNull();
  expect(wsFrameOfWire("0")).toBeNull();
  expect(wsFrameOfWire('{"type":"other"}')).toBeNull();
  expect(wsFrameOfWire('{"ops":"no"}')).toBeNull();
});

it("throws on text that is not JSON, as the handler always did", () => {
  expect(() => wsFrameOfWire("{")).toThrow();
});
