import type { BlockUid } from "../../src/api/brands";

interface Row {
  n: number;
}

export function uidOf(r: Row): BlockUid | undefined {
  return (r as Row & { uid?: BlockUid }).uid;
}
export function widened(x: { a: 1 }): unknown {
  return x as { a: 1; uid?: BlockUid };
}
export function longer(t: [string]): unknown {
  return t as [string, BlockUid?];
}
export function indexed(x: object): unknown {
  return x as Record<string, BlockUid>;
}
export function slot<T>(x: { a: 1 }): T | undefined {
  return (x as { a: 1; v?: T }).v;
}
export function partialOf<T>(o: object): Partial<T> {
  return o as Partial<T>;
}
export function optionalKeys<K extends string>(x: object): unknown {
  return x as { [P in K]?: BlockUid };
}
export function partialRecord<K extends string>(o: object): unknown {
  return o as Partial<Record<K, BlockUid>>;
}
export function rekeyed(x: Record<string, 1>): unknown {
  return x as Record<BlockUid, 1>;
}
export function eitherRead(x: { a: 1 }): BlockUid | undefined {
  return (x as { a: 1; uid?: undefined } | { b: 1; uid?: BlockUid }).uid;
}
export function eitherReadMaybe(x: { a: 1 }): BlockUid | undefined {
  return (
    x as { a: 1; uid?: undefined } | { b: 1; uid?: BlockUid } | undefined
  )?.uid;
}
export function nestedEither(x: { a: 1; o?: {} }): BlockUid | undefined {
  return (
    x as { a: 1; o?: { uid?: undefined } } | { b: 1; o?: { uid?: BlockUid } }
  ).o?.uid;
}
export function frozen(xs: BlockUid[]): readonly BlockUid[] {
  return xs as readonly BlockUid[];
}
export function maybe<T>(x: T): T | undefined {
  return x as T | undefined;
}
