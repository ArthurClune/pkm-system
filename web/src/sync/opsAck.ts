// pattern: Functional Core
// Reading an /api/ops ack.

/** The journal seq an /api/ops ack names for its batch's commit, or
 * undefined when it names none (an ack stored before the field existed is
 * replayed verbatim without it). The OpenAPI schema types the ack as a bare
 * object, so the field is read by hand. Both delivery paths read it: the
 * drain, and the recovery flush. */
export function ackSeq(ack: unknown): number | undefined {
  if (typeof ack !== "object" || ack === null) return undefined;
  const seq = (ack as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : undefined;
}
