export const parse = (s: string): unknown => JSON.parse(s) as unknown;
export function mk(s: string): unknown {
  return JSON.parse(s) as unknown;
}
export function identity<T>(x: T): T {
  return x;
}
export const alias: <T>(x: T) => T = identity;
export const keep: <T>(x: T) => T = (x) => x;
interface Reader {
  get(s: string): unknown;
}
export class Impl implements Reader {
  get(s: string): unknown {
    return JSON.parse(s) as unknown;
  }
}
