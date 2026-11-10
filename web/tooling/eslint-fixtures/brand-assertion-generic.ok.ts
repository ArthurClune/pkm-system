import type { BlockUid, PageId } from "../../src/api/brands";
export function pick<T extends BlockUid | PageId>(x: T): T {
  return x;
}
