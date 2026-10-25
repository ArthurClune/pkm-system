// pattern: Functional Core
// The size limits the server judges a whole op batch by. It answers 422 to a
// batch over the op count and 413 to a body over the private cap, and the
// queue discards a refused batch, so the editor asks first and shows a
// notice instead of queueing one. shared/fixtures/batch_limits.json pins
// both limits equal to the server's.
import type { BlockOp } from "../api/ops";
import { MAX_PAGE_TITLE_CHARS } from "../grammar/titleLength";

export const MAX_OPS_PER_BATCH = 500;
export const PRIVATE_BODY_MAX_BYTES = 67_108_864;
export const BATCH_TOO_LARGE_NOTICE =
  "This change is too large to save in one step.";

/** JSON escapes one code point to at most six bytes. */
const MAX_ESCAPED_BYTES_PER_UNIT = 6;
/** What the queue stamps onto each op after this judge: hashes, and an
 * `update_text`'s `page_title`, which may be a title at the cap whose
 * every code point escapes to six bytes. */
const STAMP_BYTES_PER_OP =
  MAX_ESCAPED_BYTES_PER_UNIT * MAX_PAGE_TITLE_CHARS + 1_024;
/** The batch envelope around the ops. */
const ENVELOPE_BYTES = 4_096;

const utf8 = new TextEncoder();

/** The UTF-16 units of the op's free text: its `text`, and a `page_title`
 * it already carries, which may be longer than the cap (an update_text
 * hint is never judged). */
function textLength(op: BlockOp): number {
  const text = "text" in op && typeof op.text === "string" ? op.text.length : 0;
  const title = "page_title" in op && typeof op.page_title === "string"
    ? op.page_title.length : 0;
  return text + title;
}

/** Which limit the batch is over, or null when the server would take it.
 * The byte check is an estimate that errs high; it serialises only when the
 * cheap bound does not already clear the cap. */
export function findBatchSizeViolation(
  ops: readonly BlockOp[],
): "ops" | "bytes" | null {
  if (ops.length > MAX_OPS_PER_BATCH) return "ops";
  const overhead = ops.length * STAMP_BYTES_PER_OP + ENVELOPE_BYTES;
  let units = 0;
  for (const op of ops) units += textLength(op);
  if (units * MAX_ESCAPED_BYTES_PER_UNIT + overhead <= PRIVATE_BODY_MAX_BYTES) {
    return null;
  }
  const bytes = utf8.encode(JSON.stringify(ops)).length + overhead;
  return bytes > PRIVATE_BODY_MAX_BYTES ? "bytes" : null;
}
