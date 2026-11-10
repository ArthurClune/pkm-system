import type { BlockUid } from "../../src/api/brands";

export function direct(x: string): BlockUid {
  return x as BlockUid;
}
export function viaUnknown(x: string): BlockUid {
  return x as unknown as BlockUid;
}
export function angle(x: string): BlockUid {
  return <BlockUid>x;
}
