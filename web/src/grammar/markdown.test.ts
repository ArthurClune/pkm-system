import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  markdownLinkScanner, scanMarkdownLinkAt, scanMarkdownLinks, type MarkdownSpan,
} from "./markdown";

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

// The scanner as it was before it paired brackets once per line: from each
// `[` it walked to the end of the line, so a line of lone `[` cost the
// square of its length. Kept here as the reference the linear one must
// match on every text.
function referenceDestinationClose(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length && text[i] !== "\n"; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return text.indexOf(")", start);
}

function referenceLinkAt(text: string, start: number): MarkdownSpan | null {
  const image = text[start] === "!";
  const open = image ? start + 1 : start;
  if (text[open] !== "[" || text.startsWith("[[", open)) return null;
  let depth = 1;
  let cursor = open + 1;
  while (cursor < text.length && depth > 0) {
    if (text[cursor] === "\n") return null;
    if (text[cursor] === "[") depth += 1;
    else if (text[cursor] === "]") depth -= 1;
    cursor += 1;
  }
  if (depth !== 0 || text[cursor] !== "(") return null;
  const close = referenceDestinationClose(text, cursor + 1);
  if (close === -1 || text.slice(cursor + 1, close).includes("\n")) return null;
  return {
    kind: image ? "image" : "link",
    start,
    end: close + 1,
    label: { start: open + 1, end: cursor - 1 },
    destination: { start: cursor + 1, end: close },
  };
}

function referenceLinks(text: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const candidate = text[cursor] === "!" && text[cursor + 1] === "["
      ? referenceLinkAt(text, cursor)
      : text[cursor] === "[" && !text.startsWith("[[", cursor)
        ? referenceLinkAt(text, cursor)
        : null;
    if (candidate) {
      spans.push(candidate);
      cursor = candidate.end;
    } else {
      cursor += 1;
    }
  }
  return spans;
}

// Bracket and paren soup, nested and unbalanced, across lines, with `](`
// weighted so that labels meet destinations often enough to draw links.
const soup = fc.array(
  fc.oneof(
    { arbitrary: fc.constantFrom("[", "]", "(", ")", "[[", "]]", "![", "\n",
                                 "a", " ", "x)"), weight: 4 },
    { arbitrary: fc.constantFrom("](", "[a](b)"), weight: 2 },
  ),
  { maxLength: 40 },
).map((parts) => parts.join(""));

describe("markdown links match the per-[ reference scan", () => {
  it("at every start, from either entry point", () => {
    let links = 0;
    fc.assert(fc.property(soup, (text) => {
      const at = markdownLinkScanner(text);
      for (let i = 0; i <= text.length; i += 1) {
        const want = referenceLinkAt(text, i);
        expect(scanMarkdownLinkAt(text, i)).toEqual(want);
        expect(at(i)).toEqual(want);
        if (want !== null) links += 1;
      }
      expect(scanMarkdownLinks(text)).toEqual(referenceLinks(text));
    }), { numRuns: 3000 });
    // The soup must actually draw links, not only misses.
    expect(links).toBeGreaterThan(500);
  });
});

describe("markdown links on a long line", () => {
  // A generous bound: the per-[ walk took 17.8 s on 200,000 characters of
  // lone [ and would take hours on 1,000,000.
  it.each([
    ["[a ×100,000", "[a".repeat(100_000)],
    ["[a ×500,000", "[a".repeat(500_000)],
    ["[a]( ×250,000", "[a](".repeat(250_000)],
  ])("scans %s in linear time", (_name, text) => {
    const started = performance.now();
    expect(scanMarkdownLinks(text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(3000);
  }, 30_000);
});
