import { describe, expect, test } from "vitest";
import { block } from "../test-helpers";
import { isTocMacro, tocEntries } from "./tocEntries";

describe("isTocMacro", () => {
  test("accepts both macro spellings, any case, with surrounding space", () => {
    expect(isTocMacro("{{toc}}")).toBe(true);
    expect(isTocMacro("{{[[toc]]}}")).toBe(true);
    expect(isTocMacro("  {{TOC}}  ")).toBe(true);
    expect(isTocMacro("{{[[TOC]]}}")).toBe(true);
  });

  test("rejects a macro that is only part of the block", () => {
    expect(isTocMacro("before {{toc}}")).toBe(false);
    expect(isTocMacro("{{toc}} after")).toBe(false);
    expect(isTocMacro("{{table}}")).toBe(false);
    expect(isTocMacro("")).toBe(false);
  });
});

describe("tocEntries", () => {
  test("is empty when the page has no headings", () => {
    expect(tocEntries([
      block("a", "plain", { children: [block("b", "also plain")] }),
    ], "self")).toEqual([]);
  });

  test("lists headings in document order, children after their parent", () => {
    const entries = tocEntries([
      block("h1", "Intro", { heading: 1 }),
      block("h2", "Setup", {
        heading: 1,
        children: [block("h3", "Install", { heading: 2 })],
      }),
      block("h4", "Outro", { heading: 1 }),
    ], "self");
    expect(entries.map((e) => e.text)).toEqual(["Intro", "Setup", "Outro"]);
    expect(entries[1].children.map((e) => e.text)).toEqual(["Install"]);
    expect(entries[1].children[0]).toMatchObject({ uid: "h3", level: 2 });
  });

  test("nests by nearest heading ancestor, not by heading level", () => {
    // An h3 buried under a plain block under an h1 still belongs to the h1.
    const entries = tocEntries([
      block("one", "One", {
        heading: 1,
        children: [
          block("plain", "notes", {
            children: [block("deep", "Deep", { heading: 3 })],
          }),
        ],
      }),
    ], "self");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ uid: "one", level: 1 });
    expect(entries[0].children).toHaveLength(1);
    expect(entries[0].children[0]).toMatchObject({ uid: "deep", level: 3 });
    expect(entries[0].children[0].children).toEqual([]);
  });

  test("a heading with only plain ancestors is top level", () => {
    const entries = tocEntries([
      block("plain", "notes", {
        children: [block("h", "Buried", { heading: 2 })],
      }),
    ], "self");
    expect(entries.map((e) => e.uid)).toEqual(["h"]);
    expect(entries[0].level).toBe(2);
  });

  test("skips the toc block itself but still lists its heading children", () => {
    const entries = tocEntries([
      block("toc", "{{toc}}", {
        heading: 1,
        children: [block("kid", "Child heading", { heading: 2 })],
      }),
    ], "toc");
    expect(entries.map((e) => e.uid)).toEqual(["kid"]);
    expect(entries[0].children).toEqual([]);
  });

  test("lists headings inside collapsed subtrees", () => {
    const entries = tocEntries([
      block("one", "One", {
        heading: 1, collapsed: true,
        children: [block("two", "Two", { heading: 2 })],
      }),
    ], "self");
    expect(entries[0].children.map((e) => e.uid)).toEqual(["two"]);
  });

  test("carries the raw block text, unrendered", () => {
    const entries = tocEntries(
      [block("h", "See [[Other Page]]", { heading: 1 })], "self");
    expect(entries[0].text).toBe("See [[Other Page]]");
  });
});
