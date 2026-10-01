// pattern: Imperative Shell
// sync_client_meta accessors. Keys in use: "cursor" (last applied feed
// seq), "generation" (server DB generation token),
// "plain_space_title_canonicalization" ("0"/"1" server activation), and
// "schema_version" (DDL stamp for mismatch recovery).

import type { CanonicalTitle } from "../api/brands";
import type { ReplicaDb } from "./db";
import { canonicalizeTitle } from "./titles";

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

/** A title arriving as a lookup key (a URL path, a request body, an op's
 * page_title), canonicalised under this replica's live flag: the form
 * `pages.title` / `sidebar_entries.title` store. Mirrors the server's
 * sync_meta.read_title. */
export function canonicalTitle(db: ReplicaDb, title: string): CanonicalTitle {
  return titleReader(db)(title);
}

/** `canonicalTitle` for an operation that canonicalises several titles: the
 * flag is read once, not once per title (sync_meta.title_reader). The flag
 * it read rides along, so a caller that also branches on it needs no second
 * read. */
export type TitleReader = ((title: string) => CanonicalTitle) &
  { readonly plainSpaceActive: boolean };

export function titleReader(db: ReplicaDb): TitleReader {
  const plainSpaceActive = plainSpaceTitleCanonicalizationActive(db);
  return Object.assign(
    (title: string) => canonicalizeTitle(title, plainSpaceActive) as CanonicalTitle,
    { plainSpaceActive });
}

export function setPlainSpaceTitleCanonicalization(
    db: ReplicaDb, active: boolean): void {
  setMeta(db, "plain_space_title_canonicalization", active ? "1" : "0");
}
