import type { BlockUid } from "../../src/api/brands";
export type Handler = (uid: BlockUid) => void;
export class Holder {
  constructor(private readonly uid: BlockUid) {}
}
export function rest(...uids: BlockUid[]): void {
  void uids;
}
export interface Callable {
  (uid: BlockUid): void;
  new (uid: BlockUid): object;
}
