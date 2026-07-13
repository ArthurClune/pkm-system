// pattern: Imperative Shell
// sync_client_meta accessors. Keys in use: "cursor" (last applied feed
// seq), "generation" (server DB generation token, pkm-o9o5),
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
