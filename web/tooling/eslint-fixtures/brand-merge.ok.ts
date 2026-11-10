import type { BlockUid } from "../../src/api/brands";
export class Q {}
export interface Q {
  label: string;
}
export class Maker {
  make(): BlockUid | null {
    return null;
  }
}
export interface Maker {
  make(): BlockUid;
}
declare global {
  interface Window {
    ambientName: string;
  }
}
