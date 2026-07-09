import { describe, expect, it } from "vitest";
import { tokenizeBlock } from "./tokenize";

describe("tokenizeBlock", () => {
  it("parses page refs, tags and block refs around plain text", () => {
    expect(tokenizeBlock("read [[Machine Learning]] #AI ((abc123XYZ))")).toEqual([
      { kind: "text", text: "read " },
      { kind: "page-ref", title: "Machine Learning", tag: false },
      { kind: "text", text: " " },
      { kind: "page-ref", title: "AI", tag: true },
      { kind: "text", text: " " },
      { kind: "block-ref", uid: "abc123XYZ" },
    ]);
  });

  it("keeps the full outer title for nested page refs", () => {
    expect(tokenizeBlock("see [[AI [[GPT-3]] notes]]")).toEqual([
      { kind: "text", text: "see " },
      { kind: "page-ref", title: "AI [[GPT-3]] notes", tag: false },
    ]);
  });

  it("parses #[[long tags]] and requires whitespace/( before #", () => {
    expect(tokenizeBlock("#[[Generative Models]]")).toEqual([
      { kind: "page-ref", title: "Generative Models", tag: true },
    ]);
    expect(tokenizeBlock("https://example.com/#anchor")).toEqual([
      { kind: "text", text: "https://example.com/#anchor" },
    ]);
  });

  it("parses an attribute only at the start of the block", () => {
    expect(tokenizeBlock("Tags:: #AI")).toEqual([
      { kind: "attribute", name: "Tags" },
      { kind: "text", text: " " },
      { kind: "page-ref", title: "AI", tag: true },
    ]);
    // brackets in the prefix disqualify it, matching the Python char class
    expect(tokenizeBlock("a [[B]] c:: d")).toEqual([
      { kind: "text", text: "a " },
      { kind: "page-ref", title: "B", tag: false },
      { kind: "text", text: " c:: d" },
    ]);
  });

  it("does not scan inside inline code", () => {
    expect(tokenizeBlock("run `[[not a ref]]` now")).toEqual([
      { kind: "text", text: "run " },
      { kind: "inline-code", code: "[[not a ref]]" },
      { kind: "text", text: " now" },
    ]);
  });

  it("parses code fences with an optional language tag", () => {
    expect(tokenizeBlock("```python\nx = 1\n```")).toEqual([
      { kind: "code-block", lang: "python", code: "x = 1" },
    ]);
    expect(tokenizeBlock("```\nplain\n```")).toEqual([
      { kind: "code-block", lang: null, code: "plain" },
    ]);
  });

  it("parses emphasis with nested inline constructs", () => {
    expect(tokenizeBlock("**very [[Deep]]** __it__ ~~st~~ ^^hl^^")).toEqual([
      { kind: "bold", children: [
        { kind: "text", text: "very " },
        { kind: "page-ref", title: "Deep", tag: false },
      ] },
      { kind: "text", text: " " },
      { kind: "italic", children: [{ kind: "text", text: "it" }] },
      { kind: "text", text: " " },
      { kind: "strike", children: [{ kind: "text", text: "st" }] },
      { kind: "text", text: " " },
      { kind: "highlight", children: [{ kind: "text", text: "hl" }] },
    ]);
  });

  it("parses images and markdown links", () => {
    expect(tokenizeBlock("![shot](/assets/ab12/pic.png) [paper](https://x.org/a.pdf)")).toEqual([
      { kind: "image", alt: "shot", src: "/assets/ab12/pic.png" },
      { kind: "text", text: " " },
      { kind: "link", text: "paper", href: "https://x.org/a.pdf" },
    ]);
  });

  it("parses TODO/DONE prefixes as read-only checkboxes", () => {
    expect(tokenizeBlock("{{[[TODO]]}} buy milk")).toEqual([
      { kind: "todo", done: false },
      { kind: "text", text: "buy milk" },
    ]);
    expect(tokenizeBlock("{{[[DONE]]}} shipped")).toEqual([
      { kind: "todo", done: true },
      { kind: "text", text: "shipped" },
    ]);
    expect(tokenizeBlock("{{TODO}} short form")).toEqual([
      { kind: "todo", done: false },
      { kind: "text", text: "short form" },
    ]);
  });

  it("grabs query expressions with a balanced-brace scan", () => {
    expect(tokenizeBlock("{{[[query]]: {and: [[Paper]] [[Link]]}}}")).toEqual([
      { kind: "query", expr: "{and: [[Paper]] [[Link]]}" },
    ]);
    expect(tokenizeBlock("{{query: {and: [[A]] {or: [[B]] [[C]]}}}}")).toEqual([
      { kind: "query", expr: "{and: [[A]] {or: [[B]] [[C]]}}" },
    ]);
    expect(tokenizeBlock("before {{[[query]]: {and: [[A]]}}} after")).toEqual([
      { kind: "text", text: "before " },
      { kind: "query", expr: "{and: [[A]]}" },
      { kind: "text", text: " after" },
    ]);
  });

  it("preserves newlines as line breaks outside code fences", () => {
    expect(tokenizeBlock("line one\nline two")).toEqual([
      { kind: "text", text: "line one" },
      { kind: "linebreak" },
      { kind: "text", text: "line two" },
    ]);
  });
});
