import { describe, expect, test } from "vitest";
import { PREVIEW_FIELDS } from "./previewKeys.gen";
import { formatTarget, parseWritePreview, quoteValue } from "./writePreview";

const found = { state: "found", page_title: "Inbox", excerpt: "Old wording.",
  text_length: 12, descendants: null };

const validOp = {
  action: "update block",
  targets: [["uid", "VICTIMUID01"], ["mark", null]],
  content: [["text", "Tidied wording.", 15]],
  warnings: [],
  current: found,
};

const deleteOp = (current: unknown) => ({ action: "delete block",
  targets: [["uid", "VICTIMUID01"]], content: [], warnings: [], current });

const saveOp = { action: "save note", targets: [["page", null]],
  content: [["text", "hi", 2]], warnings: [], current: null };

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

  // a target is one line: a newline kept raw would start a line flush with
  // the key column, where it could draw a row such as `parent: none"`
  test("a newline in a string target is escaped", () => {
    expect(formatTarget("page", "Inbox\nparent: none"))
      .toBe('"Inbox\\u000Aparent: none"');
  });

  test("content keeps its newlines", () => {
    expect(quoteValue("a\nb")).toBe('"a\nb"');
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
  const parsed = (op: unknown) => parseWritePreview(
    { ops: [op], summary: "s", writes_in_flight: false });
  const parsedOps = (...ops: unknown[]) =>
    parseWritePreview({ ops, summary: "s", writes_in_flight: false });

  test("accepts a well-formed preview", () => {
    const raw = { ops: [validOp], summary: "update_block(uid='VICTIMUID01')",
      writes_in_flight: false };
    expect(parseWritePreview(raw)).toEqual(raw);
  });

  test.each([true, false])("carries the server's stamp (%s)", (stamp) => {
    expect(parseWritePreview({ ops: [validOp], summary: "s",
      writes_in_flight: stamp })?.writes_in_flight).toBe(stamp);
  });

  // a field the server adds to WritePreview reaches previewKeys.gen.ts, and
  // this fails until the parser carries it
  test("carries every field the server's preview has", () => {
    const raw = { ops: [validOp], summary: "s", writes_in_flight: true };
    expect(Object.keys(parseWritePreview(raw) ?? {}).sort())
      .toEqual([...PREVIEW_FIELDS].sort());
  });

  test("keeps target values of any JSON type", () => {
    for (const [uid, mark] of [[1, false], [null, { x: [1] }]]) {
      const op = { ...validOp, targets: [["uid", uid], ["mark", mark]] };
      expect(parseWritePreview({ ops: [op], summary: "",
        writes_in_flight: false })?.ops[0].targets)
        .toEqual(op.targets);
    }
  });

  // The server JSON-quotes values inside a warning, but the rest of it can
  // still carry what the card renders unquoted, so it arrives escaped.
  test("escapes warnings, unquoted", () => {
    const op = { ...validOp, warnings: ["merges into \"a‮bㅤ\"\nx"] };
    expect(parsed(op)?.ops[0].warnings)
      .toEqual(['merges into "a\\u202Eb\\u3164"\\u000Ax']);
  });

  // The server JSON-quotes every value inside a warning, so its backslashes
  // are escapes already; doubling them would make `\"` read as a closing quote.
  test("leaves a warning's backslashes as the server wrote them", () => {
    const op = { ...validOp,
      warnings: ['if "a\\"b, c" exists, "d" is merged into it'] };
    expect(parsed(op)?.ops[0].warnings)
      .toEqual(['if "a\\"b, c" exists, "d" is merged into it']);
  });

  test("leaves target values and content to the card's own quoting", () => {
    const op = { ...validOp, targets: [["uid", "a‮"]],
      content: [["text", "b‮", 2]] };
    const out = parsed(op);
    expect(out?.ops[0].targets).toEqual([["uid", "a‮"]]);
    expect(out?.ops[0].content).toEqual([["text", "b‮", 2]]);
  });

  // total_len is Python's len, which counts code points: an emoji is one.
  test("accepts content whose code points match its total length", () => {
    const op = { ...validOp, content: [["text", "😀😀", 2]] };
    expect(parsed(op)?.ops[0].content).toEqual([["text", "😀😀", 2]]);
  });

  test("drops keys outside the shape", () => {
    const raw = { ops: [{ ...validOp, extra: 1,
      current: { ...found, extra: 3 } }], summary: "s", extra: 2,
      writes_in_flight: true };
    expect(parseWritePreview(raw))
      .toEqual({ ops: [validOp], summary: "s", writes_in_flight: true });
  });

  test("an op that touches no existing block carries current null", () => {
    expect(parsed(saveOp)?.ops[0].current).toBeNull();
  });

  // the card quotes the page title, excerpt and alias itself
  test("keeps the current block's page, excerpt and alias raw", () => {
    const current = { ...found, page_title: "a‮", excerpt: "b\nㅤ",
      text_length: 3 };
    expect(parsed({ ...validOp, current })?.ops[0].current).toEqual(current);
    const created = { state: "created", write: 1, alias: "x‮" };
    expect(parsedOps(saveOp, { ...validOp, current: created })?.ops[1].current)
      .toEqual(created);
  });

  test("accepts a block that is missing", () => {
    expect(parsed({ ...validOp, current: { state: "missing" } })?.ops[0].current)
      .toEqual({ state: "missing" });
  });

  test("accepts text_length equal to the excerpt's code points", () => {
    const current = { ...found, excerpt: "😀😀", text_length: 2 };
    expect(parsed({ ...validOp, current })?.ops[0].current).toEqual(current);
  });

  // the server clips the excerpt at CURRENT_EXCERPT_CHARS code points
  test("accepts text_length above a clipped excerpt's code points", () => {
    const current = { ...found, excerpt: "😀".repeat(200), text_length: 5000 };
    expect(parsed({ ...validOp, current })?.ops[0].current).toEqual(current);
  });

  // only an earlier write of the batch can create the block
  test("accepts a block created by the write just before", () => {
    const created = { state: "created", write: 2, alias: "a" };
    expect(parsedOps(saveOp, saveOp, { ...validOp, current: created })
      ?.ops[2].current).toEqual(created);
  });

  test.each([0, 4])("a delete carries the blocks under it (%s)", (n) => {
    const current = { ...found, descendants: n };
    expect(parsed(deleteOp(current))?.ops[0].current).toEqual(current);
  });

  const created = (write: unknown, alias: unknown = "a") =>
    ({ state: "created", write, alias });

  // one op in an otherwise well-formed preview
  const one = (op: unknown) =>
    ({ ops: [op], summary: "s", writes_in_flight: false });

  test.each([
    ["not an object", 42],
    ["null", null],
    ["an array", []],
    ["a missing ops", { summary: "s", writes_in_flight: false }],
    ["ops not an array", { ops: {}, summary: "s", writes_in_flight: false }],
    ["no ops", { ops: [], summary: "s", writes_in_flight: false }],
    ["a missing summary", { ops: [validOp], writes_in_flight: false }],
    // whether the card may be stale is the server's to say
    ["a missing stamp", { ops: [validOp], summary: "s" }],
    ["a stamp that is not a boolean",
      { ops: [validOp], summary: "s", writes_in_flight: "yes" }],
    ["an op that is not an object", one("x")],
    ["an action that is not a string", one({ ...validOp, action: 1 })],
    ["targets not an array", one({ ...validOp, targets: {} })],
    ["a target that is not a pair", one({ ...validOp, targets: [["uid"]] })],
    ["a target with three items", one({ ...validOp, targets: [["uid", "x", "y"]] })],
    ["a target key that is not a string", one({ ...validOp, targets: [[1, "x"]] })],
    ["content not an array", one({ ...validOp, content: "x" })],
    ["a content entry whose length is not a number",
      one({ ...validOp, content: [["text", "x", "480"]] })],
    ["a content entry whose length is negative",
      one({ ...validOp, content: [["text", "x", -1]] })],
    ["a content value that is not a string",
      one({ ...validOp, content: [["text", 5, 1]] })],
    ["a content value longer than its total length",
      one({ ...validOp, content: [["text", "abcdef", 2]] })],
    // the server sends content whole: a shorter value would be approved
    // partly unseen
    ["a content value shorter than its total length",
      one({ ...validOp, content: [["text", "ab", 5000]] })],
    ["a content entry with two items", one({ ...validOp, content: [["text", "x"]] })],
    ["warnings not an array", one({ ...validOp, warnings: "w" })],
    ["a warning that is not a string", one({ ...validOp, warnings: [1] })],
  ])("rejects %s", (_label, raw) => {
    expect(parseWritePreview(raw)).toBeNull();
  });

  // The card shows only what each action's table entry names: a key or an
  // action outside it could only be a decoy, so the card offers just Deny.
  test.each([
    ["the tool's name instead of its label", { ...validOp, action: "update_block" }],
    ["an action named constructor", { ...validOp, action: "constructor" }],
    ["an action named __proto__", { ...validOp, action: "__proto__" }],
    ["an action spelling an escape", { ...saveOp, action: "save\\u0020note" }],
    ["a save note carrying a uid target",
      { ...saveOp, targets: [["page", null], ["uid", "VICTIMUID01"]] }],
    ["a target key with a bidi override", { ...validOp, targets: [["uid‮", "x"]] }],
    ["a target key spelling an escape", { ...validOp, targets: [["uid\\u0022", "x"]] }],
    ["a target key named constructor", { ...validOp, targets: [["constructor", "x"]] }],
    // the server builds each op's rows from one dict, so a repeated key
    // could only be a decoy row beside the real one
    ["a repeated target key",
      { ...validOp, targets: [["uid", "VICTIMUID01"], ["uid", "DECOYUID01"]] }],
    ["a repeated content key",
      { ...validOp, content: [["text", "a", 1], ["text", "b", 1]] }],
    ["a content key the action does not declare",
      { ...validOp, content: [["items", "b", 1]] }],
    ["a content key with a bidi override", { ...validOp, content: [["te‮xt", "b", 1]] }],
    ["content on an action without any",
      { ...deleteOp({ ...found, descendants: 0 }), content: [["text", "b", 1]] }],
  ])("rejects %s", (_label, op) => {
    expect(parsed(op)).toBeNull();
  });

  test.each([
    ["no current on an update", { ...validOp, current: null }],
    ["an update without a current key",
      { action: validOp.action, targets: validOp.targets,
        content: validOp.content, warnings: [] }],
    ["a current block on a save note", { ...saveOp, current: found }],
    ["a missing block on a save note", { ...saveOp, current: { state: "missing" } }],
    ["a current that is not an object", { ...validOp, current: "found" }],
    ["a current in an unknown state", { ...validOp, current: { state: "gone" } }],
    ["a current with no state", { ...validOp, current: {} }],
    ["a found page title that is not a string",
      { ...validOp, current: { ...found, page_title: null } }],
    ["a found excerpt that is not a string",
      { ...validOp, current: { ...found, excerpt: 5 } }],
    ["a found text_length that is not a number",
      { ...validOp, current: { ...found, text_length: "12" } }],
    ["a found text_length that is not an integer",
      { ...validOp, current: { ...found, text_length: 12.5 } }],
    ["a found text_length past the safe integers",
      { ...validOp, current: { ...found, text_length: 2 ** 53 } }],
    ["a found text_length below the excerpt's code points",
      { ...validOp, current: { ...found, excerpt: "😀😀", text_length: 1 } }],
    // the server clips at 200 code points: a longer excerpt is not its own,
    // and a shorter one with more text left would hide part of the clip
    ["an excerpt longer than the server's clip",
      { ...validOp, current: { ...found, excerpt: "y".repeat(201),
        text_length: 201 } }],
    ["an excerpt shorter than the clip with more text left",
      { ...validOp, current: { ...found, excerpt: "abc", text_length: 5000 } }],
    ["a block created by the first write itself",
      { ...validOp, current: created(1) }],
    ["a created block with no write", { ...validOp, current: created(undefined) }],
    ["a created block whose alias is not a string",
      { ...validOp, current: created(1, 7) }],
    ["a count of blocks under an update",
      { ...validOp, current: { ...found, descendants: 3 } }],
    ["an update's found block without a descendants key",
      { ...validOp, current: { state: "found", page_title: "Inbox",
        excerpt: "Old wording.", text_length: 12 } }],
    ["a delete without its count", deleteOp(found)],
    ["a delete with a negative count", deleteOp({ ...found, descendants: -1 })],
    ["a delete with a fractional count", deleteOp({ ...found, descendants: 1.5 })],
    ["a delete with a count that is not a number",
      deleteOp({ ...found, descendants: "4" })],
  ])("rejects %s", (_label, op) => {
    expect(parsed(op)).toBeNull();
  });

  test.each([
    ["write 0", 0],
    ["its own write", 2],
    ["a later write", 3],
    ["a fractional write", 1.5],
    ["a write that is not a number", "1"],
  ])("rejects a block created by %s", (_label, write) => {
    expect(parsedOps(saveOp, { ...validOp, current: created(write) }))
      .toBeNull();
  });
});
