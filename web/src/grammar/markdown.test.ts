import { describe, expect, it } from "vitest";
import { scanMarkdownLinkAt, scanMarkdownLinks } from "./markdown";

describe("scanMarkdownLinkAt", () => {
  it("scans a destination with balanced parens to the end of the line", () => {
    const href =
      "/assets/be57c0b41cdc99c9ee257037ab4caa043bef7ed6926b6aac2f7233f388f0c3e9/" +
      "AI for Research Day 2026 - Programme (Public) - Schedule.pdf";
    const text = `[AI for Research Day 2026 - Programme (Public) - Schedule.pdf](${href})`;
    const link = scanMarkdownLinkAt(text, 0);
    expect(link?.destination).toEqual({ start: text.indexOf(href), end: text.length - 1 });
    expect(text.slice(link!.destination.start, link!.destination.end)).toBe(href);
    expect(link?.end).toBe(text.length);
  });

  it("stops the destination at trailing text after the balanced close", () => {
    const text = "[a](x(y)z) tail";
    const link = scanMarkdownLinkAt(text, 0);
    expect(text.slice(link!.destination.start, link!.destination.end)).toBe("x(y)z");
    expect(text.slice(link!.end)).toBe(" tail");
  });

  it("handles nested balanced parens", () => {
    const text = "[a](x((y))z)";
    const link = scanMarkdownLinkAt(text, 0);
    expect(text.slice(link!.destination.start, link!.destination.end)).toBe("x((y))z");
    expect(link?.end).toBe(text.length);
  });

  it("falls back to the first close paren when parens never balance", () => {
    const text = "[x](a (b)";
    const link = scanMarkdownLinkAt(text, 0);
    expect(text.slice(link!.destination.start, link!.destination.end)).toBe("a (b");
    expect(link?.end).toBe(text.length);
  });

  it("parses a plain link without parens unchanged", () => {
    const text = "[paper](https://x.org/a.pdf)";
    const link = scanMarkdownLinkAt(text, 0);
    expect(text.slice(link!.destination.start, link!.destination.end)).toBe(
      "https://x.org/a.pdf",
    );
    expect(link?.end).toBe(text.length);
  });

  it("balances parens within the line only, falling back to the first close", () => {
    const text = "[a](x(y)\nz)";
    const link = scanMarkdownLinkAt(text, 0);
    expect(text.slice(link!.destination.start, link!.destination.end)).toBe("x(y");
  });

  it("returns null when a newline appears before any close paren", () => {
    expect(scanMarkdownLinkAt("[a](x\ny)", 0)).toBeNull();
  });
});

describe("scanMarkdownLinks", () => {
  it("finds two links on one line where the first destination has balanced parens", () => {
    const text = "[a](x(y)z) and [b](c)";
    const spans = scanMarkdownLinks(text);
    expect(spans).toHaveLength(2);
    expect(text.slice(spans[0].destination.start, spans[0].destination.end)).toBe("x(y)z");
    expect(text.slice(spans[1].destination.start, spans[1].destination.end)).toBe("c");
  });
});
