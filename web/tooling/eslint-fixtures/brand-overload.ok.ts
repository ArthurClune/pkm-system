import type { BlockUid } from "../../src/api/brands";
export function same(x: BlockUid): BlockUid;
export function same(x: null): null;
export function same(x: BlockUid | null): BlockUid | null {
  return x;
}
export class Keeper {
  keep(x: BlockUid): BlockUid;
  keep(x: BlockUid | null): BlockUid | null {
    return x;
  }
}
export class Index<K, V> extends Map<K, V> {
  tag = 1;
}
export function indexOf(m: Map<BlockUid, number>): Index<BlockUid, number>;
export function indexOf(m: Map<BlockUid, number>): Map<BlockUid, number> {
  return m;
}
export function tagged(x: BlockUid): Promise<BlockUid> & { t: 1 };
export function tagged(x: BlockUid): Promise<BlockUid> & { t: 1 } {
  return Object.assign(Promise.resolve(x), { t: 1 as const });
}
export function first<T>(xs: readonly T[]): T | undefined {
  return xs[0];
}
export function pick<T>(x: T, label?: string): T {
  void label;
  return x;
}
export function firstOf<T>(xs: readonly T[]): T | undefined {
  return xs[0];
}
