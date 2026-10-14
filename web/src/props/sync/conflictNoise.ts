// pattern: Functional Core
// The "conflict noise" invariant. A hashed update_text whose base no longer
// matches the block lands the text it overwrote under a daily-note header
// `[[conflict]] … — overwritten by ((uid))` (check 5). That is the server's
// answer to two devices editing one block concurrently; a device's own edit
// chain must never meet it, whatever renames, deletes and faults ran in
// between. So every such header must be about a block whose text at least
// two clients wrote. Other headers (a missing block's edit, a diverged
// delete, a stuck move) are not about concurrent edits and are exempt.
//
// One single-client conflict is allowed: the one a lane write causes. When
// a client's local write fails (writeFails), the in-memory lane sends the
// ops as they were made, without the base_text_hash the replica stamps, and
// the replica never applies them. So the client's next durable write of
// that block is hashed against the text before the lane write and lands a
// conflict; opQueue's drain names that conflict as the lane's guard against
// a durable row overwriting the lane's newer text. Only that write is
// excused: its ack and echo bring the server's text back to the replica,
// so a later conflict on the block by the same client is noise again.
import type { BatchId } from "../../api/brands";
import type { ConflictRecord } from "./serverControl";

const OVERWRITTEN = / — overwritten by \(\(([^()\s]+)\)\)$/;

/** The block an overwritten (check 5) header is about, or null for any
 * other header. */
export function overwrittenTarget(header: string): string | null {
  return OVERWRITTEN.exec(header)?.[1] ?? null;
}

export interface ConflictNoiseRun {
  /** applied_batches in commit order. */
  applied: readonly { batch_id: BatchId }[];
  /** Client name -> the request bodies its transport committed, by batch. */
  committedBy: ReadonlyMap<string, ReadonlyMap<BatchId, string>>;
  /** Batches sent from a client's in-memory lane after a failed local write. */
  lane: ReadonlySet<BatchId>;
  /** Every conflict header the run wrote, in commit order. */
  conflicts: readonly ConflictRecord[];
}

/** One applied batch's text writes: its client and the uids it created or
 * update_text'ed. */
interface TextWrite { batch: BatchId; client: string; uids: Set<string> }

function textWrites(run: Pick<ConflictNoiseRun, "applied" | "committedBy">): TextWrite[] {
  return run.applied.flatMap(({ batch_id }) => [...run.committedBy].flatMap(([client, committed]) => {
    const body = committed.get(batch_id);
    if (body === undefined) return [];
    const parsed = JSON.parse(body) as { ops?: { op?: unknown; uid?: unknown }[] };
    const uids = new Set((parsed.ops ?? [])
      .filter((op) => op.op === "create" || op.op === "update_text")
      .flatMap((op) => (typeof op.uid === "string" ? [op.uid] : [])));
    return [{ batch: batch_id, client, uids }];
  }));
}

/** Per block uid, the clients whose applied batches wrote its text (a
 * create or an update_text of it). */
export function textEditors(run: Pick<ConflictNoiseRun, "applied" | "committedBy">):
    Map<string, Set<string>> {
  const editors = new Map<string, Set<string>>();
  for (const w of textWrites(run)) {
    for (const uid of w.uids) editors.set(uid, (editors.get(uid) ?? new Set()).add(w.client));
  }
  return editors;
}

/** Whether `batch` is its client's first durable write of `uid` after a
 * lane batch of that client wrote it: the one conflict a lane causes. */
function laneCaused(writes: readonly TextWrite[], lane: ReadonlySet<BatchId>,
                    batch: BatchId, uid: string): boolean {
  const client = writes.find((w) => w.batch === batch)?.client;
  let afterLane = false;
  for (const w of writes) {
    if (w.client !== client || !w.uids.has(uid)) continue;
    if (lane.has(w.batch)) {
      afterLane = true;
      continue;
    }
    if (w.batch === batch) return afterLane;
    afterLane = false;
  }
  return false;
}

/** One finding per overwritten header about a block fewer than two clients
 * wrote, unless a lane write of its client caused it. */
export function conflictNoise(run: ConflictNoiseRun): string[] {
  const writes = textWrites(run);
  const editors = textEditors(run);
  return run.conflicts.flatMap((c) => {
    const target = overwrittenTarget(c.text);
    if (target === null) return [];
    const who = [...(editors.get(target) ?? [])].sort();
    if (who.length >= 2) return [];
    if (c.batch_id !== null && laneCaused(writes, run.lane, c.batch_id, target)) return [];
    return [`${c.batch_id ?? "an unrecorded batch"} overwrote ${target} as a conflict` +
            ` (header ${c.header_uid}),` +
            ` but ${who.length === 0 ? "no client" : `only ${who[0]}`} wrote its text`];
  });
}
