import type { Columns } from "../../src/replica/columns.gen";
import type { ReplicaDb } from "../../src/replica/db";
export function load(db: ReplicaDb) {
  return db.select("SELECT uid FROM blocks", ["uid"]);
}
// A select implementation passes its generic K through unchanged.
export const wrapped = (db: ReplicaDb): ReplicaDb => ({
  ...db,
  select<const K extends keyof Columns>(
    sql: string, keys: readonly [K, ...K[]],
  ) {
    return db.select(sql, keys);
  },
});
export const viaProperty = (db: ReplicaDb) => ({
  select: <K extends keyof Columns>(sql: string, keys: K[]) =>
    db.select(sql, keys),
});
export class Wrapper {
  constructor(private db: ReplicaDb) {}
  select<const K extends keyof Columns>(
    sql: string, keys: readonly [K, ...K[]],
  ) {
    return this.db.select(sql, keys);
  }
}
// Only ReplicaDb's select is governed.
export const other = {
  select: (sql: string, keys: string[]) => [sql, keys],
};
export const run = (ks: string[]) => other.select("x", ks);
