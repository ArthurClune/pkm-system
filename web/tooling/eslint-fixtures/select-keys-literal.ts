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
