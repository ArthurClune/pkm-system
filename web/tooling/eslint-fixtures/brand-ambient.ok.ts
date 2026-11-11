declare global {
  var ambientName: string;
  function ambientFn(): string;
}
declare namespace Ns {
  const inner: string;
  function innerFn(): string;
  class Inner {
    label: string;
    make(): string;
  }
}
export class Fields {
  declare label: string;
}
export declare class Ambient {
  label: string;
  make(): string;
}
export { Ns };
