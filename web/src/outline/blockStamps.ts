// pattern: Functional Core
// Block timestamps in the page margin (bean pkm-4ler): which instant a row
// shows, which age band tints it, how it reads, and which ops count as a
// change. Clockless by construction -- "now" always arrives as an argument,
// so the reducer and the renderer can be tested without touching the clock.
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";

export type StampBand = "week" | "month" | "year" | "older";

const DAY_MS = 24 * 60 * 60 * 1000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November",
                     "December"];

/** The instant a row displays: last change, falling back to creation.
 * created_at is a fallback for a missing updated_at, never a second column.
 * Null means the tree knows neither -- rendered as an empty cell, not an
 * omitted one, so the column stays a column. */
export function stampTs(
  node: Pick<BlockNode, "created_at" | "updated_at">,
): number | null {
  return node.updated_at ?? node.created_at ?? null;
}

/** Warm-for-fresh age bands. Inclusive upper edges: exactly 7 days old is
 * still "week". A future ts (clock skew between devices) lands in "week"
 * rather than wrapping round to "older". */
export function stampBand(nowMs: number, ts: number): StampBand {
  const ageDays = (nowMs - ts) / DAY_MS;
  if (ageDays <= 7) return "week";
  if (ageDays <= 31) return "month";
  if (ageDays <= 365) return "year";
  return "older";
}

/** "3 Aug 26" -- compact and precise; the band tint carries recency, so the
 * text carries what colour cannot. Local time: the user's own day is what a
 * peripheral cue is about. */
export function formatStamp(ts: number): string {
  const d = new Date(ts);
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${yy}`;
}

/** Hover precision for the cell's title attribute: "3 August 2026, 14:22". */
export function formatStampTitle(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()}`
    + `, ${hh}:${mm}`;
}

/** Does this op change its target block, in the sense pkm-r7k8 settled?
 * This is the same rule replica/localOps.ts applies when it writes
 * updated_at, kept here as one pure predicate so the replica's stored date
 * and the displayed date cannot drift apart. Notably set_collapsed is NOT a
 * change. delete and create_page bump no surviving block. */
export function opBumpsUpdatedAt(op: BlockOp): boolean {
  switch (op.op) {
    case "create":
    case "update_text":
    case "move":
    case "set_heading":
    case "set_view_type":
      return true;
    case "set_collapsed":
    case "delete":
    case "create_page":
      return false;
  }
}

/** The uids a batch marks as changed, in first-seen order and deduplicated.
 * Callers still have to check the uid survives in their own tree -- ops for
 * other pages and blocks the batch deleted must not be stamped. */
export function bumpedUids(ops: readonly BlockOp[]): string[] {
  const uids: string[] = [];
  for (const op of ops) {
    if (op.op === "create_page" || !opBumpsUpdatedAt(op)) continue;
    if (!uids.includes(op.uid)) uids.push(op.uid);
  }
  return uids;
}
