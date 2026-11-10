import type { BlockUid, PageId } from "../../src/api/brands";
export function lookup(uid: BlockUid): BlockUid {
  return uid;
}
export interface Row {
  pageId: PageId;
}
