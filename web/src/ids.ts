// pattern: Functional Core
// Where a raw string or number becomes an id brand: the uid and sync-seq
// parsers, the minters for a per-tab or per-batch id, and the readers of the
// journal's text entity ids. The brand registry lists this file as a mint
// site for each of them, so an `as` toward one of these brands elsewhere in
// the web fails `pnpm lint`.
import { UID_TOKEN } from "./grammar/scan";
import type {
  BatchId, BlockUid, ClientId, PageId, SidebarEntryId, SyncSeq,
} from "./api/brands";
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

/** The per-tab sync identity, from a freshly generated uid-shaped string. */
export const mintClientId = (raw: string): ClientId => raw as ClientId;

/** One id per client batch, from a freshly generated unique string. */
export const mintBatchId = (raw: string): BatchId => raw as BatchId;

/** The id of the `n`th write ticket this tab issued. */
export const mintTicketId = (n: number): TicketId => `write-${n}` as TicketId;

// The journal stores every entity id as one TEXT wire field whatever the
// kind; these read it back as the kind its tombstone names.
export const blockUidOfEntity = (id: string): BlockUid => id as BlockUid;
export const pageIdOfEntity = (id: string): PageId => Number(id) as PageId;
export const sidebarEntryIdOfEntity = (id: string): SidebarEntryId =>
  Number(id) as SidebarEntryId;
