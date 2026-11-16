// pattern: Functional Core
// The per-history-entry scroll offsets kept across a reload in
// sessionStorage; useHistoryScrollRestore.ts is the shell that uses them.

/** Entries older than this many are dropped when the offsets are saved. */
export const KEPT_OFFSETS = 200;

/** Unreadable or foreign storage yields no offsets rather than an error. */
export function parseScrollOffsets(raw: string | null): Map<string, number> {
  const offsets = new Map<string, number>();
  if (!raw) return offsets;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return offsets;
  }
  if (!Array.isArray(parsed)) return offsets;
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, y] = entry as unknown[];
    if (typeof key === "string" && typeof y === "number" && Number.isFinite(y)) {
      offsets.set(key, y);
    }
  }
  return offsets;
}

/** Newest last, as a Map iterates in insertion order. */
export function serializeScrollOffsets(offsets: ReadonlyMap<string, number>): string {
  return JSON.stringify([...offsets].slice(-KEPT_OFFSETS));
}
