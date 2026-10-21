import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { isPdfHref } from "../components/InlineSegments";
import { scanMarkdownLinkAt } from "../grammar/markdown";
import { tokenizeBlock } from "../grammar/tokenize";
import { assetLabel, assetNameFromSegment } from "./assetNames";
import {
  assetHref,
  legacyNameArb,
  shaArb,
  uploadNameArb,
  uploadTextArb,
} from "./assetUploadArbs";

const tally = {
  total: 0,
  space: 0,
  paren: 0,
  nested: 0,
  bracket: 0,
  leadingBracket: 0,
  backslash: 0,
  nonAscii: 0,
  percent: 0,
  pdf: 0,
  image: 0,
};

describe("upload markdown", () => {
  test("reads back as one link or image with the exact href, whatever the name", () => {
    fc.assert(
      fc.property(uploadTextArb, ({ name, mime, href, text }) => {
        const link = scanMarkdownLinkAt(text, 0);
        expect(link).not.toBeNull();
        expect(link!.end).toBe(text.length);
        expect(text.slice(link!.destination.start, link!.destination.end)).toBe(href);
        const label = text.slice(link!.label.start, link!.label.end);
        expect(label).toBe(assetLabel(name));

        const image = mime.startsWith("image/");
        expect(link!.kind).toBe(image ? "image" : "link");
        // inside prose, closed by a paren that belongs to the prose
        const segments = tokenizeBlock(`(see ${text})`);
        expect(segments.map((s) => s.kind)).toEqual(["text", image ? "image" : "link", "text"]);
        const seg = segments[1];
        const read = seg.kind === "image" ? seg.src : seg.kind === "link" ? seg.href : null;
        expect(read).toBe(href);
        expect(isPdfHref(href)).toBe(name.toLowerCase().endsWith(".pdf"));

        tally.total += 1;
        if (name.includes(" ")) tally.space += 1;
        if (/[()]/.test(name)) tally.paren += 1;
        if (/\(.*\(|\).*\)/.test(name)) tally.nested += 1;
        if (/[[\]]/.test(name)) tally.bracket += 1;
        if (name.startsWith("[")) tally.leadingBracket += 1;
        if (name.includes("\\")) tally.backslash += 1;
        if (/[^\x00-\x7f]/.test(name)) tally.nonAscii += 1;
        if (name.includes("%")) tally.percent += 1;
        if (name.toLowerCase().endsWith(".pdf")) tally.pdf += 1;
        if (image) tally.image += 1;
      }),
      { numRuns: 1500 },
    );
    const floor = (n: number, share: number) => expect(n).toBeGreaterThan(tally.total * share);
    floor(tally.space, 0.1);
    floor(tally.paren, 0.15);
    floor(tally.nested, 0.03);
    floor(tally.bracket, 0.15);
    floor(tally.leadingBracket, 0.03);
    floor(tally.backslash, 0.03);
    floor(tally.nonAscii, 0.15);
    floor(tally.percent, 0.05);
    floor(tally.pdf, 0.1);
    floor(tally.image, 0.2);
  });

  test("a bare URL is one asset link whose name decodes to the file name", () => {
    fc.assert(
      fc.property(uploadNameArb, shaArb, (raw, sha) => {
        // the route never stores a name ending in a dot or space
        const name = raw.replace(/[. ]+$/, "") || "file";
        const href = assetHref(sha, name);
        const segments = tokenizeBlock(`see ${href}, ok`);
        expect(segments.map((s) => s.kind)).toEqual(["text", "asset-link", "text"]);
        const seg = segments[1];
        if (seg.kind !== "asset-link") throw new Error("not an asset link");
        expect(seg.url).toBe(href);
        expect(assetNameFromSegment(seg.filename)).toBe(name);
      }),
      { numRuns: 500 },
    );
  });

  test("links written with a raw legacy name still read back", () => {
    fc.assert(
      fc.property(legacyNameArb, shaArb, fc.boolean(), (name, sha, image) => {
        const href = `/assets/${sha}/${name}`;
        const text = `${image ? "!" : ""}[${name}](${href})`;
        const link = scanMarkdownLinkAt(text, 0);
        expect(link).not.toBeNull();
        expect(link!.end).toBe(text.length);
        expect(text.slice(link!.destination.start, link!.destination.end)).toBe(href);
        expect(isPdfHref(href)).toBe(name.toLowerCase().endsWith(".pdf"));
      }),
      { numRuns: 500 },
    );
  });
});

describe("assetNameFromSegment", () => {
  test("falls back to the raw text for a stray percent", () => {
    expect(assetNameFromSegment("100%.pdf")).toBe("100%.pdf");
    expect(assetNameFromSegment("a%20b%5B1%5D.pdf")).toBe("a b[1].pdf");
  });
});
