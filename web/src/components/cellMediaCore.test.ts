import { describe, expect, it } from "vitest";
import { type BlockSegment, tokenizeBlock } from "../grammar/tokenize";
import type { CellMediaTarget } from "../contexts";
import { rawTitleOf, uidOf } from "../test-mint";
import { cellMedia } from "./cellMediaCore";

const SHA = "a".repeat(64);
const POST = "https://bsky.app/profile/alice.bsky.social/post/3k2abc123xy";
const PAGE = rawTitleOf("Reading List");
const UID = uidOf("tuid-cell1");
const QUERY: CellMediaTarget = { table: "query", page: PAGE, uid: UID };
const PLAIN: CellMediaTarget = { table: "plain" };

/** The one segment of `text` that is not plain text. */
function seg(text: string): BlockSegment {
  const segs = tokenizeBlock(text).filter((s) => s.kind !== "text");
  expect(segs).toHaveLength(1);
  return segs[0];
}

describe("cellMedia", () => {
  it("labels an uploaded PDF link with its link text", () => {
    const href = `/assets/${SHA}/paper.pdf`;
    expect(cellMedia(seg(`[paper.pdf](${href})`), QUERY))
      .toEqual({ kind: "pdf", href, label: "paper.pdf" });
  });

  it("labels a pdf macro with its decoded file name", () => {
    const href = "/api/local/Papers/A%20B.pdf";
    expect(cellMedia(seg(`{{pdf: ${href}}}`), QUERY))
      .toEqual({ kind: "pdf", href, label: "A B.pdf" });
  });

  it("labels an image with its alt text", () => {
    const src = `/assets/${SHA}/bed.png`;
    expect(cellMedia(seg(`![Bed plan](${src})`), QUERY))
      .toEqual({ kind: "image", src, alt: "Bed plan", label: "Bed plan" });
  });

  it("labels an image without alt by its file name, else 'image'", () => {
    expect(cellMedia(seg("![](https://example.org/x/photo.jpg)"), QUERY))
      .toMatchObject({ kind: "image", alt: "", label: "photo.jpg" });
    expect(cellMedia(seg("![](https://example.org/x/a%20b.jpg)"), QUERY))
      .toMatchObject({ label: "a b.jpg" });
    expect(cellMedia(seg("![](https://example.org/x/%E0.jpg)"), QUERY))
      .toMatchObject({ label: "%E0.jpg" });
    expect(cellMedia(seg("![](https://example.org/)"), QUERY))
      .toMatchObject({ kind: "image", label: "image" });
  });

  it("labels a bare Bluesky post, but not a labelled link to one", () => {
    expect(cellMedia(seg(POST), QUERY))
      .toEqual({ kind: "line", label: "Bluesky post", page: PAGE, uid: UID });
    expect(cellMedia(seg(`[source](${POST})`), QUERY)).toBeNull();
  });

  it("labels code blocks, mermaid diagrams and queries", () => {
    expect(cellMedia(seg("```mermaid\ngraph TD; A-->B\n```"), QUERY))
      .toEqual({ kind: "line", label: "Mermaid diagram", page: PAGE, uid: UID });
    expect(cellMedia(seg("```python\nprint(1)\n```"), QUERY))
      .toEqual({ kind: "line", label: "Code block", page: PAGE, uid: UID });
    expect(cellMedia(seg("{{query: {and: [[X]]}}}"), QUERY))
      .toEqual({ kind: "line", label: "Query", page: PAGE, uid: UID });
  });

  it.each([
    ["inline code", "`inline code`"],
    ["math", "see $$x^2$$ here"],
    ["a page ref", "[[Page]]"],
    ["a tag", "#tag"],
    ["a block ref", "((abcdefghi))"],
    ["a TODO", "{{[[TODO]]}} do it"],
    ["an https link", "[site](https://example.org/a)"],
    ["a GoodLinks link", `[read](/api/goodlinks/${"b".repeat(32)})`],
    ["a non-PDF asset link", `[notes](/assets/${SHA}/notes.txt)`],
    ["a pdf macro that is not a PDF", "{{pdf: https://example.org/a.pdf}}"],
  ])("leaves %s alone", (_name, text) => {
    expect(cellMedia(seg(text), QUERY)).toBeNull();
    expect(cellMedia(seg(text), PLAIN)).toBeNull();
  });

  it("leaves plain text alone", () => {
    expect(cellMedia({ kind: "text", text: "hello" }, QUERY)).toBeNull();
    expect(cellMedia({ kind: "text", text: "hello" }, PLAIN)).toBeNull();
  });
});

describe("cellMedia in a plain table", () => {
  it("shows code as code and mermaid as plain code", () => {
    expect(cellMedia(seg("```python\nprint(1)\n```"), PLAIN))
      .toEqual({ kind: "code", lang: "python", code: "print(1)" });
    expect(cellMedia(seg("```mermaid\ngraph TD; A-->B\n```"), PLAIN))
      .toEqual({ kind: "code", lang: null, code: "graph TD; A-->B" });
  });

  it("shows a bare Bluesky post as a link", () => {
    expect(cellMedia(seg(POST), PLAIN)).toEqual({ kind: "link", href: POST });
    expect(cellMedia(seg(`[source](${POST})`), PLAIN)).toBeNull();
  });

  it("shows a query as its source, as written", () => {
    expect(cellMedia(seg("{{query: {and: [[X]]}}}"), PLAIN))
      .toEqual({ kind: "source", text: "{{query: {and: [[X]]}}}" });
    const written = "{{[[query]]:  {and: [[X]]} | view: cards}}";
    expect(cellMedia(seg(written), PLAIN))
      .toEqual({ kind: "source", text: written });
  });

  it("keeps the labels of PDFs and images", () => {
    const href = `/assets/${SHA}/paper.pdf`;
    expect(cellMedia(seg(`[paper.pdf](${href})`), PLAIN))
      .toEqual({ kind: "pdf", href, label: "paper.pdf" });
    const src = `/assets/${SHA}/bed.png`;
    expect(cellMedia(seg(`![Bed plan](${src})`), PLAIN))
      .toEqual({ kind: "image", src, alt: "Bed plan", label: "Bed plan" });
  });
});
