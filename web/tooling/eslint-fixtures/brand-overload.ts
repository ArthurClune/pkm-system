import type { BlockUid } from "../../src/api/brands";

export function wider(s: string): BlockUid;
export function wider(s: string): string {
  return s;
}
export function opaque(s: string): BlockUid;
export function opaque(s: unknown): unknown {
  return s;
}
export function maybe(s: string): BlockUid;
export function maybe(s: string): BlockUid | string {
  return s;
}
export async function later(s: string): Promise<BlockUid>;
export async function later(s: string): Promise<string> {
  return Promise.resolve(s);
}
export function check(s: string): s is BlockUid;
export function check(s: string): boolean {
  return s.length > 0;
}
export class Minter {
  make(s: string): BlockUid;
  make(s: string): string {
    return s;
  }
}
export function copied(s: string): BlockUid[];
export function copied(s: string): readonly (BlockUid | string)[] {
  return [s];
}
export function awaited(s: string): Promise<BlockUid>;
export function awaited(s: string): PromiseLike<BlockUid | string> {
  return Promise.resolve(s);
}
export function tagged(s: string): Promise<BlockUid> & { t: 1 };
export function tagged(s: string): Promise<string> & { t: 1 } {
  return Object.assign(Promise.resolve(s), { t: 1 as const });
}
export function widened(s: { a: 1 }): { a: 1; uid?: BlockUid };
export function widened(s: { a: 1 }): { a: 1 } {
  return s;
}
export function make<T>(s: string): T;
export function make(s: string): unknown {
  return s;
}
export function keyed(s: string): { k: 1; uid?: undefined } | { k: 2; uid?: BlockUid };
export function keyed(s: string): { k: 1 } {
  return { k: 1, ...{ s } };
}
export function getPref<T>(key: string, fallback?: T): T;
export function getPref(key: string, fallback?: unknown): unknown {
  return localStorage.getItem(key) ?? fallback;
}
export function collect<T>(s: string, into: T[]): T;
export function collect(s: string, into: unknown[]): unknown {
  into.push(s);
  return s;
}
export function first<T>(xs: readonly T[]): T | undefined;
export function first(xs: readonly unknown[]): unknown {
  return xs[0];
}
export function identity<T>(x: T): T;
export function identity(x: unknown): unknown {
  return x;
}
export function pick<T>(x: T, label: string): T;
export function pick<T>(x: T, label?: string): T {
  void label;
  return x;
}
export function firstOf<T>(xs: readonly T[]): T | undefined;
export function firstOf<T>(xs: readonly T[], n?: number): T | undefined {
  return xs[n ?? 0];
}
interface Plain {
  k: 1;
}
export function exact(s: string): Plain | { k: 2; uid?: BlockUid };
export function exact(s: string): Plain {
  return { k: 1, ...{ s } };
}
