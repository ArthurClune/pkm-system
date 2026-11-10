import type { BlockUid } from "../../src/api/brands";
export function call(f: (uid: BlockUid) => void, uid: BlockUid): void {
  f(uid);
  f.call(undefined, uid);
}
interface Row {
  uid: BlockUid;
  text: string;
}
export function write(row: Row): void {
  Object.assign(row, { text: "t" });
  Object.defineProperty(row, "text", { value: "t" });
  Object.defineProperties(row, { text: { value: "t" } });
}
export function dynamic(o: object, key: string): void {
  Object.defineProperty(o, key, { value: 1 });
}
export function branded(row: Row, uid: BlockUid, other: Row): void {
  Object.assign(row, { uid });
  Object.assign({}, other);
  Object.defineProperty(row, "uid", { value: uid });
  Reflect.set(row, "uid", uid);
}
export const sameKind = (x: unknown) => x instanceof Object;
