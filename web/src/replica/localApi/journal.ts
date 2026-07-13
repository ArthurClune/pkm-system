// pattern: Imperative Shell
// Offline /api/journal — port of routes_pages.get_journal. Today's page
// auto-creates locally (negative id, deliberately not pushed).

import { titleForDate } from "../daily";
import type { ReplicaDb } from "../db";
import { getOrCreateLocalPage } from "../localOps";
import { fetchPage } from "./pages";
import { BLOCK_COLS, type BlockRow, blockRefTexts, buildTree } from "./tree";

const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-` +
  `${String(d.getDate()).padStart(2, "0")}`;

const sameDay = (a: Date, b: Date): boolean => isoDate(a) === isoDate(b);

/** null = invalid `before` date (the caller 400s). */
export function journalPayload(db: ReplicaDb, before: string | null,
                               days: number, nowMs: number): unknown | null {
  const window = Math.max(1, Math.min(days, 31));
  const today = new Date(nowMs);
  let start: Date;
  if (before) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(before);
    if (!m) return null;
    start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(start.getTime())) return null;
  } else {
    start = new Date(today.getFullYear(), today.getMonth(),
                     today.getDate() + 1);
  }
  const out: unknown[] = [];
  const texts: string[] = [];
  for (let i = 1; i <= window; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(),
                       start.getDate() - i);
    const title = titleForDate(d);
    let page = fetchPage(db, title);
    if (page === null && sameDay(d, today)) {
      getOrCreateLocalPage(db, title, nowMs);
      page = fetchPage(db, title);
    }
    if (page === null) {
      out.push({ date: isoDate(d), title, exists: false, blocks: [] });
    } else {
      const blocks = db.select<BlockRow>(
        `SELECT ${BLOCK_COLS} FROM blocks WHERE page_id = ?`, [page.id]);
      texts.push(...blocks.map((r) => r.text));
      out.push({ date: isoDate(d), title, exists: true,
                 blocks: buildTree(blocks) });
    }
  }
  return { days: out, block_ref_texts: blockRefTexts(db, texts) };
}
