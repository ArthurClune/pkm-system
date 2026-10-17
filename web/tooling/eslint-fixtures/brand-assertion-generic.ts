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
