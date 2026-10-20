// pattern: Functional Core
// Page deletes in the sync oracle. A batch is stale for a title when a
// recorded deletion of it has a journal seq past the batch's seen_seq, and
// the server keeps a stale batch from re-creating the page. Two things
// follow here:
//   - the seen_seq a recorded body is replayed with: the replay's journal
//     need not number its rows as the faulted run's did, so a seen_seq is
//     moved to the same place among the deletes, and the batch is stale in
//     the replay for exactly the titles it was stale for in the faulted run;
//   - the "delete wins" invariant over the faulted run's final state.
import type { BatchId, BlockUid, CanonicalTitle, PageId } from "../../api/brands";
import { extractRefs } from "../../grammar/refs";
import type { DeleteRecord, RenameRecord } from "./serverControl";
import { record } from "./wire";

/** Past any journal: the server treats a seen_seq beyond its journal's head
 * as coming from a replaced database, stale for every recorded title. */
export const BEYOND_ANY_SEQ = Number.MAX_SAFE_INTEGER;

/** The server prunes a deletion record this long after the delete
 * (BLOCK_REWRITE_RETENTION_MS), and only when a later page delete runs. */
const DELETION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The seen_seq to replay `seen` with. `faulted` and `replayed` are the
 * journal seqs of the same deletes, in commit order, in the faulted run and
 * so far in the replay. It maps to the replay's seq of the last delete
 * whose faulted seq `seen` had reached (0 before any), so exactly the
 * deletes after that one are newer than it in both runs. Null when the
 * replay has not made that delete. */
export function replaySeenSeq(seen: number, faulted: readonly number[],
                              replayed: readonly number[],
                              faultedLatest: number): number | null {
  if (seen > faultedLatest) return BEYOND_ANY_SEQ;
  const passed = faulted.filter((at) => at <= seen).length;
  if (passed === 0) return 0;
  return replayed[passed - 1] ?? null;
}

/** `body` with its seen_seq put through `map`: the same string when it
 * carries none, null when `map` has no answer. */
export function withSeenSeq(body: string,
                            map: (seen: number) => number | null): string | null {
  const parsed = record(JSON.parse(body), "ops body");
  if (typeof parsed.seen_seq !== "number") return body;
  const next = map(parsed.seen_seq);
  return next === null ? null : JSON.stringify({ ...parsed, seen_seq: next });
}

export interface DeleteWinsRun {
  /** applied_batches in commit order. */
  applied: readonly { batch_id: BatchId; applied_at: number }[];
  committed: ReadonlyMap<BatchId, string>;
  renames: readonly RenameRecord[];
  deletes: readonly DeleteRecord[];
  snapshot: {
    pages: readonly { id: PageId; title: CanonicalTitle }[];
    blocks: readonly { uid: BlockUid; page_id: PageId }[];
  };
}

interface ParsedBody { seen?: number; ops: Record<string, unknown>[] }

const parse = (body: string | undefined): ParsedBody => {
  const parsed = record(JSON.parse(body ?? "{}"), "ops body");
  const ops: unknown[] = Array.isArray(parsed.ops) ? parsed.ops : [];
  return {
    ...(typeof parsed.seen_seq === "number" ? { seen: parsed.seen_seq } : {}),
    ops: ops.flatMap((op) => (op !== null && typeof op === "object" ? [record(op, "op")] : [])),
  };
};

/** Whether an op names `title` where it could make the page: its
 * page_title, or a link, tag or attribute in its text. */
const names = (op: Record<string, unknown>,
                canonicalTitle: CanonicalTitle): boolean =>
  op.page_title === canonicalTitle ||
  (typeof op.text === "string" && extractRefs(op.text).refs.some((r) => r.title === canonicalTitle));

/** Delete wins, on the faulted run's final state: no block a page held
 * when it was deleted is alive, and a deleted title exists at quiescence
 * only when, after its last delete, a rename made it, or a batch named it
 * that was not stale for it: one without seen_seq, one that had seen the
 * delete, or one applied once the deletion record may have been pruned
 * (any rename, delete or batch since ran at a clock past the retention). */
export function deleteWins(run: DeleteWinsRun): string[] {
  const out: string[] = [];
  const titleOf = new Map(run.snapshot.pages.map((p) => [p.id, p.title]));
  const alive = new Map(run.snapshot.blocks.map((b) => [b.uid as string, b.page_id]));
  const where = (d: DeleteRecord): string =>
    `deleted at seq ${d.seq} after ${d.after_batch_id ?? "no batch"}`;
  for (const d of run.deletes) {
    for (const uid of d.uids) {
      const page = alive.get(uid);
      if (page !== undefined) {
        out.push(`block ${uid} was on ${d.title} when it was ${where(d)}, but is alive` +
                 ` on ${titleOf.get(page) ?? `?page ${page}`}`);
      }
    }
  }
  const index = new Map(run.applied.map((r, i) => [r.batch_id, i]));
  // The first applied batch that came after the event. One after a batch
  // that never applied is serial replay's finding; here every batch counts.
  const firstAfter = (e: { after_batch_id: BatchId | null }): number =>
    e.after_batch_id === null ? 0 : (index.get(e.after_batch_id) ?? -1) + 1;
  const lastDelete = new Map<CanonicalTitle, DeleteRecord>();
  for (const d of [...run.deletes].sort((a, b) => a.ord - b.ord)) lastDelete.set(d.title, d);
  const existing = new Set<CanonicalTitle>(run.snapshot.pages.map((p) => p.title));
  for (const [title, d] of lastDelete) {
    if (!existing.has(title)) continue;
    if (run.renames.some((r) => r.new_title === title && r.ord > d.ord)) continue;
    const from = firstAfter(d);
    // The latest clock any later delete ran at, up to and including batch i:
    // only a delete prunes, so past d.at plus the retention d's row may be
    // gone.
    const laterDeletes = run.deletes.filter((e) => e.ord > d.ord);
    let clock = d.at;
    const stale: string[] = [];
    let fresh = false;
    for (let i = from; i < run.applied.length && !fresh; i++) {
      const row = run.applied[i];
      clock = Math.max(clock,
                       ...laterDeletes.filter((e) => firstAfter(e) <= i).map((e) => e.at));
      const body = parse(run.committed.get(row.batch_id));
      if (!body.ops.some((op) => names(op, title))) continue;
      if (body.seen === undefined || body.seen >= d.seq ||
          clock > d.at + DELETION_RETENTION_MS) {
        fresh = true;
      } else {
        stale.push(`${row.batch_id} (seen_seq ${body.seen})`);
      }
    }
    if (!fresh) {
      out.push(`${title} was ${where(d)} and exists at quiescence, but no rename made` +
               ` it since and no batch since named it without being stale for it` +
               (stale.length > 0 ? `; stale batches naming it: ${stale.join(", ")}` : ""));
    }
  }
  return out;
}

/** The applied batches that named a title after its delete while stale for
 * it: the race the delete commands exist to draw, for the tally. */
export function staleNamers(run: Pick<DeleteWinsRun, "applied" | "committed" | "deletes">):
    BatchId[] {
  const index = new Map(run.applied.map((r, i) => [r.batch_id, i]));
  return run.applied.filter((row, i) => {
    const { seen, ops } = parse(run.committed.get(row.batch_id));
    return seen !== undefined && run.deletes.some((d) =>
      i > (d.after_batch_id === null ? -1 : index.get(d.after_batch_id) ?? i) &&
      seen < d.seq && ops.some((op) => names(op, d.title)));
  }).map((row) => row.batch_id);
}
