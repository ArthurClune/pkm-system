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
}
