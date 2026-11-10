import type { BlockUid } from "./api/brands";
import type { SyncProblem } from "./sync/syncState";
import { offType, uidOf } from "./test-helpers";
export const d = uidOf("tuid-a");
export const e = offType<{ uid: BlockUid }>({ uid: uidOf("tuid-a") });
export const f = offType<{ w: { uid: BlockUid } }>(
  { w: { uid: uidOf("tuid-a") } });
const typed = { uid: uidOf("tuid-a"), note: 1 };
export const g = offType<{ uid: BlockUid }>(typed);
export const h = offType<unknown>(crypto.subtle);
export const a = offType<SyncProblem>({ kind: "brand-new" });
export const b = offType<{ label: string }>({ label: 1 });
export const c: unknown = offType(3);
