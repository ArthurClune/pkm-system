// pattern: Functional Core
// Well-formed text: what the ops contract carries is a sequence of Unicode
// scalar values, never a lone surrogate. JS strings can hold one (an offset
// that split a pair, a paste from a broken source), JSON.stringify sends it
// as a `\udXXX` escape, and the server normalises it to U+FFFD at its
// boundary (pkm.contracts.text), as TextEncoder already does when sha256Hex
// hashes it. Normalising here too keeps the replica holding exactly the
// text the server stores, so the two never drift apart.
//
// `wellFormed` is String.prototype.toWellFormed, written out because the
// TS lib this project targets predates it.
import type { BlockOp } from "../api/ops";
import { asRawTitle } from "./titles";

const ANY_SURROGATE = /[\uD800-\uDFFF]/;
// A pair first, so the alternation never reads a pair's halves as lone.
// No `u` flag: these classes must match UTF-16 code units, not code points.
const SURROGATE_RUN = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

/** `text` with each lone surrogate replaced by U+FFFD; `text` itself when
 * it holds none, which is every text but a hostile one. */
export function wellFormed(text: string): string {
  if (!ANY_SURROGATE.test(text)) return text;
  return text.replace(SURROGATE_RUN,
                      (unit) => (unit.length === 2 ? unit : "\uFFFD"));
}

/** `op` with its text and page title well-formed: the strings an op takes
 * from what a person typed or pasted. Its uids, batch id and hashes are
 * minted by code (uid.ts, sha256.ts) and never hold a surrogate; the server
 * normalises those too, for clients that are not this one. The same object
 * back when nothing changed. */
export function wellFormedOp(op: BlockOp): BlockOp {
  let out = op;
  if (out.op === "create" || out.op === "update_text") {
    const text = wellFormed(out.text);
    if (text !== out.text) out = { ...out, text };
  }
  if ("page_title" in out && typeof out.page_title === "string") {
    const title = wellFormed(out.page_title);
    if (title !== out.page_title) out = { ...out, page_title: asRawTitle(title) };
  }
  return out;
}

export function wellFormedOps(ops: readonly BlockOp[]): BlockOp[] {
  return ops.map(wellFormedOp);
}
