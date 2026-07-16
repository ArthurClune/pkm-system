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
      { kind: "link", text: "https://example.com/#anchor", href: "https://example.com/#anchor" },
    ]);
  });

  it("autolinks bare http(s) URLs at word boundaries", () => {
    const url = "https://bsky.app/profile/cpaxton.bsky.social/post/3mp4jonwrfk2h";
    expect(tokenizeBlock(url)).toEqual([
      { kind: "link", text: url, href: url },
    ]);
    expect(tokenizeBlock(`see ${url} today`)).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: url, href: url },
      { kind: "text", text: " today" },
    ]);
    expect(tokenizeBlock("plain http://x.org here")).toEqual([
      { kind: "text", text: "plain " },
      { kind: "link", text: "http://x.org", href: "http://x.org" },
      { kind: "text", text: " here" },
    ]);
  });

  it("excludes trailing punctuation and wrappers from autolinked URLs", () => {
    expect(tokenizeBlock("read https://example.com/page.")).toEqual([
      { kind: "text", text: "read " },
      { kind: "link", text: "https://example.com/page", href: "https://example.com/page" },
      { kind: "text", text: "." },
    ]);
    expect(tokenizeBlock("(https://example.com/x)")).toEqual([
      { kind: "text", text: "(" },
      { kind: "link", text: "https://example.com/x", href: "https://example.com/x" },
      { kind: "text", text: ")" },
    ]);
  });

  it("does not autolink mid-word, scheme-only, or inside code/links", () => {
    expect(tokenizeBlock("foohttps://example.com")).toEqual([
      { kind: "text", text: "foohttps://example.com" },
    ]);
    expect(tokenizeBlock("empty https:// scheme")).toEqual([
      { kind: "text", text: "empty https:// scheme" },
    ]);
    expect(tokenizeBlock("run `https://example.com` now")).toEqual([
      { kind: "text", text: "run " },
      { kind: "inline-code", code: "https://example.com" },
      { kind: "text", text: " now" },
    ]);
    expect(tokenizeBlock("[paper](https://x.org/a.pdf)")).toEqual([
      { kind: "link", text: "paper", href: "https://x.org/a.pdf" },
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

  it("keeps an unclosed outer [[ as text while the balanced inner ref links", () => {
    expect(tokenizeBlock("see [[a [[b]] c")).toEqual([
      { kind: "text", text: "see [[a " },
      { kind: "page-ref", title: "b", tag: false },
      { kind: "text", text: " c" },
    ]);
  });

  it("parses Unicode hashtags like the server grammar", () => {
    expect(tokenizeBlock("see #héllo now")).toEqual([
      { kind: "text", text: "see " },
      { kind: "page-ref", title: "héllo", tag: true },
      { kind: "text", text: " now" },
    ]);
  });

  it("renders embed prefixes as plain text with a live block ref", () => {
    expect(tokenizeBlock("{{embed: ((abcdef123))}}")).toEqual([
      { kind: "text", text: "{{embed: " },
      { kind: "block-ref", uid: "abcdef123" },
      { kind: "text", text: "}}" },
    ]);
  });

  it("treats blanked code as a tag boundary, matching refs.py", () => {
    // Canonical scanner rule: code is blanked before hashtag recognition,
    // so a # immediately after inline code starts a tag.
    expect(tokenizeBlock("`x`#tag")).toEqual([
      { kind: "inline-code", code: "x" },
      { kind: "page-ref", title: "tag", tag: true },
    ]);
  });

  it("grabs {{[[pdf]]: url}} embed macros in both spellings", () => {
    const href = `/assets/${"ab".repeat(32)}/JLnhu4GhbD-SITS%20Readiness%20Assessment.pdf`;
    expect(tokenizeBlock(`{{[[pdf]]: ${href}}}`)).toEqual([
      { kind: "pdf-embed", href },
    ]);
    expect(tokenizeBlock(`{{pdf: ${href}}}`)).toEqual([
      { kind: "pdf-embed", href },
    ]);
  });

  it("keeps text around a pdf macro as inline chunks", () => {
    expect(tokenizeBlock("see {{[[pdf]]: /assets/x/a.pdf}} end")).toEqual([
      { kind: "text", text: "see " },
      { kind: "pdf-embed", href: "/assets/x/a.pdf" },
      { kind: "text", text: " end" },
    ]);
  });

  it("trims whitespace around the macro href and keeps an empty body inert", () => {
    expect(tokenizeBlock("{{[[pdf]]:   /assets/x/a.pdf  }}")).toEqual([
      { kind: "pdf-embed", href: "/assets/x/a.pdf" },
    ]);
    // empty body still tokenizes; the renderer's href guards make it inert
    expect(tokenizeBlock("{{[[pdf]]: }}")).toEqual([
      { kind: "pdf-embed", href: "" },
    ]);
  });

  it("does not treat unterminated or colon-less pdf macros as embeds", () => {
    expect(tokenizeBlock("{{[[pdf]]: /assets/x/a.pdf")
      .some((s) => s.kind === "pdf-embed")).toBe(false);
    expect(tokenizeBlock("{{[[pdf]]}}")
      .some((s) => s.kind === "pdf-embed")).toBe(false);
  });
});
