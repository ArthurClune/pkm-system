import type { Columns } from "../../src/replica/columns.gen";
import type { ReplicaDb } from "../../src/replica/db";

const SQL = "SELECT uid, text FROM blocks";

export function load(
  db: ReplicaDb,
  wide: (keyof Columns)[],
  union: ("uid" | "text")[],
  args: [string, ["uid"]],
  name: string,
) {
  return [
    // a variable typed as every column
    db.select(SQL, wide as ["uid"]),
    // a variable of a concrete union
    db.select(SQL, union as ["uid"]),
    // a spread inside the array
    db.select(SQL, [...union] as ["uid"]),
    // a template literal is not a string literal element
    db.select(SQL, [`uid`]),
    // a non-array expression
    db.select(SQL, wide),
    // spread arguments hide the keys
    db.select(...args),
    // a computed callee hides the method
    db["select"](SQL, ["uid"]),
    db[name](SQL, ["uid"]),
  ];
}

// a free generic helper forwards a K its callers never pass through select
export function sel<K extends keyof Columns>(
  db: ReplicaDb, sql: string, keys: readonly [K, ...K[]],
) {
  return db.select(sql, keys);
}

// a property not named select is a free helper too
export const helpers = (db: ReplicaDb) => ({
  other: <K extends keyof Columns>(sql: string, keys: K[]) =>
    db.select(sql, keys),
});
