import { describe, expect, test } from "vitest";
import { block, uidOf } from "../test-helpers";
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

describe("tocEntries heading text", () => {
  test("shows a page-ref heading as its title, not the bracketed source", () => {
    const entries = tocEntries([
      block("tuid-h", "[[Mathematics]]", { heading: 2 }),
    ], uidOf("tuid-self"));
    expect(entries.map((e) => e.text)).toEqual(["Mathematics"]);
  });

  test("strips refs inside a longer heading and keeps a hashtag's hash", () => {
    const entries = tocEntries([
      block("tuid-h", "Notes on [[AI in Research]] and #[[deep learning]] **today**",
            { heading: 1 }),
    ], uidOf("tuid-self"));
    expect(entries[0].text)
      .toBe("Notes on AI in Research and #deep learning today");
  });
});

describe("tocEntries", () => {
  test("is empty when the page has no headings", () => {
    expect(tocEntries([
      block("tuid-a", "plain", { children: [block("tuid-b", "also plain")] }),
    ], uidOf("tuid-self"))).toEqual([]);
  });

  test("lists headings in document order, children after their parent", () => {
    const entries = tocEntries([
      block("tuid-h1", "Intro", { heading: 1 }),
      block("tuid-h2", "Setup", {
        heading: 1,
        children: [block("tuid-h3", "Install", { heading: 2 })],
      }),
      block("tuid-h4", "Outro", { heading: 1 }),
    ], uidOf("tuid-self"));
    expect(entries.map((e) => e.text)).toEqual(["Intro", "Setup", "Outro"]);
    expect(entries[1].children.map((e) => e.text)).toEqual(["Install"]);
    expect(entries[1].children[0]).toMatchObject({ uid: "tuid-h3", level: 2 });
  });

  test("nests by nearest heading ancestor, not by heading level", () => {
    // An h3 buried under a plain block under an h1 still belongs to the h1.
    const entries = tocEntries([
      block("tuid-one", "One", {
        heading: 1,
        children: [
          block("tuid-plain", "notes", {
            children: [block("tuid-deep", "Deep", { heading: 3 })],
          }),
        ],
      }),
    ], uidOf("tuid-self"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ uid: "tuid-one", level: 1 });
    expect(entries[0].children).toHaveLength(1);
    expect(entries[0].children[0]).toMatchObject({ uid: "tuid-deep", level: 3 });
    expect(entries[0].children[0].children).toEqual([]);
  });

  test("a heading with only plain ancestors is top level", () => {
    const entries = tocEntries([
      block("tuid-plain", "notes", {
        children: [block("tuid-h", "Buried", { heading: 2 })],
      }),
    ], uidOf("tuid-self"));
    expect(entries.map((e) => e.uid)).toEqual(["tuid-h"]);
    expect(entries[0].level).toBe(2);
  });

  test("skips the toc block itself but still lists its heading children", () => {
    const entries = tocEntries([
      block("tuid-toc", "{{toc}}", {
        heading: 1,
        children: [block("tuid-kid", "Child heading", { heading: 2 })],
      }),
    ], uidOf("tuid-toc"));
    expect(entries.map((e) => e.uid)).toEqual(["tuid-kid"]);
    expect(entries[0].children).toEqual([]);
  });

  test("lists headings inside collapsed subtrees", () => {
    const entries = tocEntries([
      block("tuid-one", "One", {
        heading: 1, collapsed: true,
        children: [block("tuid-two", "Two", { heading: 2 })],
      }),
    ], uidOf("tuid-self"));
    expect(entries[0].children.map((e) => e.uid)).toEqual(["tuid-two"]);
  });
});
