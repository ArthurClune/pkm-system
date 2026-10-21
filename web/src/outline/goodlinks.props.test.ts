import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { goodlinksIdFromHref } from "../components/goodlinks";
import { scanMarkdownLinkAt } from "../grammar/markdown";
import { tokenizeBlock } from "../grammar/tokenize";
import { block, orderIdxOf, uidOf } from "../test-helpers";
import { goodlinksAttribute, goodlinksCandidates } from "./goodlinks";

// The URL body: no whitespace or <>()[], optionally holding one balanced
// (...) group such as a Wikipedia title. The last character is never
// punctuation the extractor strips, so the expected URL is unambiguous.
const urlArb = fc
  .tuple(
    fc.constantFrom("http", "https"),
    fc.stringMatching(/^[a-z0-9.-]{1,10}$/),
    fc.array(
      fc.oneof(
        fc.stringMatching(/^[a-zA-Z0-9/_%~=&#@+.,;:!?-]{1,6}$/),
        fc.constant("(x)"),
        fc.constant("(a.b)"),
      ),
      { maxLength: 4 },
    ),
    fc.constantFrom("a", "Z", "9", "/", "_", "(x)"),
  )
  .map(([scheme, host, parts, last]) => ({
    url: `${scheme}://${host}${parts.join("")}${last}`,
  }))
  .map(({ url }) => url);

const PUNCT = [".", ",", ";", ":", "!", "?", "..", "?!", ".,;:!?"];

// Prose around a URL: it never says "http" itself, may open with a bracket
// and closes with a space, a closing bracket or the end of the text.
const proseArb = fc.stringMatching(/^[a-z ]{0,12}$/).filter((s) => !s.includes("http"));
const openers = ["", "", "(", "[", "<", "see "] as const;
const closers = ["", "", ")", "]", ">", " tail", "\n", " "] as const;

const embeddedArb = fc
  .tuple(
    proseArb,
    fc.constantFrom(...openers),
    urlArb,
    fc.constantFrom("", ...PUNCT),
    fc.constantFrom(...closers),
    proseArb,
  )
  .map(([before, open, url, punct, close, after]) => ({
    url,
    punct,
    text: `${before}${before ? " " : ""}${open}${url}${punct}${close}${after ? " " : ""}${after}`,
  }));

describe("goodlinksCandidates", () => {
  test("extracts the URL with trailing punctuation stripped, in block order", () => {
    const tally = { punct: 0, balanced: 0, closer: 0, many: 0 };
    fc.assert(
      fc.property(
        fc.array(fc.option(embeddedArb, { nil: null }), { minLength: 3, maxLength: 3 }),
        (slots) => {
          const [own, parent, prev] = slots;
          const tree = [
            block("tuid-root", parent?.text ?? "", {
              order_idx: orderIdxOf(0),
              children: [
                block("tuid-prev", prev?.text ?? "", { order_idx: orderIdxOf(0) }),
                block("tuid-me", own?.text ?? "", { order_idx: orderIdxOf(1) }),
              ],
            }),
          ];
          const expected: string[] = [];
          for (const slot of [own, parent, prev]) {
            if (slot && !expected.includes(slot.url)) expected.push(slot.url);
          }
          expect(goodlinksCandidates(tree, uidOf("tuid-me"))).toEqual(expected);

          if (own && own.punct !== "") tally.punct += 1;
          if (own?.url.includes("(")) tally.balanced += 1;
          if (own && /[)\]>]/.test(own.text.slice(own.text.indexOf(own.url) + own.url.length))) {
            tally.closer += 1;
          }
          if (expected.length > 1) tally.many += 1;
        },
      ),
      { numRuns: 400 },
    );
    expect(tally.punct).toBeGreaterThan(60);
    expect(tally.balanced).toBeGreaterThan(30);
    expect(tally.closer).toBeGreaterThan(30);
    expect(tally.many).toBeGreaterThan(60);
  });
});

describe("goodlinksAttribute", () => {
  test("reads back through the link reader to the same id", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9a-f]{32}$/), (id) => {
        const text = goodlinksAttribute(id);
        const at = text.indexOf("[");
        const link = scanMarkdownLinkAt(text, at);
        expect(link?.end).toBe(text.length);
        const href = text.slice(link!.destination.start, link!.destination.end);
        expect(goodlinksIdFromHref(href)).toBe(id);
        const segments = tokenizeBlock(text);
        expect(segments.map((s) => s.kind)).toEqual(["attribute", "text", "link"]);
        expect(segments[2]).toMatchObject({ text: "Goodlinks", href });
      }),
    );
  });
});
