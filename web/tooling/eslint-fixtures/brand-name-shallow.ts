import type { BlockUid } from "../../src/api/brands";

export function union(uid: BlockUid | string): void {
  void uid;
}
export function mixed(uid: string | { x: BlockUid }): void {
  void uid;
}
export function set(uids: ReadonlySet<string>): void {
  void uids;
}
export function tuple(uids: [BlockUid, string]): void {
  void uids;
}
export function nested(uid: { inner: BlockUid }): void {
  void uid;
}
