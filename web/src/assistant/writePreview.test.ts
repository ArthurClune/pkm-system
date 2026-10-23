import { describe, expect, test } from "vitest";
import { formatTarget, parseWritePreview, quoteValue } from "./writePreview";

const validOp = {
  action: "update_block",
  targets: [["uid", "VICTIMUID01"], ["mark", null]],
  content: [["text", "Tidied wording.", 480]],
  warnings: [],
};

describe("quoteValue", () => {
  test("wraps in quotes and escapes quote and backslash", () => {
    expect(quoteValue('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  test("keeps a newline as a real line break", () => {
    expect(quoteValue("x\ny")).toBe('"x\ny"');
  });

  test("escapes a bidi override and a C0 control as text", () => {
    expect(quoteValue(" ‮\u0007")).toBe('" \\u202E\\u0007"');
  });

  // The value cannot draw a fake argument list: its own quotes are escaped,
  // so the only unescaped quotes are the two the card adds.
  test("a value imitating argument syntax stays one quoted value", () => {
    expect(quoteValue('x", uid="SAFE')).toBe('"x\\", uid=\\"SAFE"');
  });

  test.each([
    ["tab and carriage return", "\t\r", "\\u0009\\u000D"],
    ["DEL and C1", "\u007F\u0085\u009F", "\\u007F\\u0085\\u009F"],
    ["line and paragraph separators", "  ", "\\u2028\\u2029"],
    ["zero-width and direction marks", "​‎‏", "\\u200B\\u200E\\u200F"],
    ["bidi embeddings and isolates", "‪‭⁦⁩", "\\u202A\\u202D\\u2066\\u2069"],
    ["byte order mark", "﻿", "\\uFEFF"],
    ["soft hyphen", "­", "\\u00AD"],
  ])("escapes %s", (_label, input, escaped) => {
    expect(quoteValue(`a${input}b`)).toBe(`"a${escaped}b"`);
  });

  // An astral format character (a Unicode tag, which can smuggle invisible
  // ASCII) is written as its UTF-16 surrogate pair, the same form JSON uses.
  test("escapes an astral format character as a surrogate pair", () => {
    expect(quoteValue("a\u{E0041}b")).toBe('"a\\uDB40\\uDC41b"');
  });

  test("escapes a lone surrogate instead of throwing", () => {
    expect(quoteValue("a\uD800b\uDC00")).toBe('"a\\uD800b\\uDC00"');
  });

  // A combining mark draws onto the character before it. After the opening
  // quote, an escaped quote or a newline it would reshape that quote glyph or
  // begin a line, so the whole run of marks there is escaped.
  test("escapes combining marks after the opening quote", () => {
    expect(quoteValue("\u0338x")).toBe('"\\u0338x"');
    expect(quoteValue("\u0338\u20DDx")).toBe('"\\u0338\\u20DDx"');
  });

  test("escapes combining marks at the start of a line", () => {
    expect(quoteValue("a\n\u0301b")).toBe('"a\n\\u0301b"');
  });

  test("escapes combining marks after an escaped quote", () => {
    expect(quoteValue('a"\u0338')).toBe('"a\\"\\u0338"');
  });

  test("keeps combining marks on an ordinary letter", () => {
    expect(quoteValue("e\u0301")).toBe('"e\u0301"');
  });

  // Hangul and Braille fillers are letters or symbols that draw as blank
  // space, so "Inbox\u3164" would read as "Inbox ".
  test("escapes the invisible filler letters", () => {
    expect(quoteValue("a\u115F\u1160\u3164\uFFA0\u2800b"))
      .toBe('"a\\u115F\\u1160\\u3164\\uFFA0\\u2800b"');
  });

  test("leaves printable non-ASCII alone", () => {
    expect(quoteValue("café 日本 😀")).toBe('"café 日本 😀"');
  });
});

describe("formatTarget", () => {
  test("a null page is today's daily note", () => {
    expect(formatTarget("page", null)).toBe("today's daily note");
  });

  test("any other null is none", () => {
    expect(formatTarget("parent", null)).toBe("none");
  });

  test("a string is quoted", () => {
    expect(formatTarget("uid", 'A"B')).toBe('"A\\"B"');
  });

  test("other values render as JSON", () => {
    expect(formatTarget("allow_merge", true)).toBe("true");
    expect(formatTarget("index", 3)).toBe("3");
    expect(formatTarget("extra", { a: [1, "x"] })).toBe('{"a":[1,"x"]}');
  });

  // JSON.stringify leaves DEL, C1 and format characters raw; a nested value
  // must not smuggle a bidi override past the card.
  test("JSON values escape a combining mark after a quote", () => {
    expect(formatTarget("extra", ["\u0338"])).toBe('["\\u0338"]');
  });

  test("JSON values escape non-printables too", () => {
    expect(formatTarget("extra", ["‮\u0085"])).toBe('["\\u202E\\u0085"]');
    expect(formatTarget("extra", { "k⁦": "\u{E0041}" }))
      .toBe('{"k\\u2066":"\\uDB40\\uDC41"}');
  });
});

describe("parseWritePreview", () => {
  const parsed = (op: unknown) => parseWritePreview({ ops: [op], summary: "s" });

  test("accepts a well-formed preview", () => {
    const raw = { ops: [validOp], summary: "update_block(uid='VICTIMUID01')" };
    expect(parseWritePreview(raw)).toEqual(raw);
  });

  test("keeps target values of any JSON type", () => {
    const op = { ...validOp,
      targets: [["a", 1], ["b", false], ["c", null], ["d", { x: [1] }]] };
    expect(parseWritePreview({ ops: [op], summary: "" })?.ops[0].targets)
      .toEqual(op.targets);
  });

  // Extra target keys and warning text come from the model's arguments; the
  // card renders them unquoted, so they arrive already escaped.
  test("escapes target keys and warnings, unquoted", () => {
    const op = { ...validOp,
      targets: [["page\u202E", "x"], ["\u0338k\ney", 1]],
      warnings: ["merges into \"a\u202Eb\u3164\""] };
    const parsed = parseWritePreview({ ops: [op], summary: "s" });
    expect(parsed?.ops[0].targets).toEqual(
      [["page\\u202E", "x"], ["\\u0338k\\u000Aey", 1]]);
    expect(parsed?.ops[0].warnings).toEqual(['merges into "a\\u202Eb\\u3164"']);
  });

  test("leaves target values and content to the card's own quoting", () => {
    const op = { ...validOp, targets: [["uid", "a\u202E"]],
      content: [["text", "b\u202E", 2]] };
    const parsed = parseWritePreview({ ops: [op], summary: "s" });
    expect(parsed?.ops[0].targets).toEqual([["uid", "a\u202E"]]);
    expect(parsed?.ops[0].content).toEqual([["text", "b\u202E", 2]]);
  });

  // total_len is Python's len, which counts code points: an emoji is one.
  test("accepts content whose code points fit its total length", () => {
    const op = { ...validOp, content: [["text", "😀😀", 2]] };
    expect(parsed(op)?.ops[0].content).toEqual([["text", "😀😀", 2]]);
  });

  test("drops keys outside the shape", () => {
    const raw = { ops: [{ ...validOp, extra: 1 }], summary: "s", extra: 2 };
    expect(parseWritePreview(raw)).toEqual({ ops: [validOp], summary: "s" });
  });

  test.each([
    ["not an object", 42],
    ["null", null],
    ["an array", []],
    ["a missing ops", { summary: "s" }],
    ["ops not an array", { ops: {}, summary: "s" }],
    ["no ops", { ops: [], summary: "s" }],
    ["a missing summary", { ops: [validOp] }],
    ["an op that is not an object", { ops: ["x"], summary: "s" }],
    ["an action that is not a string", { ops: [{ ...validOp, action: 1 }], summary: "s" }],
    ["targets not an array", { ops: [{ ...validOp, targets: {} }], summary: "s" }],
    ["a target that is not a pair", { ops: [{ ...validOp, targets: [["uid"]] }], summary: "s" }],
    ["a target with three items", { ops: [{ ...validOp, targets: [["uid", "x", "y"]] }], summary: "s" }],
    ["a target key that is not a string", { ops: [{ ...validOp, targets: [[1, "x"]] }], summary: "s" }],
    ["content not an array", { ops: [{ ...validOp, content: "x" }], summary: "s" }],
    ["a content entry whose length is not a number",
      { ops: [{ ...validOp, content: [["text", "x", "480"]] }], summary: "s" }],
    ["a content entry whose length is negative",
      { ops: [{ ...validOp, content: [["text", "x", -1]] }], summary: "s" }],
    ["a content value that is not a string",
      { ops: [{ ...validOp, content: [["text", 5, 1]] }], summary: "s" }],
    ["a content value longer than its total length",
      { ops: [{ ...validOp, content: [["text", "abcdef", 2]] }], summary: "s" }],
    ["a content entry with two items", { ops: [{ ...validOp, content: [["text", "x"]] }], summary: "s" }],
    ["warnings not an array", { ops: [{ ...validOp, warnings: "w" }], summary: "s" }],
    ["a warning that is not a string", { ops: [{ ...validOp, warnings: [1] }], summary: "s" }],
  ])("rejects %s", (_label, raw) => {
    expect(parseWritePreview(raw)).toBeNull();
  });
});
