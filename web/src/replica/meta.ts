// pattern: Imperative Shell
// sync_client_meta accessors. Keys in use: "cursor" (last applied feed
// seq), "generation" (server DB generation token, pkm-o9o5),
// "plain_space_title_canonicalization" ("0"/"1" server activation), and
// "schema_version" (DDL stamp for mismatch recovery).

import type { ReplicaDb } from "./db";

export function getMeta(db: ReplicaDb, key: string): string | null {
  const rows = db.select<{ value: string }>(
    "SELECT value FROM sync_client_meta WHERE key = ?", [key]);
  return rows.length > 0 ? rows[0].value : null;
}

export function setMeta(db: ReplicaDb, key: string, value: string): void {
  db.exec(
    "INSERT INTO sync_client_meta(key, value) VALUES (?, ?)" +
    " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value]);
}

export function plainSpaceTitleCanonicalizationActive(db: ReplicaDb): boolean {
  return getMeta(db, "plain_space_title_canonicalization") === "1";
}

export function setPlainSpaceTitleCanonicalization(
    db: ReplicaDb, active: boolean): void {
  setMeta(db, "plain_space_title_canonicalization", active ? "1" : "0");
}
