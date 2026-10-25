// pattern: Functional Core
// Readers for the JSON the proptest server answers with. Each returns the
// route's generated type, built through the checked test helpers, so a value
// outside a brand's shape fails here and names the field, instead of riding
// an assertion into the harness.
import type { Changes, Snapshot, SyncBlock, SyncPage } from "../../replica/apply";
import {
  batchIdOf, canonicalTitleOf, orderIdxOf, pageIdOf, seqOf, sidebarEntryIdOf,
  sidebarOrderIdxOf, uidOf,
} from "../../test-helpers";
import type { BatchId } from "../../api/brands";
import type { BlockOp } from "../../api/ops";
import type { OpsAck } from "../../api/payloads";
import { parsePendingOps } from "../../replica/pendingOps";
import type { ConflictRecord, DeleteRecord, RenameRecord } from "./serverControl";

type Json = Record<string, unknown>;
type Reader<T> = (raw: unknown, at: string) => T;

const fail = (at: string, want: string, raw: unknown): never => {
  throw new Error(`wire: ${at} is not ${want}: ${JSON.stringify(raw)}`);
};

export const record: Reader<Json> = (raw, at) =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? { ...raw } : fail(at, "an object", raw);

const text: Reader<string> = (raw, at) =>
  typeof raw === "string" ? raw : fail(at, "a string", raw);

const count: Reader<number> = (raw, at) =>
  typeof raw === "number" && Number.isInteger(raw) ? raw : fail(at, "an integer", raw);

const num: Reader<number> = (raw, at) =>
  typeof raw === "number" ? raw : fail(at, "a number", raw);

const flag: Reader<boolean> = (raw, at) =>
  typeof raw === "boolean" ? raw : fail(at, "a boolean", raw);

const nullable = <T>(read: Reader<T>): Reader<T | null> =>
  (raw, at) => (raw === null ? null : read(raw, at));

const optional = <T>(read: Reader<T>): Reader<T | undefined> =>
  (raw, at) => (raw === undefined ? undefined : read(raw, at));

const list = <T>(read: Reader<T>): Reader<T[]> => (raw, at) =>
  Array.isArray(raw)
    ? raw.map((item: unknown, i) => read(item, `${at}[${i}]`))
    : fail(at, "an array", raw);

const choice = <T extends string | number>(...allowed: readonly T[]): Reader<T> =>
  (raw, at) => {
    const hit = allowed.find((a) => a === raw);
    return hit === undefined ? fail(at, `one of ${allowed.join("|")}`, raw) : hit;
  };

const field = <T>(from: Json, key: string, read: Reader<T>, at: string): T =>
  read(from[key], `${at}.${key}`);

type SyncRef = SyncBlock["refs"][number];
type SyncSidebarEntry = Snapshot["sidebar"][number];
type SyncTombstone = Changes["tombstones"][number];
type SkippedOp = NonNullable<OpsAck["skipped"]>[number];
type AppliedBatch = NonNullable<Snapshot["applied_batches"]>[number];

const seq: Reader<ReturnType<typeof seqOf>> = (raw, at) => seqOf(count(raw, at));

const readPage: Reader<SyncPage> = (raw, at) => {
  const r = record(raw, at);
  return {
    id: pageIdOf(field(r, "id", count, at)),
    title: canonicalTitleOf(field(r, "title", text, at)),
    created_at: field(r, "created_at", nullable(count), at),
    updated_at: field(r, "updated_at", nullable(count), at),
  };
};

const readRef: Reader<SyncRef> = (raw, at) => {
  const r = record(raw, at);
  return {
    target_page_id: pageIdOf(field(r, "target_page_id", count, at)),
    kind: field(r, "kind", choice("link", "tag", "attribute"), at),
  };
};

const readBlock: Reader<SyncBlock> = (raw, at) => {
  const r = record(raw, at);
  const parent = field(r, "parent_uid", nullable(text), at);
  return {
    uid: uidOf(field(r, "uid", text, at)),
    page_id: pageIdOf(field(r, "page_id", count, at)),
    parent_uid: parent === null ? null : uidOf(parent),
    order_idx: orderIdxOf(field(r, "order_idx", count, at)),
    text: field(r, "text", text, at),
    heading: field(r, "heading", nullable(choice(1, 2, 3)), at),
    view_type: field(r, "view_type", nullable(choice("numbered", "document")), at),
    collapsed: field(r, "collapsed", count, at),
    created_at: field(r, "created_at", nullable(count), at),
    updated_at: field(r, "updated_at", nullable(count), at),
    refs: field(r, "refs", list(readRef), at),
  };
};

const readSidebarEntry: Reader<SyncSidebarEntry> = (raw, at) => {
  const r = record(raw, at);
  return {
    id: sidebarEntryIdOf(field(r, "id", count, at)),
    title: canonicalTitleOf(field(r, "title", text, at)),
    order_idx: sidebarOrderIdxOf(field(r, "order_idx", count, at)),
  };
};

const readTombstone: Reader<SyncTombstone> = (raw, at) => {
  const r = record(raw, at);
  return {
    kind: field(r, "kind", choice("block", "page", "sidebar"), at),
    entity_id: field(r, "entity_id", text, at),
  };
};

const readSkipped: Reader<SkippedOp> = (raw, at) => {
  const r = record(raw, at);
  const note = field(r, "note_page", nullable(text), at);
  return {
    index: field(r, "index", count, at),
    op: field(r, "op", choice("create", "update_text", "move", "delete", "set_collapsed",
                              "set_heading", "set_view_type", "create_page"), at),
    uid: uidOf(field(r, "uid", text, at)),
    reason: field(r, "reason", choice("block_not_found", "parent_not_found", "cycle",
                                      "page_deleted", "text_limit"), at),
    note_page: note === null ? null : canonicalTitleOf(note),
  };
};

const readApplied: Reader<AppliedBatch> = (raw, at) => {
  const r = record(raw, at);
  const batchSeq = field(r, "seq", nullable(count), at);
  return {
    batch_id: batchIdOf(field(r, "batch_id", text, at)),
    seq: batchSeq === null ? null : seqOf(batchSeq),
    skipped: field(r, "skipped", list(readSkipped), at),
  };
};

export const parseSnapshot = (raw: unknown): Snapshot => {
  const at = "snapshot";
  const r = record(raw, at);
  const applied = field(r, "applied_batches", optional(list(readApplied)), at);
  return {
    generation: field(r, "generation", text, at),
    plain_space_title_canonicalization:
      field(r, "plain_space_title_canonicalization", flag, at),
    seq: field(r, "seq", seq, at),
    pages: field(r, "pages", list(readPage), at),
    blocks: field(r, "blocks", list(readBlock), at),
    sidebar: field(r, "sidebar", list(readSidebarEntry), at),
    ...(applied === undefined ? {} : { applied_batches: applied }),
  };
};

export const parseChanges = (raw: unknown): Changes => {
  const at = "changes";
  const r = record(raw, at);
  const applied = field(r, "applied_batches", optional(list(readApplied)), at);
  return {
    reset: field(r, "reset", flag, at),
    generation: field(r, "generation", text, at),
    plain_space_title_canonicalization:
      field(r, "plain_space_title_canonicalization", flag, at),
    next_since: field(r, "next_since", seq, at),
    latest_seq: field(r, "latest_seq", seq, at),
    pages: field(r, "pages", list(readPage), at),
    blocks: field(r, "blocks", list(readBlock), at),
    sidebar: field(r, "sidebar", list(readSidebarEntry), at),
    tombstones: field(r, "tombstones", list(readTombstone), at),
    ...(applied === undefined ? {} : { applied_batches: applied }),
  };
};

export const parseOpsAck = (raw: unknown): OpsAck => {
  const at = "ops ack";
  const r = record(raw, at);
  const ackSeq = field(r, "seq", optional(nullable(count)), at);
  const skipped = field(r, "skipped", optional(list(readSkipped)), at);
  return {
    ok: field(r, "ok", flag, at),
    ts: field(r, "ts", num, at),
    applied: field(r, "applied", count, at),
    ...(ackSeq === undefined ? {} : { seq: ackSeq === null ? null : seqOf(ackSeq) }),
    ...(skipped === undefined ? {} : { skipped }),
  };
};

/** The two things the transport reads of a POST /api/ops body. */
export const readBatchHead = (body: string): { batchId: BatchId; opCount: number } => {
  const r = record(JSON.parse(body), "ops body");
  return {
    batchId: batchIdOf(field(r, "batch_id", text, "ops body")),
    opCount: field(r, "ops", list((op) => op), "ops body").length,
  };
};

const readRename: Reader<RenameRecord> = (raw, at) => {
  const r = record(raw, at);
  const after = field(r, "after_batch_id", nullable(text), at);
  return {
    old_title: canonicalTitleOf(field(r, "old_title", text, at)),
    new_title: canonicalTitleOf(field(r, "new_title", text, at)),
    after_batch_id: after === null ? null : batchIdOf(after),
    at: field(r, "at", num, at),
    ord: field(r, "ord", count, at),
  };
};

const readDelete: Reader<DeleteRecord> = (raw, at) => {
  const r = record(raw, at);
  const after = field(r, "after_batch_id", nullable(text), at);
  return {
    title: canonicalTitleOf(field(r, "title", text, at)),
    seq: seqOf(field(r, "seq", count, at)),
    after_batch_id: after === null ? null : batchIdOf(after),
    at: field(r, "at", num, at),
    ord: field(r, "ord", count, at),
    uids: field(r, "uids", list(text), at).map((u) => uidOf(u)),
  };
};

const readConflict: Reader<ConflictRecord> = (raw, at) => {
  const r = record(raw, at);
  const batch = field(r, "batch_id", nullable(text), at);
  return {
    header_uid: uidOf(field(r, "header_uid", text, at)),
    text: field(r, "text", text, at),
    batch_id: batch === null ? null : batchIdOf(batch),
  };
};

export const parseRenames = (raw: unknown): RenameRecord[] =>
  list(readRename)(raw, "renames");

export const parseDeletes = (raw: unknown): DeleteRecord[] =>
  list(readDelete)(raw, "deletes");

export const parseConflicts = (raw: unknown): ConflictRecord[] =>
  list(readConflict)(raw, "conflicts");

export const parseAppliedLog = (raw: unknown): { batch_id: BatchId; applied_at: number }[] =>
  list((item, at) => {
    const r = record(item, at);
    return { batch_id: batchIdOf(field(r, "batch_id", text, at)),
             applied_at: field(r, "applied_at", num, at) };
  })(raw, "applied");

/** The ops of an echo frame as the proptest server records them (its own
 * encoding of ops this harness sent), or null when none was recorded.
 * Trusts parsePendingOps: it checks nothing about the echo ops. */
export const parseEcho = (raw: unknown): BlockOp[] | null => {
  const ops = field(record(raw, "echo"), "ops", nullable(list((op) => op)), "echo");
  return ops === null ? null : parsePendingOps(JSON.stringify(ops));
};
