import { expect, it } from "vitest";
import { parseSnippet } from "./snippet";

it("splits FTS snippets into marked and unmarked runs", () => {
  expect(parseSnippet("…uses <mark>datascript</mark> under the hood…")).toEqual([
    { text: "…uses ", mark: false },
    { text: "datascript", mark: true },
    { text: " under the hood…", mark: false },
  ]);
});

it("handles multiple marks and mark-first snippets", () => {
  expect(parseSnippet("<mark>a</mark> b <mark>c</mark>")).toEqual([
    { text: "a", mark: true },
    { text: " b ", mark: false },
    { text: "c", mark: true },
  ]);
});

it("never interprets other tags — text stays literal", () => {
  expect(parseSnippet("x <b>bold</b> y")).toEqual([
    { text: "x <b>bold</b> y", mark: false },
  ]);
});

it("tolerates an unclosed mark", () => {
  expect(parseSnippet("a <mark>b")).toEqual([
    { text: "a ", mark: false },
    { text: "b", mark: false },
  ]);
});
