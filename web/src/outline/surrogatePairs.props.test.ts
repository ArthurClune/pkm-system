// Every editor transform that slices a block's text at an offset keeps a
// well-formed text well-formed: no split, splice or strip leaves half of a
// surrogate pair behind, and no caret it hands back sits inside a pair. The
// offsets are drawn as raw UTF-16 code-unit offsets, inside pairs as often
// as not: the DOM reports carets on character boundaries, but an offset kept
// across an edit (an upload's insertion point, a clamp to a shorter text,
// the caret a slash command was opened at) need not land on one.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { wellFormed } from "../replica/wellFormed";
import { block, canonicalTitleOf, rawTitleOf, uidOf } from "../test-helpers";
import { applyCompletion, detectAutocomplete } from "./autocomplete";
import { backspaceAtStart, splitBlock } from "./edits";
import { insertTypedChar } from "./keyboardBar";
import { autoPairBracket, snapCaret, toggleEmphasis, wrapLink } from "./keyEdits";
import { spliceUploadedMarkdown } from "./outlineState";
import { planOutlinePaste } from "./paste";
import { applySlashCommand, SLASH_COMMANDS, stripTrigger } from "./slashCommands";

const PAGE = canonicalTitleOf("Page");
const NOW = new Date(2026, 9, 21);

const pieceArb = fc.oneof(
  { weight: 1, arbitrary: fc.constantFrom(
    "\u{1F600}", "\u{1D11E}", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}") },
  { weight: 2, arbitrary: fc.constantFrom(
    "e\u0301", "\u00E9", "a", "bc ", " ", "\n", "[[", "]]", "#", " /", "/", "**",
    "__", "(", ")", "[", "]", "`", "\"", "'", "TODO ", "> ") },
);

const textArb = fc.array(pieceArb, { maxLength: 8 }).map((p) => p.join(""));

const isHigh = (u: number): boolean => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number): boolean => u >= 0xdc00 && u <= 0xdfff;

/** Whether `offset` falls between a pair's high and low halves. Written
 * out here, not taken from snapCaret, so a broken snapCaret cannot also
 * blind the check. */
const insidePair = (text: string, offset: number): boolean =>
  offset > 0 && offset < text.length
  && isHigh(text.charCodeAt(offset - 1)) && isLow(text.charCodeAt(offset));

function midPairOffsets(text: string): number[] {
  const out: number[] = [];
  for (let i = 1; i < text.length; i++) if (insidePair(text, i)) out.push(i);
  return out;
}

const isBoundary = (text: string, offset: number): boolean =>
  !insidePair(text, offset);

const wf = (text: string): boolean => wellFormed(text) === text;

let midDraws = 0;
let draws = 0;

/** A code-unit offset into `text`: inside a pair when `mid` and the text
 * has one, anywhere in [0, length] otherwise. */
function offsetIn(text: string, n: number, mid: boolean): number {
  draws += 1;
  const mids = midPairOffsets(text);
  if (mid && mids.length > 0) {
    midDraws += 1;
    return mids[n % mids.length];
  }
  return n % (text.length + 1);
}

const caseArb = fc.record({
  text: textArb, a: fc.nat(), b: fc.nat(), midA: fc.boolean(), midB: fc.boolean(),
}).map(({ text, a, b, midA, midB }) => {
  const x = offsetIn(text, a, midA);
  const y = offsetIn(text, b, midB);
  return { text, selStart: Math.min(x, y), selEnd: Math.max(x, y) };
});

// A trigger ([[, #, /) with a query after it that holds astral characters,
// the caret somewhere in that query: inside one of its pairs when it can be.
const queryPieceArb = fc.constantFrom("a", "Zq", "-", "\u{1F600}", "\u{1D11E}");
const acCaseArb = fc.record({
  pre: textArb, trigger: fc.constantFrom("[[", "#", " /", "/"),
  query: fc.array(queryPieceArb, { minLength: 1, maxLength: 4 }).map((p) => p.join("")),
  post: textArb, n: fc.nat(), mid: fc.boolean(),
}).map(({ pre, trigger, query, post, n, mid }) => {
  const start = pre.length + trigger.length;
  const text = pre + trigger + query + post;
  const inQuery = midPairOffsets(query).map((i) => start + i);
  const caret = mid && inQuery.length > 0
    ? inQuery[n % inQuery.length] : start + (n % (query.length + 1));
  return { text, caret };
});

const RUNS = { numRuns: 400 };

function expectSelection(r: { text: string; selStart: number; selEnd: number } | null) {
  if (r === null) return;
  expect(wf(r.text)).toBe(true);
  expect(isBoundary(r.text, r.selStart)).toBe(true);
  expect(isBoundary(r.text, r.selEnd)).toBe(true);
}

function opTexts(ops: readonly { op: string; text?: string }[]): string[] {
  return ops.flatMap((o) => (o.text !== undefined ? [o.text] : []));
}

describe("offset transforms never split a surrogate pair", () => {
  test("block split at the caret", () => {
    fc.assert(fc.property(caseArb, ({ text, selStart }) => {
      const r = splitBlock([block("tuid-a", text)], PAGE, uidOf("tuid-a"),
                           selStart, uidOf("tuid-new"));
      for (const t of opTexts(r.ops)) expect(wf(t)).toBe(true);
    }), RUNS);
  });

  test("merge into the previous block", () => {
    fc.assert(fc.property(textArb, textArb, (prev, text) => {
      const r = backspaceAtStart([block("tuid-p", prev), block("tuid-a", text)],
                                 PAGE, uidOf("tuid-a"));
      for (const t of opTexts(r.ops)) expect(wf(t)).toBe(true);
      if (r.focus) expect(isBoundary(prev + text, r.focus.cursor)).toBe(true);
    }), RUNS);
  });

  test("auto-pair, link wrap and emphasis toggles", () => {
    fc.assert(fc.property(caseArb, fc.constantFrom(..."[({`\"')]}"),
                          ({ text, selStart, selEnd }, ch) => {
      expectSelection(autoPairBracket(text, selStart, selEnd, ch));
      expectSelection(wrapLink(text, selStart, selEnd));
      expectSelection(toggleEmphasis(text, selStart, selEnd, "**"));
      expectSelection(toggleEmphasis(text, selStart, selEnd, "__"));
    }), RUNS);
  });

  test("a keyboard-bar character typed over the selection", () => {
    fc.assert(fc.property(caseArb, pieceArb, ({ text, selStart, selEnd }, ch) => {
      expectSelection(insertTypedChar(text, selStart, selEnd, ch));
    }), RUNS);
  });

  test("paste splicing into the block", () => {
    fc.assert(fc.property(caseArb, textArb, ({ text, selStart, selEnd }, pasted) => {
      let n = 0;
      const r = planOutlinePaste([block("tuid-a", text)], PAGE, uidOf("tuid-a"),
                                 selStart, selEnd, pasted,
                                 () => uidOf(`tuid-p${n++}`));
      for (const t of opTexts(r.ops)) expect(wf(t)).toBe(true);
    }), RUNS);
  });

  test("an upload's markdown spliced at the kept caret", () => {
    fc.assert(fc.property(caseArb, ({ text, selStart }) => {
      expectSelection(spliceUploadedMarkdown(text, selStart, "![x](/api/assets/a)"));
    }), RUNS);
  });

  test("autocomplete queries, completions and slash commands", () => {
    let contexts = 0;
    let midContexts = 0;
    fc.assert(fc.property(acCaseArb, ({ text, caret }) => {
      const ctx = detectAutocomplete(text, caret);
      if (ctx === null) return;
      contexts += 1;
      if (insidePair(text, caret)) midContexts += 1;
      expect(wf(ctx.query)).toBe(true);
      const stripped = stripTrigger(text, caret, ctx);
      expect(wf(stripped.text)).toBe(true);
      expect(isBoundary(stripped.text, stripped.at)).toBe(true);
      if (ctx.kind === "command") {
        for (const { name } of SLASH_COMMANDS) {
          const r = applySlashCommand(text, caret, ctx, name, NOW);
          expect(wf(r.text)).toBe(true);
          expect(isBoundary(r.text, r.cursor)).toBe(true);
        }
      } else {
        const r = applyCompletion(text, caret, ctx, rawTitleOf("Some Page"));
        expect(wf(r.text)).toBe(true);
        expect(isBoundary(r.text, r.cursor)).toBe(true);
      }
    }), { numRuns: 600 });
    expect(contexts).toBeGreaterThan(200);
    expect(midContexts).toBeGreaterThan(100);
  });

  test("the offsets drawn really do land inside pairs", () => {
    // Runs after the properties above (vitest keeps file order): without
    // this the properties could pass on texts that never held a pair.
    expect(draws).toBeGreaterThan(1000);
    expect(midDraws / draws).toBeGreaterThan(0.3);
  });
});

describe("snapCaret", () => {
  test("moves an offset inside a pair back to the pair's start", () => {
    const text = "a\u{1F600}b";
    expect([0, 1, 2, 3, 4].map((i) => snapCaret(text, i))).toEqual([0, 1, 1, 3, 4]);
  });

  test("leaves offsets around lone surrogates and out of range alone", () => {
    expect(snapCaret("\uDC00x", 1)).toBe(1);
    expect(snapCaret("x\uD800", 1)).toBe(1);
    expect(snapCaret("ab", 5)).toBe(5);
    expect(snapCaret("ab", -1)).toBe(-1);
  });
});
