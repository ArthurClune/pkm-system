// pattern: Functional Core
// The model of one block's draft, written from frontend-editor.md § Drafts
// and commit points: typing debounces into a pending draft whose base is the
// text the textarea showed; blur, a command, undo and the debounce flush it;
// the flush sends nothing when the text is its base or the tree already holds
// it, and otherwise sends update_text hashing the base. While a draft is
// pending the textarea keeps it; with none the textarea shows the tree.
//
// And from § Keyboard policy, IME composition: while a composition is in
// progress the textarea adopts nothing, and catches up when it ends. A keydown
// the IME owns decides nothing: one sent mid-composition, or the first keydown
// after a compositionend when it carries keyCode 229 and comes within
// IME_COMMIT_WINDOW_MS. Every other Enter splits and Escape blurs.
//
// The server here is the one block's text, applying what the editor sends in
// order. A send whose base hash is not the server's text is a conflict.
import fc from "fast-check";
import type { BlockOp } from "../../api/ops";
import { sha256Hex } from "../../replica/sha256";

export const DEBOUNCE_MS = 500;
export const IME_COMMIT_WINDOW_MS = 500;
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
  | { k: "refocus" }
  | { k: "compose-start" }
  /** With a key: the keydown follows, at once as WebKit sends the one that
   * committed the composition, or gapMs later on the IME clock alone (no
   * timer runs) as after a composition a clicked candidate ended. */
  | { k: "compose-end"; key: KeyCommand | null; gapMs: 0 | 600 }
  | KeyCommand;

/** A keydown sent mid-composition (isComposing and keyCode 229), with
 * keyCode 229 alone (WebKit's committing keydown), or a plain one. */
export type KeyCommand = { k: "key"; key: "Enter" | "Escape"; ime: ImeFlags };

export type ImeFlags = "composing" | "229" | "plain";

function keyCommandArb(): fc.Arbitrary<KeyCommand> {
  return fc.record({
    k: fc.constant("key" as const),
    key: fc.constantFrom("Enter" as const, "Escape" as const),
    ime: fc.constantFrom<ImeFlags>("composing", "229", "229", "plain"),
  });
}

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
  { weight: 3, arbitrary: fc.constant({ k: "compose-start" } as const) },
  { weight: 4, arbitrary: fc.record({
    k: fc.constant("compose-end" as const),
    key: fc.option(keyCommandArb(), { freq: 2 }),
    gapMs: fc.constantFrom<0 | 600>(0, 0, 600),
  }) },
  { weight: 3, arbitrary: keyCommandArb() },
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
  /** What the textarea shows; it moves only by an edit while composing. */
  display: string;
  composing: boolean;
  /** When the last composition ended, until the next keydown. */
  endedAt: number | null;
}

export function initialModel(start: string): DraftModel {
  return { server: start, pending: null, landedUnderDraft: false, undo: [],
           now: 0, due: null, display: start, composing: false,
           endedAt: null };
}

/** What the textarea must show after a step: while composing it adopts
 * nothing. */
export function displayed(m: DraftModel): string {
  return m.composing ? m.display : shown(m);
}

/** Whether the IME owns a keydown with these flags. */
export function imeOwns(m: DraftModel, ime: ImeFlags): boolean {
  if (m.composing || ime === "composing") return true;
  return ime === "229" && m.endedAt !== null
    && m.now - m.endedAt < IME_COMMIT_WINDOW_MS;
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

/** The model after the user's edit made the textarea show `text`. A clean
 * draft's base is what the textarea showed, which is not the server's text
 * when it landed during a composition: that counts as landing under the
 * draft. */
export function afterEdit(m: DraftModel, text: string): DraftModel {
  const pending = m.pending === null ? { text, base: m.display }
                                     : { ...m.pending, text };
  const stale = m.pending === null && m.display !== m.server;
  return { ...m, pending, due: m.now + DEBOUNCE_MS, display: text,
           landedUnderDraft: m.landedUnderDraft || stale };
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
