// The web half of the local-link parity fixture: `Local copy::` texts built by
// localCopyAttribute from hostile file names, each with the /api/local/ hrefs
// the web's markdown-link reader finds. server/tests/test_local_links_parity.py
// holds extract_local_hrefs to the same hrefs. Regenerate the file after a
// deliberate change with UPDATE_LOCAL_LINKS_FIXTURE=1; the sample is
// deterministic (fixed seed), so any diff means the generator or the product
// code moved.
import fc from "fast-check";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { scanMarkdownLinks } from "../grammar/markdown";
import { localCopyAttribute } from "./localFiles";
import { hostileName, localHref } from "./localLinkArbs";

const FIXTURE = join(__dirname, "../../../shared/fixtures/local_links_parity.json");

const attributeArb = fc
  .tuple(fc.array(hostileName, { maxLength: 2 }), hostileName)
  .map(([dirs, name]) => {
    const path = [...dirs, name].join("/");
    return localCopyAttribute({ path, href: localHref(path) });
  });

// One attribute per case, plus a few blocks with two, sometimes the same.
const textArb = fc.oneof(
  { weight: 4, arbitrary: attributeArb },
  fc
    .tuple(attributeArb, fc.option(attributeArb, { nil: null }))
    .map(([a, b]) => `${a}\n${b ?? a}`),
);

function webHrefs(text: string): string[] {
  const hrefs: string[] = [];
  for (const link of scanMarkdownLinks(text)) {
    const href = text.slice(link.destination.start, link.destination.end);
    if (link.kind === "link" && href.startsWith("/api/local/") && !hrefs.includes(href)) {
      hrefs.push(href);
    }
  }
  return hrefs;
}

function generate() {
  const cases = fc
    .sample(textArb, { seed: 20260421, numRuns: 80 })
    .map((text) => ({ text, hrefs: webHrefs(text) }));
  return `${JSON.stringify({ cases }, null, 2)}\n`;
}

test("shared/fixtures/local_links_parity.json is current", () => {
  const expected = generate();
  if (process.env.UPDATE_LOCAL_LINKS_FIXTURE === "1") writeFileSync(FIXTURE, expected);
  expect(
    readFileSync(FIXTURE, "utf8") === expected,
    "stale fixture: run with UPDATE_LOCAL_LINKS_FIXTURE=1 to rewrite it",
  ).toBe(true);
  const { cases } = JSON.parse(expected) as { cases: { hrefs: string[] }[] };
  expect(cases.every((c) => c.hrefs.length > 0)).toBe(true);
});
