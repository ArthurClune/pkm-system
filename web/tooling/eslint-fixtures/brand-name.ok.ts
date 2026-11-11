import type { BlockUid, PageId } from "../../src/api/brands";
export function lookup(uid: BlockUid): BlockUid {
  return uid;
}
export interface Row {
  pageId: PageId;
}
// A name an object inherits is not a registry name.
export interface Inherited {
  toString: () => string;
  constructor: number;
}
export const echo = (valueOf: number): number => valueOf;
