import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { type LocalFile } from "./localFiles";
import { hostileNameNoNewline, localHref } from "./localLinkArbs";
import { searchLocalFiles } from "./localSearch";

const toFile = (path: string): LocalFile => ({ path, href: localHref(path) });

const fileArb = fc
  .tuple(
    fc.array(hostileNameNoNewline, { maxLength: 2 }),
    hostileNameNoNewline,
    fc.constantFrom("nfc", "nfd"),
  )
  .map(([dirs, name, form]) =>
    toFile([...dirs, name].join("/").normalize(form === "nfc" ? "NFC" : "NFD")),
  );

const filesArb = fc.uniqueArray(fileArb, {
  selector: (f) => f.path.normalize("NFC"),
  minLength: 1,
  maxLength: 8,
});

// fzf's extended syntax gives ! ^ $ ' | and whitespace meaning, and a
// backslash escapes the space after it, so a word
// is a run of any other characters: a plain fuzzy term.
const OPERATORS = /[!^$'|\\\s]/;
const isLoneSurrogate = (c: string) => {
  const cp = c.codePointAt(0) ?? 0;
  return cp >= 0xd800 && cp <= 0xdfff;
};
// A query typed into the picker is well-formed text, so lone surrogates are
// dropped too.
const plain = (s: string) =>
  [...s].filter((c) => !OPERATORS.test(c) && !isLoneSurrogate(c)).join("");

// A query word is usually a slice of a real path (so matches exist),
// in a random case, and sometimes arbitrary text.
const wordFrom = (files: readonly LocalFile[]) =>
  fc.oneof(
    { weight: 4, arbitrary: sliceOf(files) },
    {
      weight: 1,
      arbitrary: fc
        .string({ minLength: 1, maxLength: 3 })
        .map((t) => plain(t) || "a"),
    },
  );

function sliceOf(files: readonly LocalFile[]): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom(...files),
      fc.nat({ max: 40 }),
      fc.integer({ min: 1, max: 4 }),
      fc.constantFrom("same", "upper", "lower"),
    )
    .map(([f, from, len, casing]) => {
      const nfc = f.path.normalize("NFC");
      const s = plain(nfc.slice(from % nfc.length, from % nfc.length + len));
      // A slice of pure operator characters falls back to a plain word
      // (a filter here could spin forever on such paths).
      const word = s || "a";
      return casing === "upper"
        ? word.replace(/[a-z]/g, (c) => c.toUpperCase())
        : casing === "lower"
          ? word.replace(/[A-Z]/g, (c) => c.toLowerCase())
          : word;
    });
}

const scenario = filesArb.chain((files) =>
  fc
    .array(wordFrom(files), { minLength: 1, maxLength: 3 })
    .map((words) => ({ files, words })),
);

const lower = (s: string) => s.toLowerCase();
// fzf lowercases one code point at a time and keeps only the first code point
// of the result, so "\u0130" (which lowercases to two) is never found by
// typing itself. Containment is asserted only for words free of such code
// points; their highlights are still checked wherever they match.
const foldsCleanly = (s: string) =>
  [...s].every((c) => [...c.toLowerCase()].length === 1);
// fzf folds case and strips Latin diacritics ("U" finds "\u00FC", "s" finds
// "\u00DF"), so a
// highlight spells a word up to that folding.
const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").replaceAll("\u00DF", "s").toLowerCase();

describe("searchLocalFiles over hostile paths", () => {
  test("results, containment and highlights", () => {
    const tally = {
      runs: 0, multiWord: 0, nfd: 0, astralBefore: 0, inFolder: 0,
      inName: 0, slashWord: 0, caseFold: 0, hits: 0,
    };
    fc.assert(
      fc.property(scenario, ({ files, words }) => {
        tally.runs += 1;
        if (words.length > 1) tally.multiWord += 1;
        if (files.some((f) => f.path !== f.path.normalize("NFC"))) tally.nfd += 1;
        if (words.some((w) => w.includes("/"))) tally.slashWord += 1;
        if (words.some((w) => lower(w).length !== w.length)) tally.caseFold += 1;

        const results = searchLocalFiles(files, words.join(" "));
        const inputs = new Set(files);
        for (const r of results) expect(inputs.has(r.file)).toBe(true);
        expect(new Set(results.map((r) => r.file)).size).toBe(results.length);

        const found = new Set(results.map((r) => r.file));
        for (const f of files) {
          const hay = f.path.normalize("NFC");
          if (
            foldsCleanly(hay) &&
            words.every((w) => foldsCleanly(w) && lower(hay).includes(lower(w)))
          ) {
            expect(found.has(f), `${JSON.stringify(f.path)} missing`).toBe(true);
          }
        }

        for (const r of results) {
          tally.hits += 1;
          const nfc = r.file.path.normalize("NFC");
          const slash = nfc.lastIndexOf("/");
          const name = nfc.slice(slash + 1);
          const folder = slash < 0 ? "" : nfc.slice(0, slash);
          const astral = (t: string) => t.search(/[\u{10000}-\u{10FFFF}]/u);
          const firstIn = (t: string, rs: [number, number][]) =>
            astral(t) >= 0 && rs.length > 0 && rs[rs.length - 1][1] > astral(t);
          if (firstIn(name, r.nameRanges) || firstIn(folder, r.folderRanges)) {
            tally.astralBefore += 1;
          }
          if (r.folderRanges.length > 0) tally.inFolder += 1;
          if (r.nameRanges.length > 0) tally.inName += 1;

          const spoken = (text: string, ranges: [number, number][]) => {
            let at = -1;
            let out = "";
            for (const [s, e] of ranges) {
              expect(s).toBeGreaterThanOrEqual(0);
              expect(e).toBeGreaterThan(s);
              expect(e).toBeLessThanOrEqual(text.length);
              expect(s).toBeGreaterThan(at);
              at = e;
              out += text.slice(s, e);
            }
            return out;
          };
          const highlight = fold(
            spoken(folder, r.folderRanges) + spoken(name, r.nameRanges),
          );
          if (words.length === 1) {
            // One fuzzy term highlights exactly its own characters.
            expect(highlight.replaceAll("/", "")).toBe(
              fold(words[0]).replaceAll("/", ""),
            );
          }
          for (const w of words) {
            let i = 0;
            // The folder separator is drawn as " › ", never highlighted.
            for (const c of fold(w).replaceAll("/", "")) {
              const next = highlight.indexOf(c, i);
              expect(next, `${JSON.stringify(w)} not spelled by ${JSON.stringify(highlight)}`)
                .toBeGreaterThanOrEqual(0);
              i = next + c.length;
            }
          }
        }
      }),
      { numRuns: 400 },
    );
    expect(tally.multiWord).toBeGreaterThan(tally.runs * 0.3);
    expect(tally.nfd).toBeGreaterThan(tally.runs * 0.3);
    expect(tally.astralBefore).toBeGreaterThan(15);
    expect(tally.inFolder).toBeGreaterThan(20);
    expect(tally.inName).toBeGreaterThan(20);
    expect(tally.slashWord).toBeGreaterThan(5);
    expect(tally.caseFold).toBeGreaterThan(1);
    expect(tally.hits).toBeGreaterThan(tally.runs * 0.4);
  });
});
