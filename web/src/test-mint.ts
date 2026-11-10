import type { BatchId, BlockUid, CanonicalTitle, ClientId, ConfirmId, ConversationId,
             GoodlinksId, NormalizedTitle, OrderIdx, PageId, RawTitle, Sha256Hex,
             SidebarEntryId, SidebarOrderIdx, SyncSeq } from "./api/brands";
import type { RequestId, Revision } from "./outline/outlineState";
import type { ParkedTitle } from "./replica/apply";
import type { PendingRowId } from "./replica/client";
import { BRAND_SHAPES } from "./replica/columns.gen";
import registry from "../tooling/brandRegistry.gen.json" with { type: "json" };
import type { TicketId } from "./sync/opQueue";

// The tests' one mint module (the brand registry's TEST_MINT_SITES): a
// checked helper per brand, `<stem>Of`, named from its TEST_HELPERS. Each
// throws unless the value fits the brand's shape (BRAND_SHAPES) or base
// type, so a fixture value is always one the product could have produced:
// a short tag becomes a uid as `tuid-<tag>` (`uidOf("tuid-a")`). A negative
// test forges a bad value with `malformedUid`, `malformedSha`, `malformedSeq`
// or `malformedCanonicalTitle`, which return it unchecked. Product code may
// not import this module (the lint's no-restricted-imports).
//
// It imports nothing that runs only under vitest, so the Playwright specs
// mint here too; test-helpers.ts re-exports it for the unit tests.

// The base type of the web's own brands, which the server's BRAND_SHAPES
// does not list.
const WEB_BASES: { readonly [brand: string]: "int" | "text" } = {
  PendingRowId: "int",
  TicketId: "text",
  RequestId: "int",
  Revision: "int",
  ParkedTitle: "text",
};

// brand -> the `malformed<Stem>` forger the registry lists for it.
const FORGERS: { readonly [brand: string]: string } = Object.fromEntries(
  Object.entries<string>(registry.malformed)
    .map(([brand, stem]) => [brand, `malformed${stem.charAt(0).toUpperCase()}${stem.slice(1)}`]),
);

// Throws unless `value` fits `brand`. The parameter types already say
// string or number; the check repeats it at run time, where a value read
// from JSON or `unknown` has no type to keep it honest.
function check(brand: string, value: string | number): void {
  const shape: (typeof BRAND_SHAPES)[string] | undefined = BRAND_SHAPES[brand];
  const base = shape?.base ?? WEB_BASES[brand];
  if (base === "int") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(`${brand} takes an integer, not ${JSON.stringify(value)}`);
    }
    return;
  }
  if (typeof value !== "string") {
    throw new Error(`${brand} takes a string, not ${JSON.stringify(value)}`);
  }
  const pattern = shape?.pattern ?? null;
  if (pattern !== null && !new RegExp(`^(?:${pattern})$`).test(value)) {
    const forger = FORGERS[brand];
    throw new Error(`${JSON.stringify(value)} is not a valid ${brand}`
      + (forger === undefined ? "" : `; a negative test forges one with ${forger}`));
  }
}

export function uidOf(value: string): BlockUid {
  check("BlockUid", value);
  return value as BlockUid;
}
export function pageIdOf(value: number): PageId {
  check("PageId", value);
  return value as PageId;
}
export function sidebarEntryIdOf(value: number): SidebarEntryId {
  check("SidebarEntryId", value);
  return value as SidebarEntryId;
}
export function orderIdxOf(value: number): OrderIdx {
  check("OrderIdx", value);
  return value as OrderIdx;
}
export function sidebarOrderIdxOf(value: number): SidebarOrderIdx {
  check("SidebarOrderIdx", value);
  return value as SidebarOrderIdx;
}
export function seqOf(value: number): SyncSeq {
  check("SyncSeq", value);
  return value as SyncSeq;
}
export function clientIdOf(value: string): ClientId {
  check("ClientId", value);
  return value as ClientId;
}
export function batchIdOf(value: string): BatchId {
  check("BatchId", value);
  return value as BatchId;
}
export function shaOf(value: string): Sha256Hex {
  check("Sha256Hex", value);
  return value as Sha256Hex;
}
export function conversationIdOf(value: string): ConversationId {
  check("ConversationId", value);
  return value as ConversationId;
}
export function confirmIdOf(value: string): ConfirmId {
  check("ConfirmId", value);
  return value as ConfirmId;
}
export function goodlinksIdOf(value: string): GoodlinksId {
  check("GoodlinksId", value);
  return value as GoodlinksId;
}
export function rawTitleOf(value: string): RawTitle {
  check("RawTitle", value);
  return value as RawTitle;
}
export function normalizedTitleOf(value: string): NormalizedTitle {
  check("NormalizedTitle", value);
  return value as NormalizedTitle;
}
export function canonicalTitleOf(value: string): CanonicalTitle {
  check("CanonicalTitle", value);
  return value as CanonicalTitle;
}
export function pendingRowIdOf(value: number): PendingRowId {
  check("PendingRowId", value);
  return value as PendingRowId;
}
export function ticketIdOf(value: string): TicketId {
  check("TicketId", value);
  return value as TicketId;
}
export function requestIdOf(value: number): RequestId {
  check("RequestId", value);
  return value as RequestId;
}
export function revisionOf(value: number): Revision {
  check("Revision", value);
  return value as Revision;
}
export function parkedTitleOf(value: string): ParkedTitle {
  check("ParkedTitle", value);
  return value as ParkedTitle;
}

/** A deliberately bad uid for a negative test, unchecked. */
export function malformedUid(value: string | null): BlockUid { return value as BlockUid; }
/** A deliberately bad digest for a negative test, unchecked. */
export function malformedSha(value: string): Sha256Hex { return value as Sha256Hex; }
/** A deliberately bad seq (NaN, a float) for a negative test, unchecked. */
export function malformedSeq(value: number): SyncSeq { return value as SyncSeq; }
/** A deliberately bad title (null: a missing one) for a negative test. */
export function malformedCanonicalTitle(value: string | null): CanonicalTitle {
  return value as CanonicalTitle;
}

/** Deliberate junk for a runtime guard (an exhaustiveness throw, defensive
 * parsing): the one declared way for a test to feed code that runs a value
 * its type forbids. Never for a value the test then treats as valid. */
export function offType<T>(value: unknown): T {
  return value as T;
}
