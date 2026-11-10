import type { BlockUid, PageId } from "../../src/api/brands";
export function pick<T extends BlockUid | PageId>(x: T): T {
  return x;
}
export function mode(k: string): "a" | "b" | null {
  return k === "a" || k === "b" ? k : null;
}
export const modes = ["a", "b"] as const;
export function frozen<T>(xs: T[]): readonly T[] {
  const ys: readonly T[] = xs;
  return ys;
}
export function none<T>(): T[] {
  const xs: T[] = [];
  return xs;
}
interface Shape {
  a: number;
  b: string;
}
export const field = (f: string) => f as keyof Shape;
