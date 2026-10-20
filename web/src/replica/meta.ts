// pattern: Imperative Shell
// sync_client_meta accessors. Keys in use: "cursor" (last applied feed
// seq), "generation" (server DB generation token),
// "plain_space_title_canonicalization" ("0"/"1" server activation),
// "schema_version" (DDL stamp for mismatch recovery), and
// "deferred_block_tombstones" (JSON {cursor, uids}: block uids a catch-up
// has tombstoned short of the journal head, and the cursor stored with
// them; absent when none, void if the cursor differs, see applyWindow).

import type { CanonicalTitle } from "../api/brands";
import type { ReplicaDb } from "./db";
import { type TitleReader, titleReaderFor } from "./titles";

export function getMeta(db: ReplicaDb, key: string): string | null {
  const rows = db.select(
    "SELECT value AS client_meta_value FROM sync_client_meta WHERE key = ?", ["client_meta_value"],
    [key]);
  return rows.length > 0 ? rows[0].client_meta_value : null;
}

export function setMeta(db: ReplicaDb, key: string, value: string): void {
  db.exec(
    "INSERT INTO sync_client_meta(key, value) VALUES (?, ?)" +
    " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value]);
}

export function deleteMeta(db: ReplicaDb, key: string): void {
  db.exec("DELETE FROM sync_client_meta WHERE key = ?", [key]);
}

export function plainSpaceTitleCanonicalizationActive(db: ReplicaDb): boolean {
  return getMeta(db, "plain_space_title_canonicalization") === "1";
}

/** A title arriving as a lookup key (a URL path, a request body, an op's
 * page_title), canonicalised under this replica's live flag: the form
 * `pages.title` / `sidebar_entries.title` store. Mirrors the server's
 * sync_meta.read_title. */
export function canonicalTitle(db: ReplicaDb, title: string): CanonicalTitle {
  return titleReader(db)(title);
}

export type { TitleReader } from "./titles";

export function titleReader(db: ReplicaDb): TitleReader {
  return titleReaderFor(plainSpaceTitleCanonicalizationActive(db));
}

export function setPlainSpaceTitleCanonicalization(
    db: ReplicaDb, active: boolean): void {
  setMeta(db, "plain_space_title_canonicalization", active ? "1" : "0");
}
