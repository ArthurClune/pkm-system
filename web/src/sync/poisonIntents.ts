// pattern: Functional Core
// Poison-mark intents: the server-rejected durable batches still waiting to
// be marked poisoned in the replica, and their stored form. One intent per
// (rowId, batchId), the last write winning, kept in rowId then batchId order.
import type { PoisonedBatch } from "../replica/client";

export interface PoisonEvent extends PoisonedBatch {}

export function validPoisonEvent(value: unknown): value is PoisonEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<PoisonEvent>;
  return Number.isInteger(event.rowId) && typeof event.batchId === "string" &&
    Array.isArray(event.ops) && typeof event.status === "number" &&
    typeof event.message === "string";
}

const keyOf = (event: PoisonEvent): string =>
  `${event.rowId}\u0000${event.batchId}`;

function ordered(events: Iterable<PoisonEvent>): PoisonEvent[] {
  const unique = new Map<string, PoisonEvent>();
  for (const event of events) unique.set(keyOf(event), event);
  return [...unique.values()].sort((a, b) =>
    a.rowId - b.rowId || a.batchId.localeCompare(b.batchId));
}

/** Reads the stored `{ version: 1, intents }` envelope. Anything else — an
 * absent value, another version, damaged JSON — reads as no intents, and an
 * invalid entry is dropped rather than failing the rest. */
export function parseStoredIntents(
  raw: string | null | undefined,
): PoisonEvent[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; intents?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.intents)) return [];
    return ordered((parsed.intents as unknown[]).filter(validPoisonEvent));
  } catch {
    // The stored value can come from a damaged write.
    return [];
  }
}

export function serialiseIntents(intents: readonly PoisonEvent[]): string {
  return JSON.stringify({ version: 1, intents });
}

export function withIntent(
  intents: readonly PoisonEvent[], event: PoisonEvent,
): PoisonEvent[] {
  return ordered([...intents, event]);
}
