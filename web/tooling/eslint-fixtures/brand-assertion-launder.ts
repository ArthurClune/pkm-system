import type { BlockUid } from "../../src/api/brands";

export function str<T extends string>(x: string): T {
  return x as T;
}
export function num<T extends number>(x: number): T {
  return x as T;
}
export function empty<T extends {}>(x: unknown): T {
  return x as T;
}
export function obj<T extends object>(x: unknown): T {
  return x as T;
}
export function shaped<T extends { id: number }>(x: unknown): T {
  return x as T;
}
export function widened<T extends BlockUid | string>(x: string): T {
  return x as T;
}
export function nonNull<T>(x: unknown): T & {} {
  return x as T & {};
}
export function list<T>(x: unknown): T[] {
  return x as T[];
}
export function boxed<T>(x: unknown): { v: T } {
  return x as { v: T };
}
export function later<T>(x: unknown): Promise<T> {
  return x as Promise<T>;
}
export function picked<T, K extends keyof T>(x: unknown): T[K] {
  return x as T[K];
}
export function returned<F extends () => unknown>(x: unknown): ReturnType<F> {
  return x as ReturnType<F>;
}
export function mapped<T>(x: unknown): { [K in keyof T]: T[K] } {
  return x as { [K in keyof T]: T[K] };
}
