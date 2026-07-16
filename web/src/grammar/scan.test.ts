import { describe, expect, it } from "vitest";
import { scanGrammar, type GrammarToken } from "./scan";

const tokens = (text: string): readonly GrammarToken[] => scanGrammar(text).tokens;
const ofKind = <K extends GrammarToken["kind"]>(text: string, kind: K) =>
  tokens(text).filter((t): t is Extract<GrammarToken, { kind: K }> => t.kind === kind);

describe("scanGrammar: page references", () => {
  it("emits an exact bracket-inclusive span for a plain ref", () => {
    expect(tokens("see [[World]]!")).toEqual([{
      kind: "page-ref", start: 4, end: 13, content: { start: 6, end: 11 },
      title: "World", tag: false, depth: 0, parentStart: null,
    }]);
  });

  it("emits adjacent refs as separate source-ordered tokens", () => {
    expect(tokens("[[a]][[b]]")).toEqual([
      { kind: "page-ref", start: 0, end: 5, content: { start: 2, end: 3 },
        title: "a", tag: false, depth: 0, parentStart: null },
      { kind: "page-ref", start: 5, end: 10, content: { start: 7, end: 8 },
        title: "b", tag: false, depth: 0, parentStart: null },
    ]);
  });

  it("spans are UTF-16 code units (astral chars count as two)", () => {
    // "𝕏" is U+1D54F, two UTF-16 units.
    expect(tokens("[[𝕏]] #tag")).toEqual([
      { kind: "page-ref", start: 0, end: 6, content: { start: 2, end: 4 },
        title: "𝕏", tag: false, depth: 0, parentStart: null },
      { kind: "hashtag", start: 7, end: 11, title: "tag" },
    ]);
  });

  it("keeps an empty [[]] as a token with an empty content span", () => {
    expect(tokens("[[]]")).toEqual([{
      kind: "page-ref", start: 0, end: 4, content: { start: 2, end: 2 },
      title: "", tag: false, depth: 0, parentStart: null,
    }]);
  });

  it("includes the # in a tag ref's span, anywhere in the text", () => {
    expect(tokens("#[[Topic]]")).toEqual([{
      kind: "page-ref", start: 0, end: 10, content: { start: 3, end: 8 },
      title: "Topic", tag: true, depth: 0, parentStart: null,
    }]);
    // #[[...]] needs no word boundary before the #
    expect(tokens("x#[[y]]")).toEqual([{
      kind: "page-ref", start: 1, end: 7, content: { start: 4, end: 5 },
      title: "y", tag: true, depth: 0, parentStart: null,
    }]);
  });

  it("emits nested refs outer-before-inner with depth and parentStart", () => {
    expect(tokens("[[a [[b]] c]]")).toEqual([
      { kind: "page-ref", start: 0, end: 13, content: { start: 2, end: 11 },
        title: "a [[b]] c", tag: false, depth: 0, parentStart: null },
      { kind: "page-ref", start: 4, end: 9, content: { start: 6, end: 7 },
        title: "b", tag: false, depth: 1, parentStart: 0 },
    ]);
  });

  it("parentStart of a ref nested in a tag ref is the tag token's start", () => {
    expect(tokens("#[[A [[B]] C]]")).toEqual([
      { kind: "page-ref", start: 0, end: 14, content: { start: 3, end: 12 },
        title: "A [[B]] C", tag: true, depth: 0, parentStart: null },
      { kind: "page-ref", start: 5, end: 10, content: { start: 7, end: 8 },
        title: "B", tag: false, depth: 1, parentStart: 0 },
    ]);
  });

  it("a ref nested only inside an UNMATCHED outer is top-level", () => {
    expect(tokens("[[a [[b]] c")).toEqual([
      { kind: "page-ref", start: 4, end: 9, content: { start: 6, end: 7 },
        title: "b", tag: false, depth: 0, parentStart: null },
    ]);
  });

  it("malformed brackets stay plain text", () => {
    expect(tokens("[[unclosed")).toEqual([]);
    expect(tokens("]] [[x")).toEqual([]);
    expect(tokens("a ]] b")).toEqual([]);
  });
});

describe("scanGrammar: hashtags", () => {
  it("requires start-of-text, whitespace, or ( before the #", () => {
    expect(tokens("go #ai (#ml) x#no #")).toEqual([
      { kind: "hashtag", start: 3, end: 6, title: "ai" },
      { kind: "hashtag", start: 8, end: 11, title: "ml" },
    ]);
  });

  it("accepts Unicode letters in tag titles", () => {
    expect(tokens("#héllo")).toEqual([
      { kind: "hashtag", start: 0, end: 6, title: "héllo" },
    ]);
    expect(tokens("see #日本語 now")).toEqual([
      { kind: "hashtag", start: 4, end: 8, title: "日本語" },
    ]);
  });

  it("treats blanked code as whitespace before a #", () => {
    // refs.py blanks code before scanning, so "`x`#tag" IS a tag there.
    expect(tokens("`x`#tag")).toEqual([
      { kind: "inline-code", start: 0, end: 3 },
      { kind: "hashtag", start: 3, end: 7, title: "tag" },
    ]);
  });
});

describe("scanGrammar: block refs", () => {
  it("emits ((uid)) spans for uids of 6+ [a-zA-Z0-9_-] chars", () => {
    expect(tokens("((abc123XYZ))")).toEqual([
      { kind: "block-ref", start: 0, end: 13, uid: "abc123XYZ" },
    ]);
    expect(tokens("x ((uid_r1abc)) y")).toEqual([
      { kind: "block-ref", start: 2, end: 15, uid: "uid_r1abc" },
    ]);
  });

  it("rejects short or malformed uids", () => {
    expect(tokens("((abc))")).toEqual([]);
    expect(tokens("((not a uid))")).toEqual([]);
  });
});

describe("scanGrammar: TODO markers", () => {
  it("records spelling flags and the whitespace-suffix offset", () => {
    expect(tokens("{{[[TODO]]}} buy")).toEqual([
      { kind: "todo", start: 0, end: 12, state: "TODO",
        openBrackets: true, closeBrackets: true, suffixEnd: 13 },
      { kind: "page-ref", start: 2, end: 10, content: { start: 4, end: 8 },
        title: "TODO", tag: false, depth: 0, parentStart: null },
    ]);
  });

  it("short form without a trailing space keeps suffixEnd at end", () => {
    expect(tokens("{{DONE}}x")).toEqual([
      { kind: "todo", start: 0, end: 8, state: "DONE",
        openBrackets: false, closeBrackets: false, suffixEnd: 8 },
    ]);
  });

  it("accepts each bracket side independently (documented leniency)", () => {
    expect(ofKind("{{TODO]]}} a", "todo")).toEqual([
      { kind: "todo", start: 0, end: 10, state: "TODO",
        openBrackets: false, closeBrackets: true, suffixEnd: 11 },
    ]);
    expect(ofKind("{{[[DONE}} a", "todo")).toEqual([
      { kind: "todo", start: 0, end: 10, state: "DONE",
        openBrackets: true, closeBrackets: false, suffixEnd: 11 },
    ]);
    // the dangling [[ of {{[[DONE}} never becomes a page ref
    expect(ofKind("{{[[DONE}} a", "page-ref")).toEqual([]);
  });

  it("counts a newline as the one-char suffix", () => {
    expect(ofKind("{{TODO}}\nx", "todo")[0].suffixEnd).toBe(9);
  });

  it("only recognizes the marker at offset 0", () => {
    expect(ofKind(" {{TODO}}", "todo")).toEqual([]);
    expect(ofKind("a {{TODO}} b", "todo")).toEqual([]);
  });
});

describe("scanGrammar: opaque code", () => {
  it("inline code hides refs and wins over reference recognition", () => {
    expect(tokens("run `[[x]]` now")).toEqual([
      { kind: "inline-code", start: 4, end: 11 },
    ]);
  });

  it("code fences hide refs; text after the fence is scanned", () => {
    expect(tokens("```py\n[[x]]\n``` [[y]]")).toEqual([
      { kind: "code-fence", start: 0, end: 15 },
      { kind: "page-ref", start: 16, end: 21, content: { start: 18, end: 19 },
        title: "y", tag: false, depth: 0, parentStart: null },
    ]);
  });

  it("an unclosed backtick is plain text, so refs inside are live", () => {
    expect(tokens("`[[x]]")).toEqual([
      { kind: "page-ref", start: 1, end: 6, content: { start: 3, end: 4 },
        title: "x", tag: false, depth: 0, parentStart: null },
    ]);
  });

  it("inline code never crosses a newline", () => {
    expect(tokens("`a\n[[x]]`")).toEqual([
      { kind: "page-ref", start: 3, end: 8, content: { start: 5, end: 6 },
        title: "x", tag: false, depth: 0, parentStart: null },
    ]);
  });

  it("an unclosed fence degrades to an empty inline code pair", () => {
    // mirrors refs.py: ``` with no closer blanks only the leading ``
    expect(tokens("```\n[[x]]")).toEqual([
      { kind: "inline-code", start: 0, end: 2 },
      { kind: "page-ref", start: 4, end: 9, content: { start: 6, end: 7 },
        title: "x", tag: false, depth: 0, parentStart: null },
    ]);
  });
});

describe("scanGrammar: embeds and attributes", () => {
  it("emits the embed prefix span plus the [[embed]] ref and block ref", () => {
    expect(tokens("{{[[embed]]: ((abcdef123))}}")).toEqual([
      { kind: "embed", start: 0, end: 12 },
      { kind: "page-ref", start: 2, end: 11, content: { start: 4, end: 9 },
        title: "embed", tag: false, depth: 0, parentStart: null },
      { kind: "block-ref", start: 13, end: 26, uid: "abcdef123" },
    ]);
    expect(tokens("{{embed: ((abcdef123))}}")).toEqual([
      { kind: "embed", start: 0, end: 8 },
      { kind: "block-ref", start: 9, end: 22, uid: "abcdef123" },
    ]);
  });

  it("recognizes a block-start attribute with a trimmed title", () => {
    expect(tokens("Tags:: #AI")).toEqual([
      { kind: "attribute", start: 0, end: 6, title: "Tags" },
      { kind: "hashtag", start: 7, end: 10, title: "AI" },
    ]);
    expect(ofKind("  Key:: v", "attribute")).toEqual([
      { kind: "attribute", start: 2, end: 7, title: "Key" },
    ]);
    expect(ofKind("Key :: v", "attribute")).toEqual([
      { kind: "attribute", start: 0, end: 6, title: "Key" },
    ]);
  });

  it("rejects an attribute whose prefix contains brackets or braces", () => {
    expect(ofKind("a [[B]] c:: d", "attribute")).toEqual([]);
  });
});

describe("scanGrammar: token stream contract", () => {
  it("orders tokens by start, outer before children, with exact slices", () => {
    const text = "{{TODO}} read [[AI [[ML]]]] #ai `[[x]]` ((abcdef1234))";
    const ts = tokens(text);
    expect(ts.map((t) => t.kind)).toEqual([
      "todo", "page-ref", "page-ref", "hashtag", "inline-code", "block-ref",
    ]);
    expect(ts.map((t) => text.slice(t.start, t.end))).toEqual([
      "{{TODO}}", "[[AI [[ML]]]]", "[[ML]]", "#ai", "`[[x]]`", "((abcdef1234))",
    ]);
    expect(ts[1]).toMatchObject({ depth: 0, parentStart: null, title: "AI [[ML]]" });
    expect(ts[2]).toMatchObject({ depth: 1, parentStart: 14, title: "ML" });
  });

  it("every offset lies within the input", () => {
    const texts = [
      "", "x", "[[a [[b]] c]] #t `c` ((abcdef12)) {{embed: x}}",
      "{{[[TODO]]}} [[p]]", "Tags:: v", "```f\n[[x]]\n```",
    ];
    for (const text of texts) {
      for (const t of tokens(text)) {
        expect(t.start).toBeGreaterThanOrEqual(0);
        expect(t.end).toBeGreaterThanOrEqual(t.start);
        expect(t.end).toBeLessThanOrEqual(text.length);
        if (t.kind === "page-ref") {
          expect(t.content.start).toBeGreaterThanOrEqual(t.start);
          expect(t.content.end).toBeLessThanOrEqual(t.end);
        }
        if (t.kind === "todo") {
          expect(t.suffixEnd).toBeGreaterThanOrEqual(t.end);
          expect(t.suffixEnd).toBeLessThanOrEqual(text.length);
        }
      }
    }
  });

  it("handles 10,000 nested references iteratively without RangeError", () => {
    const n = 10_000;
    const text = "[[".repeat(n) + "x" + "]]".repeat(n);
    const ts = tokens(text);
    expect(ts).toHaveLength(n);
    expect(ts[0]).toMatchObject({
      kind: "page-ref", start: 0, end: text.length, depth: 0, parentStart: null,
    });
    expect(ts[n - 1]).toMatchObject({
      kind: "page-ref", start: 2 * n - 2, end: 2 * n + 3,
      content: { start: 2 * n, end: 2 * n + 1 },
      title: "x", depth: n - 1, parentStart: 2 * n - 4,
    });
  });
});
