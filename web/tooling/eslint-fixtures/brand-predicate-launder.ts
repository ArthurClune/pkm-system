import type { BlockUid } from "../../src/api/brands";

export function widened(x: BlockUid | string): x is BlockUid {
  return x.length > 0;
}
export function assertWidened(x: BlockUid | string): asserts x is BlockUid {
  void x;
}
export function fromUnknown(x: unknown): x is BlockUid {
  return typeof x === "string";
}
type Pair = { v: BlockUid } | { v: string; k: 1 };
export function overlapping(x: Pair): x is { v: BlockUid } {
  return "v" in x;
}
export function perProperty(
  x: { a: BlockUid; b: string },
): x is { a: BlockUid; b: BlockUid } {
  return x.b.length > 0;
}
export function readonlyToMutable(
  x: readonly (BlockUid | string)[],
): x is BlockUid[] {
  return Array.isArray(x);
}
export function onProperty(x: { uid: BlockUid }): x is { uid: BlockUid } & BlockUid {
  return typeof x === "string";
}
export function fromTag(x: { readonly __brand: "BlockUid" }): x is BlockUid {
  return typeof x === "string";
}
