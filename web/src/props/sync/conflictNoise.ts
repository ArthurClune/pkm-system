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
// One device does count as two writers: a client whose local write failed
// (writeFails) and the same client's later durable edits. The in-memory lane
// sends the failed write's ops as they were made, without the base_text_hash
// the replica stamps, and the replica never applied them, so the client's
// next hashed edit of that block is hashed against the text before the lane
// write and lands a conflict. opQueue's drain documents that conflict as the
// lane's guard against a durable row overwriting the lane's newer text.
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

/** Per block uid, the writers whose applied batches wrote its text (a
 * create or an update_text of it): a client, or a client's lane. */
export function textEditors(run: Pick<ConflictNoiseRun, "applied" | "committedBy" | "lane">):
    Map<string, Set<string>> {
  const editors = new Map<string, Set<string>>();
  for (const { batch_id } of run.applied) {
    for (const [client, committed] of run.committedBy) {
      const body = committed.get(batch_id);
      if (body === undefined) continue;
      const writer = run.lane.has(batch_id) ? `${client}'s lane` : client;
      const parsed = JSON.parse(body) as { ops?: { op?: unknown; uid?: unknown }[] };
      for (const op of parsed.ops ?? []) {
        if ((op.op !== "create" && op.op !== "update_text") || typeof op.uid !== "string") continue;
        const set = editors.get(op.uid) ?? new Set<string>();
        set.add(writer);
        editors.set(op.uid, set);
      }
    }
  }
  return editors;
}

/** One finding per overwritten header about a block fewer than two writers
 * wrote. */
export function conflictNoise(run: ConflictNoiseRun): string[] {
  const editors = textEditors(run);
  return run.conflicts.flatMap((c) => {
    const target = overwrittenTarget(c.text);
    if (target === null) return [];
    const who = [...(editors.get(target) ?? [])].sort();
    if (who.length >= 2) return [];
    return [`${c.batch_id} overwrote ${target} as a conflict (header ${c.header_uid}),` +
            ` but ${who.length === 0 ? "no client" : `only ${who[0]}`} wrote its text`];
  });
}
