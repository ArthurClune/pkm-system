import type { BlockUid } from "../../src/api/brands";
import { parseBlockUid } from "../../src/ids";
export function direct(x: string): BlockUid | null {
  return parseBlockUid(x);
}
