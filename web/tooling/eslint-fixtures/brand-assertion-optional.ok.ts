import type { BlockUid } from "../../src/api/brands";
export function frozen(xs: BlockUid[]): readonly BlockUid[] {
  const ys: readonly BlockUid[] = xs;
  return ys;
}
export function maybe<T>(x: T): T | undefined {
  const y: T | undefined = x;
  return y;
}
export const none = (): BlockUid[] => [];
export function counts(): Record<BlockUid, number> {
  const r: Record<BlockUid, number> = {};
  return r;
}
export function start<T>(): Partial<T> {
  const p: Partial<T> = {};
  return p;
}
interface Row {
  uid: BlockUid;
  n: number;
}
export function picked<K extends keyof Row>(r: Row): Pick<Row, K> {
  const p: Pick<Row, K> = r;
  return p;
}
export function frozenPartial<T>(t: T): Partial<Readonly<T>> {
  const p: Partial<Readonly<T>> = t;
  return p;
}
export function narrower<T, U extends T>(u: U): Partial<T> {
  const p: Partial<T> = u;
  return p;
}
export function numbered(
  x: Record<string, BlockUid>,
): { [i: number]: BlockUid } {
  const n: { [i: number]: BlockUid } = x;
  return n;
}
