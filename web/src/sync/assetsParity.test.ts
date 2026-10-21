// The web half of the upload-link parity fixture: block texts that mix
// tokens for one asset (link, image, pdf macro, bare URL), as the upload
// path writes them with the server's encoded URLs or as old uploads wrote
// them with the raw name, and tokens for another asset. Each case carries
// the text left once the first asset's tokens are gone, each taking one
// adjacent space with it.
// server/tests/test_upload_links_parity.py holds strip_asset_tokens to it.
// Regenerate the file after a deliberate change with
// UPDATE_UPLOAD_LINKS_FIXTURE=1; the sample is deterministic (fixed seed), so
// any diff means the generator or the product code moved.
import fc from "fast-check";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Sha256Hex } from "../api/brands";
import { scanMarkdownLinks } from "../grammar/markdown";
import { tokenizeBlock } from "../grammar/tokenize";
import { shaOf } from "../test-helpers";
import { assetHref, KINDS, legacyNameArb, shaArb, uploadNameArb } from "./assetUploadArbs";
import { assetMarkdown } from "./assets";

const FIXTURE = join(__dirname, "../../../shared/fixtures/upload_links_parity.json");

type TokenKind = "markdown" | "macro" | "bare";

function tokenText(
  kind: TokenKind,
  name: string,
  mime: string,
  sha: Sha256Hex,
  legacy: boolean,
): string {
  const href = legacy ? `/assets/${sha}/${name}` : assetHref(sha, name);
  if (kind === "macro") return `{{[[pdf]]: ${href}}}`;
  if (kind === "bare") return href;
  if (!legacy) return assetMarkdown({ filename: name, mime, url: href });
  return `${mime.startsWith("image/") ? "!" : ""}[${name}](${href})`;
}

// The text with each span gone and one adjacent space with it (the one
// before, else the one after, never one another span took); whitespace-only
// text becomes empty. Twin of the server's strip_asset_tokens rule.
function removeSpans(text: string, spans: [number, number][]): string {
  if (spans.length === 0) return text;
  const taken = new Set<number>();
  for (const [start, end] of spans) {
    for (let i = start; i < end; i += 1) taken.add(i);
    if (start > 0 && text[start - 1] === " " && !taken.has(start - 1)) taken.add(start - 1);
    else if (end < text.length && text[end] === " ") taken.add(end);
  }
  let rest = "";
  for (let i = 0; i < text.length; i += 1) if (!taken.has(i)) rest += text[i];
  return rest.trim() === "" ? "" : rest;
}

const tokenArb = (legacy: boolean) =>
  fc
    .tuple(
      legacy ? legacyNameArb : uploadNameArb,
      fc.constantFrom(...KINDS),
      fc.constantFrom<TokenKind>("markdown", "markdown", "macro", "bare"),
    )
    .map(([base, kind, form]) => ({ name: base, mime: kind.mime, form }));

const caseArb = fc
  .tuple(
    shaArb,
    shaArb,
    fc.boolean(),
    fc.array(
      fc.oneof(
        { weight: 2, arbitrary: fc.stringMatching(/^[a-z]{1,5}$/).map((s) => ({ prose: s })) },
        { weight: 3, arbitrary: fc.boolean().map(() => ({ own: true })) },
        { weight: 1, arbitrary: fc.boolean().map(() => ({ own: false })) },
      ),
      { minLength: 1, maxLength: 4 },
    ),
    fc.array(fc.constantFrom(" ", "  ", "\n"), { minLength: 4, maxLength: 4 }),
    fc.array(tokenArb(false), { minLength: 4, maxLength: 4 }),
    fc.array(tokenArb(true), { minLength: 4, maxLength: 4 }),
  )
  .map(([sha, otherRaw, legacy, pieces, seps, fresh, old]) => {
    const other = otherRaw === sha ? shaOf(`${otherRaw.slice(1)}0`) : otherRaw;
    const toks = legacy ? old : fresh;
    let text = "";
    const spans: [number, number][] = [];
    pieces.forEach((piece, i) => {
      const sep = i < pieces.length - 1 ? seps[i] : "";
      const t = toks[i];
      if ("prose" in piece) {
        text += piece.prose + sep;
        return;
      }
      const own = piece.own;
      // an other-asset token is never a macro (the stripper's own syntax)
      // and an old raw name with a space or paren cannot be a bare URL
      const form: TokenKind =
        (own ? t.form === "bare" && legacy : t.form === "macro" || legacy && t.form === "bare")
          ? "markdown"
          : t.form;
      const s = tokenText(form, t.name, t.mime, own ? sha : other, legacy);
      if (own) spans.push([text.length, text.length + s.length]);
      text += s + sep;
    });
    const remainder = removeSpans(text, spans);
    return { sha, legacy, text, remainder };
  });

// Hrefs the web's own readers find for the asset: markdown links and
// images through the link scanner, bare URLs through the tokenizer.
function webHrefs(text: string, sha: Sha256Hex): string[] {
  const prefix = `/assets/${sha}/`;
  const hrefs: string[] = [];
  for (const link of scanMarkdownLinks(text)) {
    const href = text.slice(link.destination.start, link.destination.end);
    if (href.startsWith(prefix)) hrefs.push(href);
  }
  for (const seg of tokenizeBlock(text)) {
    if (seg.kind === "asset-link" && seg.sha === sha) hrefs.push(seg.url);
  }
  return hrefs;
}

function generate() {
  const cases = fc
    .sample(caseArb, { seed: 20261021, numRuns: 120 })
    .map((c) => ({ ...c, hrefs: webHrefs(c.text, c.sha).length }));
  return `${JSON.stringify({ cases }, null, 2)}\n`;
}

test("shared/fixtures/upload_links_parity.json is current", () => {
  const expected = generate();
  if (process.env.UPDATE_UPLOAD_LINKS_FIXTURE === "1") writeFileSync(FIXTURE, expected);
  expect(
    readFileSync(FIXTURE, "utf8") === expected,
    "stale fixture: run with UPDATE_UPLOAD_LINKS_FIXTURE=1 to rewrite it",
  ).toBe(true);
  const { cases } = JSON.parse(expected) as {
    cases: { legacy: boolean; text: string; remainder: string; hrefs: number }[];
  };
  // the sample reaches both spellings, texts with tokens to strip, and
  // texts whose remainder holds another asset's token
  expect(cases.filter((c) => c.legacy).length).toBeGreaterThan(30);
  expect(cases.filter((c) => !c.legacy).length).toBeGreaterThan(30);
  expect(cases.filter((c) => c.hrefs > 0).length).toBeGreaterThan(60);
  expect(cases.filter((c) => c.text !== c.remainder).length).toBeGreaterThan(80);
  expect(cases.filter((c) => c.remainder.includes("/assets/")).length).toBeGreaterThan(30);
});
