// @vitest-environment node
import { expect, test } from "vitest";
import { BASE_SCHEMA } from "./baseSchema.gen";
import { createCarryStore } from "./carryStore";
import { COLUMN_KEYS, COLUMN_META, type Columns } from "./columns.gen";
import { CLIENT_DDL } from "./clientSchema";
import type { ReplicaDb } from "./db";
import { fakeCarryFiles, openRawTestDb } from "./testDb";

interface TableInfo { name: string; type: string; notnull: number; pk: number }

const tablesOf = (db: ReplicaDb) =>
  (db.introspect("SELECT name FROM sqlite_master WHERE type='table'") as { name: string }[])
    .map((r) => r.name);
const infoOf = (db: ReplicaDb, table: string) =>
  (db.introspect(`PRAGMA table_info(${table})`) as unknown as TableInfo[]);

// SQLite's declared types, as the base a key must have. An unlisted type is
// reported rather than guessed, so a new column type forces a decision here.
const DECLARED_BASE: Record<string, string> = {
  INTEGER: "int", TEXT: "text", REAL: "real", BLOB: "blob",
};

function columnProblems(db: ReplicaDb, tables: string[]): string[] {
  const problems: string[] = [];
  const metas = COLUMN_META as Record<string, (typeof COLUMN_META)[keyof Columns] | undefined>;
  for (const table of tables) {
    for (const col of infoOf(db, table)) {
      const key = COLUMN_KEYS[table]?.[col.name] ?? col.name;
      const meta = metas[key];
      if (!meta) { problems.push(`${table}.${col.name}: no key ${key}`); continue; }
      const base = DECLARED_BASE[col.type];
      if (base === undefined) {
        problems.push(`${table}.${col.name}: declared type '${col.type}' has no base`);
        continue;
      }
      if (meta.base !== base) problems.push(`${table}.${col.name}: ${key} is ${meta.base}, column is ${base}`);
      // A primary key is never NULL even when SQLite reports notnull=0.
      const nullable = col.notnull === 0 && col.pk === 0;
      if (meta.nullable !== nullable) {
        problems.push(`${table}.${col.name}: ${key} nullable=${meta.nullable}, column nullable=${nullable}`);
      }
    }
  }
  return problems;
}

test("every client column has a key of the same base type and nullability", async () => {
  const { db, close } = await openRawTestDb();
  db.exec(BASE_SCHEMA);
  const base = new Set(tablesOf(db));
  db.exec(CLIENT_DDL);
  const clientTables = tablesOf(db).filter((t) => !base.has(t) && !t.startsWith("sqlite_"));
  expect(clientTables.length).toBeGreaterThan(0);
  const problems = columnProblems(db, clientTables);
  close();
  expect(problems).toEqual([]);
});

test("the column check tells REAL and BLOB columns from text and int keys", async () => {
  const { db, close } = await openRawTestDb();
  db.exec("CREATE TABLE scratch(text REAL NOT NULL, size BLOB NOT NULL, uid NUMERIC NOT NULL)");
  const problems = columnProblems(db, ["scratch"]);
  close();
  expect(problems).toEqual([
    "scratch.text: text is text, column is real",
    "scratch.size: size is int, column is blob",
    "scratch.uid: declared type 'NUMERIC' has no base",
  ]);
});

test("the carry file's pending_ops has the shape CLIENT_DDL declares", async () => {
  const main = await openRawTestDb();
  main.db.exec(CLIENT_DDL);
  const carry = await openRawTestDb();
  createCarryStore(fakeCarryFiles(carry)).write([]);
  expect(infoOf(carry.db, "pending_ops")).toEqual(infoOf(main.db, "pending_ops"));
  main.close();
  carry.close();
});
