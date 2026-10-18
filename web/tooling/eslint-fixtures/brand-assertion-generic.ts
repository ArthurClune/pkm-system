import type { BlockUid, PageId } from "../../src/api/brands";

export function constrained<T extends BlockUid | PageId>(x: string): T {
  return x as T;
}
export function launder<T>(x: unknown): T {
  return x as T;
}
export function never(x: string): BlockUid {
  return x as never;
}
interface Row {
  v: BlockUid;
  n: number;
}
export function column<K extends keyof Row>(x: unknown): Row[K] {
  return x as Row[K];
}
