import type { ReplicaDb } from "../../src/replica/db";
import type { Columns } from "../../src/replica/columns.gen";

export function load(db: ReplicaDb) {
  const keys: (keyof Columns)[] = ["uid", "text"];
  const widened = db.select("SELECT uid, text FROM blocks", keys as ["uid"]);
  const computed = db.select("SELECT uid FROM blocks", [`uid`]);
  return [widened, computed];
}
