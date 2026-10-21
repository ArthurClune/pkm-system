import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { extractRefs } from "./refs";
import { tokenizeBlock, type BlockSegment } from "./tokenize";

describe("a ref that names no page renders as its source text", () => {
  it.each([
    ["#work/"], ["(#.)"], ["#.."], ["[[Paper/]]"], ["[[   ]]"], ["[[a/../b]]"],
    ["#[[x//y]]"],
  ])("%s", (source) => {
    const segments = tokenizeBlock(`see ${source} end`);
    expect(segments.map((s) => s.kind)).toEqual(["text"]);
    expect(segments).toEqual([{ kind: "text", text: `see ${source} end` }]);
    expect(extractRefs(`see ${source} end`).refs).toEqual([]);
  });

  it("an attribute with an unreachable name stays text", () => {
    expect(tokenizeBlock("a/::")).toEqual([{ kind: "text", text: "a/::" }]);
    expect(extractRefs("a/::").refs).toEqual([]);
  });

  it("a reachable ref still renders as a link", () => {
    expect(tokenizeBlock("[[Paper/x]] #a.b")).toEqual([
      { kind: "page-ref", title: "Paper/x", tag: false },
      { kind: "text", text: " " },
      { kind: "page-ref", title: "a.b", tag: true },
    ]);
  });
});

const FRAGMENTS = [
  "[[Paper]]", "[[Paper/]]", "[[a/b]]", "[[/a]]", "[[.]]", "[[..]]", "[[a/./b]]",
  "[[   ]]", "[[ a ]]", "[[]]", "#tag", "#work/", "#.", "#..", "#a/b", "#a.b",
  "#[[x y]]", "#[[x//y]]", "#[[ ]]", "word", " ", "\n", "(", ")", "text ",
  "[[a\nb]]", "[[a\n/b]]",
];

const DEAD = /\[\[(Paper\/|\/a|\.|\.\.|a\/\.\/b| *)\]\]|#(work\/|\.\.?)(\s|$)/;

function linkKeys(segments: BlockSegment[]): Set<string> {
  const out = new Set<string>();
  const walk = (seg: BlockSegment) => {
    if (seg.kind === "page-ref") out.add(`${seg.tag ? "tag" : "link"}\0${seg.title}`);
    else if (seg.kind === "attribute") out.add(`attribute\0${seg.name}`);
    else if ("children" in seg) seg.children.forEach(walk);
  };
  segments.forEach(walk);
  return out;
}

describe("render and extract agree", () => {
  it("a token renders as a link if and only if extractRefs yields a ref", () => {
    const seen = { dead: 0, live: 0 };
    fc.assert(fc.property(
      fc.array(fc.constantFrom(...FRAGMENTS), { minLength: 1, maxLength: 6 }),
      (parts) => {
        const text = parts.join(" ");
        const refs = new Set(extractRefs(text).refs.map((r) => `${r.kind}\0${r.title}`));
        const links = linkKeys(tokenizeBlock(text));
        expect(links).toEqual(refs);
        if (refs.size > 0) seen.live += 1;
        if (DEAD.test(text)) seen.dead += 1;
      },
    ), { numRuns: 300 });
    // The dead forms must actually be drawn, or the property is vacuous.
    expect(seen.dead).toBeGreaterThan(50);
    expect(seen.live).toBeGreaterThan(50);
  });
});
