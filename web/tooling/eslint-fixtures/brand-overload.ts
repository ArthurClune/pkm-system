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
