import type { BlockUid } from "../../src/api/brands";

export function isUid(x: string): x is BlockUid {
  return x.length > 0;
}
export function assertUid(x: string): asserts x is BlockUid {
  void x;
}
declare const declared: BlockUid;
declare function parseIt(text: string): BlockUid;
export { declared, parseIt };
