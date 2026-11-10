import type { BlockUid, PageId } from "../../src/api/brands";
import type { SyncProblem } from "../../src/sync/syncState";
import { offType } from "../../src/test-helpers";

export const cases = [
  // a brand, explicit
  offType<BlockUid>("x"),
  // a brand with no malformed helper in the module
  offType<PageId>(-1),
  // an array of a brand
  offType<BlockUid[]>(["x"]),
  // a union with null
  offType<BlockUid | null>("x"),
  // a Set of a brand
  offType<Set<BlockUid>>(new Set(["x"])),
  // a record keyed by a brand
  offType<Record<BlockUid, number>>({}),
];

// a brand reached through the inferred type argument
export const inferred: BlockUid = offType("x");

// a brand slot holding junk, flat
export const flat = offType<{ uid: BlockUid }>({ uid: "junk" });
// nested in an object literal, and in an array of them
export const nested = offType<{ wrap: { uid: BlockUid } }>(
  { wrap: { uid: "junk" } });
export const listed = offType<{ rows: { uid: BlockUid }[] }>(
  { rows: [{ uid: "junk" }] });
// a non-literal source
const source = { uid: "junk" };
export const viaVariable = offType<{ uid: BlockUid }>(source);
// a union member and a deep slot of a real problem type
export const problem = offType<SyncProblem>(
  { kind: "rejected-batch", event: { batch_id: "x" } });
// a union and an intersection source
export const viaUnion = (u: { uid: string } | null) =>
  offType<{ uid: BlockUid }>(u);
export const viaIntersection = (u: { uid: string } & { note: number }) =>
  offType<{ uid: BlockUid }>(u);
