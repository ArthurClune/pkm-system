import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { goodlinksIdFromHref } from "./goodlinks";

const PREFIX = "/api/goodlinks/";

const idArb = fc.stringMatching(/^[0-9a-f]{32}$/);

// Valid hrefs and the ways a href can be nearly right.
const hrefArb = fc.oneof(
  { weight: 2, arbitrary: idArb.map((id) => ({ kind: "valid", href: PREFIX + id })) },
  {
    weight: 4,
    arbitrary: idArb.chain((id) =>
    fc.constantFrom(
      ["upper", PREFIX + id.toUpperCase()],
      ["short", PREFIX + id.slice(1)],
      ["long", PREFIX + id + "0"],
      ["slash", `${PREFIX}${id}/`],
      ["query", `${PREFIX}${id}?x=1`],
      ["hash", `${PREFIX}${id}#x`],
      ["newline", `${PREFIX}${id}\n`],
      ["suffix", `${PREFIX}${id}.pdf`],
      ["prefix", `https://example.com${PREFIX}${id}`],
      ["leading", ` ${PREFIX}${id}`],
      ["nonhex", PREFIX + id.slice(0, 31) + "g"],
      ["wrongroot", `/api/local/${id}`],
      ["double", `${PREFIX}${id}${id}`],
    ).map(([kind, href]) => ({ kind, href })),
    ),
  },
  fc.string({ maxLength: 50 }).map((href) => ({ kind: "noise", href })),
);

describe("goodlinksIdFromHref", () => {
  test("accepts exactly the prefix plus 32 lowercase hex digits", () => {
    const tally = new Map<string, number>();
    fc.assert(
      fc.property(hrefArb, ({ kind, href }) => {
        tally.set(kind, (tally.get(kind) ?? 0) + 1);
        const id = goodlinksIdFromHref(href);
        const accepted =
          href.length === PREFIX.length + 32 &&
          href.startsWith(PREFIX) &&
          [...href.slice(PREFIX.length)].every((c) => "0123456789abcdef".includes(c));
        expect(id === null).toBe(!accepted);
        if (id !== null) expect(PREFIX + id).toBe(href);
      }),
      { numRuns: 800 },
    );
    expect(tally.get("valid")).toBeGreaterThan(60);
    for (const kind of ["upper", "short", "long", "slash", "query", "newline", "nonhex"]) {
      expect(tally.get(kind), kind).toBeGreaterThan(5);
    }
  });
});
