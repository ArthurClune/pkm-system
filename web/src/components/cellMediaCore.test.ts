import { describe, expect, it } from "vitest";
import { type BlockSegment, tokenizeBlock } from "../grammar/tokenize";
import { cellMedia } from "./cellMediaCore";

const SHA = "a".repeat(64);
const POST = "https://bsky.app/profile/alice.bsky.social/post/3k2abc123xy";

/** The one segment of `text` that is not plain text. */
function seg(text: string): BlockSegment {
  const segs = tokenizeBlock(text).filter((s) => s.kind !== "text");
  expect(segs).toHaveLength(1);
  return segs[0];
}

describe("cellMedia", () => {
  it("labels an uploaded PDF link with its link text", () => {
    const href = `/assets/${SHA}/paper.pdf`;
    expect(cellMedia(seg(`[paper.pdf](${href})`)))
      .toEqual({ kind: "pdf", href, label: "paper.pdf" });
  });

  it("labels a pdf macro with its decoded file name", () => {
    const href = "/api/local/Papers/A%20B.pdf";
    expect(cellMedia(seg(`{{pdf: ${href}}}`)))
      .toEqual({ kind: "pdf", href, label: "A B.pdf" });
  });

  it("labels an image with its alt text", () => {
    const src = `/assets/${SHA}/bed.png`;
    expect(cellMedia(seg(`![Bed plan](${src})`)))
      .toEqual({ kind: "image", src, alt: "Bed plan", label: "Bed plan" });
  });

  it("labels an image without alt by its file name, else 'image'", () => {
    expect(cellMedia(seg("![](https://example.org/x/photo.jpg)")))
      .toMatchObject({ kind: "image", alt: "", label: "photo.jpg" });
    expect(cellMedia(seg("![](https://example.org/x/a%20b.jpg)")))
      .toMatchObject({ label: "a b.jpg" });
    expect(cellMedia(seg("![](https://example.org/x/%E0.jpg)")))
      .toMatchObject({ label: "%E0.jpg" });
    expect(cellMedia(seg("![](https://example.org/)")))
      .toMatchObject({ kind: "image", label: "image" });
  });

  it("labels a bare Bluesky post, but not a labelled link to one", () => {
    expect(cellMedia(seg(POST)))
      .toEqual({ kind: "line", label: "Bluesky post" });
    expect(cellMedia(seg(`[source](${POST})`))).toBeNull();
  });

  it("labels code blocks, mermaid diagrams and queries", () => {
    expect(cellMedia(seg("```mermaid\ngraph TD; A-->B\n```")))
      .toEqual({ kind: "line", label: "Mermaid diagram" });
    expect(cellMedia(seg("```python\nprint(1)\n```")))
      .toEqual({ kind: "line", label: "Code block" });
    expect(cellMedia(seg("{{query: {and: [[X]]}}}")))
      .toEqual({ kind: "line", label: "Query" });
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
    expect(cellMedia(seg(text))).toBeNull();
  });

  it("leaves plain text alone", () => {
    expect(cellMedia({ kind: "text", text: "hello" })).toBeNull();
  });
});
