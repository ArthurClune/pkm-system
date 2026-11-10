export const parse: <T>(s: string) => T = JSON.parse;
export declare function mk<T>(s: string): T;
export declare const made: <T>(s: string) => T;
export class Store {
  read: <T>(s: string) => T = JSON.parse;
}
interface Reader {
  get<T>(s: string): T;
}
export class Impl implements Reader {
  get = JSON.parse;
}
export const obj: Reader = { get: JSON.parse };
