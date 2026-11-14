import { afterEach, describe, expect, it } from "vitest";
import { collectPageText, matchRange } from "./pageText";
import { findMatches } from "./findMatches";

function root(html: string): Element {
  document.body.innerHTML = `<div id="r">${html}</div>`;
  return document.getElementById("r")!;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("collectPageText", () => {
  it("groups text by block text, leaving the row's chrome apart", () => {
    const r = root(
      `<div class="block-row"><span class="bullet">1.</span>` +
        `<div class="block-text">foo <strong>bar</strong></div>` +
        `<button class="block-ref-badge">2</button>` +
        `<span class="block-stamp">12:30</span></div>` +
        `<div class="block-row"><div class="block-text">baz</div></div>`);
    expect(collectPageText([r]).groups)
      .toEqual([["1."], ["foo ", "bar"], ["2"], ["12:30"], ["baz"]]);
  });

  it("groups a reference's text across its links", () => {
    const r = root(
      `<div class="backlink-text">met with <a class="page-link">Alice</a>` +
        ` today</div>`);
    expect(collectPageText([r]).groups)
      .toEqual([["met with ", "Alice", " today"]]);
  });

  it("groups other text by its nearest block-level element", () => {
    const r = root(
      `<h1>Title <em>here</em></h1><p>Body <a>link</a></p>` +
        `<ul><li>one <b>a</b></li><li>two</li></ul>`);
    expect(collectPageText([r]).groups).toEqual(
      [["Title ", "here"], ["Body ", "link"], ["one ", "a"], ["two"]]);
  });

  it("never groups by an element outside the root", () => {
    document.body.innerHTML =
      `<div><main id="m"><span>one</span><b>two</b></main></div>`;
    const m = document.getElementById("m")!;
    expect(collectPageText([m]).groups).toEqual([["one"], ["two"]]);
  });

  it("skips form controls, scripts and styles", () => {
    const r = root(
      `<textarea>a</textarea><input value="b"><script>c</script>` +
        `<style>d</style><noscript>e</noscript><p>keep</p>`);
    expect(collectPageText([r]).groups).toEqual([["keep"]]);
  });

  it("skips whitespace-only nodes", () => {
    const r = root(`<p>a</p>\n  <p>b</p>`);
    const { groups, nodes } = collectPageText([r]);
    expect(groups).toEqual([["a"], ["b"]]);
    expect(nodes.map((g) => g.map((n) => n.data))).toEqual(groups);
  });

  it("skips hidden elements where the browser can tell", () => {
    const r = root(`<p id="h">hidden</p><p>shown</p>`);
    const h = document.getElementById("h")!;
    expect(collectPageText([r]).groups).toEqual([["hidden"], ["shown"]]);
    Object.assign(h, { checkVisibility: () => false });
    expect(collectPageText([r]).groups).toEqual([["shown"]]);
  });

  it("walks roots in order", () => {
    document.body.innerHTML = `<div id="a"><p>one</p></div><div id="b"><p>two</p></div>`;
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    expect(collectPageText([a, b]).groups).toEqual([["one"], ["two"]]);
  });
});

describe("matchRange", () => {
  it("spans the matched nodes", () => {
    const r = root(
      `<div class="block-row"><div class="block-text">foo ba<b>r</b></div></div>`);
    const text = collectPageText([r]);
    const [m] = findMatches(text.groups, "bar");
    expect(matchRange(text, m).toString()).toBe("bar");
  });
});
