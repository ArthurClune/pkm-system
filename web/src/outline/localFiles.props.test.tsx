import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test } from "vitest";
import { InlineSegments } from "../components/InlineSegments";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { scanMarkdownLinkAt } from "../grammar/markdown";
import { tokenizeBlock } from "../grammar/tokenize";
import { fileName, localCopyAttribute } from "./localFiles";
import { hostileName, localHref } from "./localLinkArbs";

const PREFIX = "Local copy:: ";

// "Only the brackets differ": the label is the name with each [ and ]
// swapped for ( and ), or the name itself.
const bracketsSwapped = (name: string) =>
  name.replace(/\[/g, "(").replace(/\]/g, ")");

const fileArb = fc
  .tuple(fc.array(hostileName, { maxLength: 2 }), hostileName)
  .map(([dirs, name]) => {
    const path = [...dirs, name].join("/");
    return { path, name, href: localHref(path) };
  });

describe("localCopyAttribute over hostile file names", () => {
  test("reads back as a Local copy attribute whose link is the href", () => {
    const tally = { kept: 0, swapped: 0, nfd: 0, brackets: 0 };
    fc.assert(
      fc.property(fileArb, ({ path, name, href }) => {
        const text = localCopyAttribute({ path, href });
        expect(fileName(path)).toBe(name);

        const link = scanMarkdownLinkAt(text, PREFIX.length);
        expect(link).not.toBeNull();
        if (!link) return;
        expect(link.end).toBe(text.length);
        expect(text.slice(link.destination.start, link.destination.end)).toBe(
          href,
        );
        const label = text.slice(link.label.start, link.label.end);
        const kept = label === name;
        expect(kept || label === bracketsSwapped(name)).toBe(true);
        if (!kept) expect(/[[\]]/.test(name)).toBe(true);

        const segments = tokenizeBlock(text);
        expect(segments.map((s) => s.kind)).toEqual([
          "attribute",
          "text",
          "link",
        ]);
        expect(segments[0]).toMatchObject({ name: "Local copy" });
        expect(segments[2]).toMatchObject({ text: label, href });

        if (kept) tally.kept += 1;
        else tally.swapped += 1;
        if (name !== name.normalize("NFC")) tally.nfd += 1;
        if (/[[\]]/.test(name)) tally.brackets += 1;
      }),
      { numRuns: 300 },
    );
    // Each interesting case must actually be drawn, or the property is vacuous.
    expect(tally.kept).toBeGreaterThan(30);
    expect(tally.swapped).toBeGreaterThan(10);
    expect(tally.nfd).toBeGreaterThan(10);
    expect(tally.brackets).toBeGreaterThan(30);
  });
});

describe("rendered Local copy link", () => {
  test("is an anchor with the server's href", () => {
    fc.assert(
      fc.property(
        fileArb,
        fc.constantFrom("", ".pdf", ".zip"),
        ({ path, href }, ext) => {
          const p = path + ext;
          const h = href + ext;
          const text = localCopyAttribute({ path: p, href: h });
          const { container } = render(
            <MemoryRouter future={ROUTER_FUTURE_FLAGS}>
              <InlineSegments segments={tokenizeBlock(text)} />
            </MemoryRouter>,
          );
          const hrefs = [...container.querySelectorAll("a")].map((a) =>
            a.getAttribute("href"),
          );
          cleanup();
          expect(hrefs).toContain(h);
        },
      ),
      { numRuns: 60 },
    );
  });
});
