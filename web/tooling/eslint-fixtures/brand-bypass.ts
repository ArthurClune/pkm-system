import type { BlockUid } from "../../src/api/brands";

interface Row {
  uid: BlockUid;
  text: string;
}

// Each call puts an off-type value into a branded slot past tsc.
export function reflectApply(f: (uid: BlockUid) => void): void {
  Reflect.apply(f, undefined, ["junk"]);
}
export function assign(row: Row): void {
  Object.assign(row, { uid: "junk" });
  Object.assign({}, row, { pageId: 1, parentUid: "junk" });
}
export function define(row: Row, field: "uid" | "text"): void {
  Object.defineProperty(row, "uid", { value: "junk" });
  Object.defineProperty(row, field, { value: "junk" });
  Object.defineProperties(row, { uid: { value: "junk" } });
  Reflect.defineProperty(row, "uid", { value: "junk" });
  Object.defineProperty(row, "uid", { get: () => "junk" });
}

export function source(row: Row): void {
  const junk: { uid: string } = { uid: "x" };
  Object.assign(row, junk);
  Object.assign(row, { ...junk });
  globalThis.Object.assign(row, { uid: "junk" });
}
export function reflectMore(row: Row, F: new (uid: BlockUid) => object): void {
  Reflect.set(row, "uid", "junk");
  Reflect.construct(F, ["junk"]);
}
export function aliases(row: Row): void {
  const { assign } = Object;
  const apply = Reflect.apply;
  const R = Reflect;
  Object.assign.call(Object, row, { uid: "junk" });
  void [assign, apply, R];
}
