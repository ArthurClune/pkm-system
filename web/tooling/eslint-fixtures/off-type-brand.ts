import type { BlockUid, PageId } from "../../src/api/brands";
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
