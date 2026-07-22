// pattern: Imperative Shell
// Offline /api/journal — port of routes_pages.get_journal (pkm-03x6):
// newest-first batches of NON-EMPTY daily pages; empty days are omitted.
// The head batch auto-creates today locally (negative id, deliberately
// not pushed) so there is always a page to compose into.

import { dateForTitle, selectJournalDays, titleForDate } from "../daily";
import type { ReplicaDb } from "../db";
import { getOrCreateLocalPage } from "../localOps";
import { fetchPage } from "./pages";
import { BLOCK_COLS, type BlockRow, blockRefTexts, buildTree } from "./tree";

const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-` +
  `${String(d.getDate()).padStart(2, "0")}`;

// Identical SQL to the server's _NONEMPTY_DAILY_SQL so both engines agree
// byte-for-byte on which days are non-empty (spec section 7).
const NONEMPTY_DAILY_SQL =
  "SELECT title FROM pages WHERE EXISTS ("
  + " SELECT 1 FROM blocks b WHERE b.page_id = pages.id"
  + " AND trim(b.text, char(9)||char(10)||char(13)||char(32)) <> '')";

/** null = invalid `before` date (the caller 400s). */
export function journalPayload(db: ReplicaDb, before: string | null,
                               days: number, nowMs: number): unknown | null {
  const window = Math.max(1, Math.min(days, 31));
  const now = new Date(nowMs);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let cursor: Date | null = null;
  if (before) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(before);
    if (!m) return null;
    cursor = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(cursor.getTime())) return null;
  }
  if (cursor === null && fetchPage(db, titleForDate(today)) === null) {
    getOrCreateLocalPage(db, titleForDate(today), nowMs);
  }
  const nonempty: Date[] = [];
  for (const row of db.select<{ title: string }>(NONEMPTY_DAILY_SQL)) {
    const d = dateForTitle(row.title);
    if (d !== null) nonempty.push(d);
  }
  const out: unknown[] = [];
  const texts: string[] = [];
  for (const d of selectJournalDays(nonempty, today, cursor, window)) {
    const page = fetchPage(db, titleForDate(d));
    if (page === null) continue; // unreachable: selected days exist
    const blocks = db.select<BlockRow>(
      `SELECT ${BLOCK_COLS} FROM blocks WHERE page_id = ?`, [page.id]);
    texts.push(...blocks.map((r) => r.text));
    out.push({ date: isoDate(d), title: page.title, exists: true,
               blocks: buildTree(blocks) });
  }
  return { days: out, block_ref_texts: blockRefTexts(db, texts) };
}
