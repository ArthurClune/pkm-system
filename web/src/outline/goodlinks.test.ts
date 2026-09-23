import { describe, expect, test } from "vitest";
import { block } from "../test-helpers";
import { goodlinksAttribute, goodlinksCandidates, goodlinksNotice } from "./goodlinks";

const ID = "e4966bb2483b5c78f658398c0ae7b03f";

describe("goodlinksCandidates", () => {
  const tree = [
    block("root", "Intro https://root.example/one", { order_idx: 0, children: [
      block("prev", "[A](https://prev.example/a) and https://prev.example/b.", { order_idx: 0 }),
      block("me", "", { order_idx: 1 }),
    ] }),
  ];

  test("own text first, then parent, then previous sibling, deduplicated", () => {
    const withOwn = [
      block("root", "https://root.example/one", { order_idx: 0, children: [
        block("prev", "https://prev.example/a", { order_idx: 0 }),
        block("me", "see https://me.example/x and https://root.example/one", { order_idx: 1 }),
      ] }),
    ];
    expect(goodlinksCandidates(withOwn, "me")).toEqual([
      "https://me.example/x", "https://root.example/one", "https://prev.example/a"]);
  });

  test("empty child block takes the parent URL before the sibling's", () => {
    expect(goodlinksCandidates(tree, "me")).toEqual([
      "https://root.example/one", "https://prev.example/a", "https://prev.example/b"]);
  });

  test("trailing punctuation and markdown closers are trimmed", () => {
    const t = [block("b", "(https://x.example/p). [y](https://y.example/q)", { order_idx: 0 })];
    expect(goodlinksCandidates(t, "b")).toEqual(["https://x.example/p", "https://y.example/q"]);
  });

  test("site-relative and non-http links are ignored; unknown uid is empty", () => {
    // its own tree: a later top-level block would see "root" as its
    // previous sibling and pick up root's URL
    const solo = [block("solo", "Local copy:: [x](/api/local/a.pdf) ftp://files.example/f",
                        { order_idx: 0 })];
    expect(goodlinksCandidates(solo, "solo")).toEqual([]);
    expect(goodlinksCandidates(tree, "nope")).toEqual([]);
  });
});

test("goodlinksAttribute builds the canonical block form", () => {
  expect(goodlinksAttribute(ID)).toBe(`Local copy:: [Goodlinks](/api/goodlinks/${ID})`);
});

test.each([
  [503, "Goodlinks is not running"],
  [422, "Goodlinks refused the URL"],
  [404, "Not in Goodlinks"],
  [0, "Couldn't reach the server"],
  [500, "Couldn't reach Goodlinks"],
])("goodlinksNotice(%s)", (status, text) => {
  expect(goodlinksNotice(status)).toBe(text);
});
