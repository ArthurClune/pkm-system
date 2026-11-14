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
  it("groups text by block row", () => {
    const r = root(
      `<div class="block-row">foo <strong>bar</strong></div>` +
        `<div class="block-row">baz</div>`);
    expect(collectPageText([r]).groups).toEqual([["foo ", "bar"], ["baz"]]);
  });

  it("groups text outside a block row by its parent element", () => {
    const r = root(`<h1>Title</h1><p>Body</p>`);
    expect(collectPageText([r]).groups).toEqual([["Title"], ["Body"]]);
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
    const r = root(`<div class="block-row">foo ba<b>r</b></div>`);
    const text = collectPageText([r]);
    const [m] = findMatches(text.groups, "bar");
    expect(matchRange(text, m).toString()).toBe("bar");
  });
});
