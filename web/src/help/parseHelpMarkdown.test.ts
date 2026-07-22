// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseHelpMarkdown, type Inline } from "./parseHelpMarkdown";

const inlineText = (inline: Inline) => inline.map((s) => s.text).join("");

describe("parseHelpMarkdown", () => {
  test("parses headings of level 1-3", () => {
    const blocks = parseHelpMarkdown("# One\n\n## Two\n\n### Three\n");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, inline: [{ code: false, text: "One" }] },
      { kind: "heading", level: 2, inline: [{ code: false, text: "Two" }] },
      { kind: "heading", level: 3, inline: [{ code: false, text: "Three" }] },
    ]);
  });

  test("joins consecutive plain lines into a single paragraph", () => {
    const blocks = parseHelpMarkdown(
      "This wraps\nacross two lines.\n\nSeparate paragraph.",
    );
    expect(blocks).toEqual([
      { kind: "paragraph", inline: [{ code: false, text: "This wraps across two lines." }] },
      { kind: "paragraph", inline: [{ code: false, text: "Separate paragraph." }] },
    ]);
  });

  test("parses a pipe table with inline code spans in cells", () => {
    const md = [
      "| Shortcut | Action |",
      "|---|---|",
      "| Cmd+K | Wrap the selection as `markdown link` |",
    ].join("\n");
    const blocks = parseHelpMarkdown(md);
    expect(blocks).toEqual([
      {
        kind: "table",
        header: [
          [{ code: false, text: "Shortcut" }],
          [{ code: false, text: "Action" }],
        ],
        rows: [
          [
            [{ code: false, text: "Cmd+K" }],
            [
              { code: false, text: "Wrap the selection as " },
              { code: true, text: "markdown link" },
            ],
          ],
        ],
      },
    ]);
  });

  test("parses inline backtick code spans in headings and paragraphs", () => {
    const blocks = parseHelpMarkdown("Type `[[` to open the page-link autocomplete.");
    expect(blocks).toEqual([
      {
        kind: "paragraph",
        inline: [
          { code: false, text: "Type " },
          { code: true, text: "[[" },
          { code: false, text: " to open the page-link autocomplete." },
        ],
      },
    ]);
  });

  test("parses the real docs/keyboard.md doc with every non-blank, non-separator line accounted for", () => {
    const docPath = fileURLToPath(new URL("../../../docs/keyboard.md", import.meta.url));
    const raw = readFileSync(docPath, "utf8");

    const blocks = parseHelpMarkdown(raw);
    expect(blocks.length).toBeGreaterThan(0);

    const rendered = blocks
      .map((b) => {
        if (b.kind === "table") {
          return [...b.header, ...b.rows.flat()].map(inlineText).join(" ");
        }
        return inlineText(b.inline);
      })
      .join(" ");

    const separatorRow = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
    const originalWords = raw
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "" && !separatorRow.test(line.trim()))
      .join(" ")
      .replace(/[`|#]/g, " ")
      .split(/\s+/)
      .filter(Boolean);

    for (const word of originalWords) {
      expect(rendered).toContain(word);
    }
  });
});
