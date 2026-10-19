import type { BlockUid } from "../../src/api/brands";

declare global {
  var ambientUid: BlockUid;
  function ambientFn(): BlockUid;
}
declare namespace Ns {
  const inner: BlockUid;
  function innerFn(): BlockUid;
  class Inner {
    label: BlockUid;
    make(): BlockUid;
  }
}
export class Fields {
  declare uid: BlockUid;
}
export declare class Ambient {
  uid: BlockUid;
  make(): BlockUid;
}
export { Ns };
