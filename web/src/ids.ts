// pattern: Functional Core
// Where an untrusted string or number becomes an id brand: the block uid and
// sync-seq parsers, and the numbered write-ticket id. The brand registry
// lists this file as a mint site for them, so an `as` toward one of these
// brands elsewhere in the web fails `pnpm lint`.
import { UID_TOKEN } from "./grammar/scan";
import type { BlockUid, SyncSeq } from "./api/brands";
import type { TicketId } from "./sync/opQueue";

const FULL_UID_RE = new RegExp(`^${UID_TOKEN}$`);

/** Validates an untrusted string against a block uid's shape, for a uid that
 * arrives unparsed, such as a URL hash. */
export function parseBlockUid(raw: string): BlockUid | null {
  return FULL_UID_RE.test(raw) ? (raw as BlockUid) : null;
}

/** A sync cursor from an untrusted value: a finite number, else null. */
export function parseSyncSeq(raw: unknown): SyncSeq | null {
  return typeof raw === "number" && Number.isFinite(raw)
    ? (raw as SyncSeq) : null;
}

/** Where every replica's cursor starts, before any window or snapshot. */
export const INITIAL_SEQ = 0 as SyncSeq;

/** The id of the `n`th write ticket this tab issued. */
export const mintTicketId = (n: number): TicketId => `write-${n}` as TicketId;
