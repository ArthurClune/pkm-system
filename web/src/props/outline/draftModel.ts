// pattern: Functional Core
// The model of one block's draft, written from frontend-editor.md § Drafts
// and commit points: typing debounces into a pending draft whose base is the
// text the textarea showed; blur, a command, undo and the debounce flush it;
// the flush sends nothing when the text is its base or the tree already holds
// it, and otherwise sends update_text hashing the base. While a draft is
// pending the textarea keeps it; with none the textarea shows the tree.
//
// The server here is the one block's text, applying what the editor sends in
// order. A send whose base hash is not the server's text is a conflict.
import fc from "fast-check";
import type { BlockOp } from "../../api/ops";
import { sha256Hex } from "../../replica/sha256";

export const DEBOUNCE_MS = 500;
/** Texts remote edits and replays land: short, so they collide with what the
 * user typed, its base and each other. */
const LANDED = ["", "a", "ab", "remote"] as const;

export type DraftCommand =
  | { k: "type"; ch: "a" | "b" }
  | { k: "erase" }
  | { k: "tick"; ms: 200 | 600 }
  | { k: "remote"; text: string }
  /** A queued write's text reaching the tree through an authoritative read. */
  | { k: "replay"; text: string }
  /** run() flushing the draft and splicing an attribute into the block in
   * one batch: the /goodlinks and /link-local-file shape. */
  | { k: "splice"; at: number }
  | { k: "undo" }
  | { k: "blur" }
  | { k: "refocus" };

export const draftCommandArb: fc.Arbitrary<DraftCommand> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom("a", "b").map((ch) => ({ k: "type", ch }) as const) },
  { weight: 3, arbitrary: fc.constant({ k: "erase" } as const) },
  { weight: 3, arbitrary: fc.constantFrom(200, 600).map((ms) => ({ k: "tick", ms }) as const) },
  { weight: 2, arbitrary: fc.constantFrom(...LANDED).map((text) => ({ k: "remote", text }) as const) },
  { weight: 2, arbitrary: fc.constantFrom(...LANDED).map((text) => ({ k: "replay", text }) as const) },
  { weight: 2, arbitrary: fc.nat(6).map((at) => ({ k: "splice", at }) as const) },
  { weight: 2, arbitrary: fc.constant({ k: "undo" } as const) },
  { weight: 1, arbitrary: fc.constant({ k: "blur" } as const) },
  { weight: 2, arbitrary: fc.constant({ k: "refocus" } as const) },
);

export const draftExampleArb = fc.record({
  start: fc.constantFrom<string>("", "ab"),
  commands: fc.array(draftCommandArb, { minLength: 1, maxLength: 24 }),
});
export type DraftExample = { start: string; commands: DraftCommand[] };

export interface Pending { text: string; base: string }

export interface DraftModel {
  /** What the server holds for the block. */
  server: string;
  pending: Pending | null;
  /** A remote edit or replay landed while the pending draft was. */
  landedUnderDraft: boolean;
  /** Each undoable batch's text before it, newest last. */
  undo: string[];
  now: number;
  due: number | null;
}

export function initialModel(start: string): DraftModel {
  return { server: start, pending: null, landedUnderDraft: false, undo: [],
           now: 0, due: null };
}

/** What the textarea must show: the pending draft, else the tree. */
export function shown(m: DraftModel): string {
  return m.pending?.text ?? m.server;
}

/** The send a flush makes, or null when it sends nothing. */
export function flushSend(m: DraftModel): Pending | null {
  const p = m.pending;
  if (p === null || p.text === p.base || p.text === m.server) return null;
  return p;
}

/** The model after a flush, before its send reaches the server. */
export function afterFlush(m: DraftModel): DraftModel {
  return { ...m, pending: null, landedUnderDraft: false, due: null };
}

/** The model after the user's edit made the textarea show `text`. */
export function afterEdit(m: DraftModel, text: string): DraftModel {
  const pending = m.pending === null ? { text, base: m.server }
                                     : { ...m.pending, text };
  return { ...m, pending, due: m.now + DEBOUNCE_MS };
}

export function afterLanded(m: DraftModel, text: string): DraftModel {
  return { ...m, server: text,
           landedUnderDraft: m.landedUnderDraft || m.pending !== null };
}

type TextOp = Extract<BlockOp, { op: "update_text" }>;

/** Apply one sent op to the model's server. A text op whose base hash is not
 * the server's text is a conflict; it is a problem unless `conflictAllowed`
 * (a remote edit or replay landed under the draft being flushed). */
export function serverApply(m: DraftModel, op: BlockOp,
                            conflictAllowed: boolean): {
  model: DraftModel; problem: string | null; conflict: boolean;
} {
  if (op.op !== "update_text") {
    return { model: m, problem: `unexpected ${op.op} op`, conflict: false };
  }
  const t: TextOp = op;
  const conflict = t.base_text_hash !== undefined
    && t.base_text_hash !== sha256Hex(m.server);
  const problem = conflict && !conflictAllowed
    ? `conflict: update_text ${JSON.stringify(t.text)} hashes a base other `
      + `than the server's ${JSON.stringify(m.server)}, with no remote edit `
      + "or replay under the draft"
    : null;
  return { model: { ...m, server: t.text }, problem, conflict };
}

/** The update_text a flush of `p` must send. */
export function flushOpMatches(op: BlockOp | undefined, p: Pending): string | null {
  if (op?.op === "update_text" && op.text === p.text
      && op.base_text_hash === sha256Hex(p.base)) return null;
  return `draft flush: expected update_text ${JSON.stringify(p.text)} hashing `
    + `the base ${JSON.stringify(p.base)} it was typed over, got `
    + `${JSON.stringify(op ?? null)}`;
}
