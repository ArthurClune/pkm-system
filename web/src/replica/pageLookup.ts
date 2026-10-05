// pattern: Imperative Shell
// The replica's page lookup by title: the canonical form a page is stored
// under, and the page that already holds it. localOps.ts creates a page when
// none does; the effect ledger's restore only ever looks one up.

import type { CanonicalTitle, PageId } from "../api/brands";
import type { ReplicaDb } from "./db";
import { type TitleReader, titleReader } from "./meta";

/** The title a page is stored under: canonicalised, blank as "Untitled". */
export const storedPageTitle = (read: TitleReader,
                                title: string): CanonicalTitle => {
  const canonical = read(title);
  return canonical.trim().length === 0 ? read("Untitled") : canonical;
};

export const localPageTitle = (db: ReplicaDb, title: string): CanonicalTitle =>
  storedPageTitle(titleReader(db), title);

export const pageIdByTitle = (db: ReplicaDb, title: CanonicalTitle): PageId | null => {
  const rows = db.select<{ id: PageId }>(
    "SELECT id FROM pages WHERE title = ?", [title]);
  return rows.length > 0 ? rows[0].id : null;
};

/** The page getOrCreateLocalPage would return for `title`, if it exists
 * already; never creates one. */
export const existingLocalPageId = (db: ReplicaDb, title: string):
  PageId | null => pageIdByTitle(db, localPageTitle(db, title));
