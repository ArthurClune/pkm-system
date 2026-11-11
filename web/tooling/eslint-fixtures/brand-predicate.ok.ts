import type { BlockUid } from "../../src/api/brands";
import { parseBlockUid } from "../../src/ids";
export function parse(x: string): BlockUid | null {
  return parseBlockUid(x);
}
