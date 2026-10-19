export type Handler = (uid: string) => void;
export type Maker = new (uid: string) => object;
export interface Svc {
  lookup(uid: string): void;
}
export class Holder {
  constructor(private readonly uid: string) {}
}
export function rest(...uids: string[]): void {
  void uids;
}
export declare function declared(uid: string): void;
export abstract class Base {
  abstract find(uid: string): void;
}
