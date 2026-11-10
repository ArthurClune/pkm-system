import type { BlockUid } from "../../src/api/brands";

export class Q {}
export interface Q {
  uid: BlockUid;
}
export class Maker {
  make(): string {
    return "";
  }
}
export interface Maker {
  make(): BlockUid;
}
declare global {
  interface Window {
    ambientUid: BlockUid;
  }
}
