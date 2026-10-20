// pattern: Imperative Shell
// The replica's page lookup by title: the canonical form a page is stored
// under, and the page that already holds it. localOps.ts creates a page when
// none does; its placement facts only ever look one up.

import type { CanonicalTitle, PageId, RawTitle } from "../api/brands";
import type { ReplicaDb } from "./db";
import { type TitleReader, titleReader } from "./meta";

/** The title a page is stored under: canonicalised, blank as "Untitled". */
export const storedPageTitle = (read: TitleReader,
                                title: RawTitle): CanonicalTitle => {
  const canonical = read(title);
  return canonical.trim().length === 0 ? read("Untitled") : canonical;
};

export const localPageTitle = (db: ReplicaDb, title: RawTitle): CanonicalTitle =>
  storedPageTitle(titleReader(db), title);

export const pageIdByTitle = (db: ReplicaDb, title: CanonicalTitle): PageId | null => {
  const rows = db.select(
    "SELECT id AS page_id FROM pages WHERE title = ?", ["page_id"], [title]);
  return rows.length > 0 ? rows[0].page_id : null;
};

/** The page getOrCreateLocalPage would return for `title`, if it exists
 * already; never creates one. */
export const existingLocalPageId = (db: ReplicaDb, title: RawTitle):
  PageId | null => pageIdByTitle(db, localPageTitle(db, title));
