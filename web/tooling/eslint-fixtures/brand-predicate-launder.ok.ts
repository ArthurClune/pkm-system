import type { BlockUid } from "../../src/api/brands";
type Op = { op: "insert"; uid: BlockUid } | { op: "note"; n: 1 };
export function present(x: BlockUid | null): x is BlockUid {
  return x !== null;
}
export function assertPresent(
  x: BlockUid | undefined,
): asserts x is BlockUid {
  void x;
}
export function isInsert(
  x: Op,
): x is { op: "insert"; uid: BlockUid } {
  return x.op === "insert";
}
export function levelled(
  x: { uid: BlockUid; level: number | null },
): x is { uid: BlockUid; level: number } {
  return x.level !== null;
}
export function listed(x: BlockUid[] | null): x is BlockUid[] {
  return x !== null;
}
export function mutable(x: readonly BlockUid[]): x is BlockUid[] {
  return Array.isArray(x);
}
export function notText(
  x: string | { uid: BlockUid },
): x is { uid: BlockUid } {
  return typeof x !== "string";
}
export function many(x: string | BlockUid[]): x is BlockUid[] {
  return Array.isArray(x);
}
export class Index<K, V> extends Map<K, V> {
  tag = 1;
}
export function isIndex(
  x: Map<BlockUid, number> | null,
): x is Index<BlockUid, number> {
  return x instanceof Index;
}
export class Sorted<K, V> extends Index<K, V> {
  sorted = true;
}
export function isSorted(
  x: Map<BlockUid, number> | null,
): x is Sorted<BlockUid, number> {
  return x instanceof Sorted;
}
export function isReadIndex(
  x: ReadonlyMap<BlockUid, number> | null,
): x is Index<BlockUid, number> {
  return x instanceof Index;
}
export function counted(
  x: { uid: BlockUid },
): x is { uid: BlockUid; n?: number } {
  return "n" in x;
}
export function notNull<T>(x: T | null | undefined): x is T {
  return x != null;
}
export function isDefined<T>(x: T): x is NonNullable<T> {
  return x != null;
}
export function compact<T>(xs: readonly (T | null)[]): T[] {
  return xs.filter((x): x is T => x !== null);
}
export function assertPresentOf<T>(x: T | undefined): asserts x is T {
  if (x === undefined) throw new Error("absent");
}
