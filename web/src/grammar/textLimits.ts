// pattern: Functional Core
// The write-time limits on one block's text: how long it may be, in code
// points, and how deep its `[[` runs may nest. The server refuses a write
// past either (pkm/text_limits.py); the editor asks first, so the user sees
// a notice instead of a refused batch. Only text a write would store is
// judged: reading, moving or deleting a block already over a limit is not.
// shared/fixtures/text_limits_parity.json pins the limits, the measures and
// the refusal wording equal to the server's.
import type { BlockUid } from "../api/brands";
import type { BlockOp } from "../api/ops";
import { linkNestingDepth } from "./scan";

export const MAX_BLOCK_TEXT_CHARS = 1_000_000;
export const MAX_LINK_NESTING = 32;

export const TEXT_LENGTH_NOTICE =
  "A block can't be longer than 1,000,000 characters.";
export const LINK_NESTING_NOTICE =
  "Links can't nest more than 32 levels deep.";

export type TextLimitKind = "length" | "nesting";

/** Which limit a text is over, what it measured and the limit itself. */
export interface TextLimitViolation {
  kind: TextLimitKind;
  measured: number;
  limit: number;
}

/** The first op in a batch whose text is over a limit. */
export interface OpTextLimitViolation {
  opIndex: number;
  uid: BlockUid;
  violation: TextLimitViolation;
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** `[...text].length` without building the array: UTF-16 units less one
 * per surrogate pair. A lone surrogate counts one, as the spread and
 * Python's `len` both count it. */
export function codePointLength(text: string): number {
  let pairs = 0;
  for (let i = 0; i < text.length - 1; i++) {
    if (isHighSurrogate(text.charCodeAt(i))
        && isLowSurrogate(text.charCodeAt(i + 1))) {
      pairs += 1;
      i += 1;
    }
  }
  return text.length - pairs;
}

/** Does `text` hold more than `most` non-overlapping `[[`? Stops counting
 * once it does, so a text full of links costs no more than the limit. */
function holdsMoreOpenersThan(text: string, most: number): boolean {
  let count = 0;
  for (let i = text.indexOf("[["); i !== -1; i = text.indexOf("[[", i + 2)) {
    count += 1;
    if (count > most) return true;
  }
  return false;
}

/** The limit `text` is over, or null when a write may store it. Length is
 * judged first, so the nesting measure never reads more than the cap. */
export function textLimitViolation(text: string): TextLimitViolation | null {
  // A code point is at least one UTF-16 unit, so a text no longer than the
  // cap in units is no longer in code points either.
  if (text.length > MAX_BLOCK_TEXT_CHARS) {
    const length = codePointLength(text);
    if (length > MAX_BLOCK_TEXT_CHARS) {
      return { kind: "length", measured: length, limit: MAX_BLOCK_TEXT_CHARS };
    }
  }
  // Every run the measure counts opens with its own `[[`, and no two runs
  // share one, so a chain of n nested runs needs n non-overlapping `[[`.
  // The greedy count is the most there can be, so a text with at most the
  // limit's worth cannot nest past it.
  if (!holdsMoreOpenersThan(text, MAX_LINK_NESTING)) return null;
  const depth = linkNestingDepth(text);
  if (depth > MAX_LINK_NESTING) {
    return { kind: "nesting", measured: depth, limit: MAX_LINK_NESTING };
  }
  return null;
}

/** The refusal's wording, the same string the server's carries. */
export function describeTextLimit(violation: TextLimitViolation): string {
  if (violation.kind === "length") {
    return `text of ${violation.measured} characters is over the limit of `
      + `${violation.limit}`;
  }
  return `[[ nested ${violation.measured} levels deep is over the limit of `
    + `${violation.limit}`;
}

/** What the editor tells the user when it refuses an edit. */
export function textLimitNotice(violation: TextLimitViolation): string {
  return violation.kind === "length" ? TEXT_LENGTH_NOTICE : LINK_NESTING_NOTICE;
}

/** The first `create` or `update_text` in `ops` whose text is over a limit,
 * in op order, else null. No other op writes text, so none is judged. */
export function findOpTextLimitViolation(ops: readonly BlockOp[],
): OpTextLimitViolation | null {
  for (const [opIndex, op] of ops.entries()) {
    if (op.op !== "create" && op.op !== "update_text") continue;
    const violation = textLimitViolation(op.text);
    if (violation !== null) return { opIndex, uid: op.uid, violation };
  }
  return null;
}
