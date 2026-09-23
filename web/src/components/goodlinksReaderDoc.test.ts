import { describe, expect, test } from "vitest";
import { failureNote, formatSaved, READER_SANDBOX, readerDocument } from "./goodlinksReaderDoc";

describe("failureNote", () => {
  test.each([
    [503, "Goodlinks is not running on the Mac"],
    [404, "No longer in Goodlinks"],
    [0, "Needs the server"],
    [500, "Couldn't load this article."],
  ])("%s -> %s", (status, note) => {
    expect(failureNote(status)).toBe(note);
  });

  test.each([
    [503, "Goodlinks rejected the API token", "Goodlinks rejected the API token"],
    [503, "Goodlinks is not running on the host", "Goodlinks is not running on the Mac"],
    [404, "Goodlinks rejected the API token", "No longer in Goodlinks"],
  ])("%s with detail %s -> %s", (status, detail, note) => {
    expect(failureNote(status, detail)).toBe(note);
  });
});

test("formatSaved renders a short date or nothing", () => {
  expect(formatSaved("2025-02-13T12:00:00Z")).toBe("saved 13 Feb 2025");
  expect(formatSaved("")).toBe("");
  expect(formatSaved("not a date")).toBe("");
});

test("readerDocument wraps the html in a themed document", () => {
  const doc = readerDocument("<p>Hi</p>", { bg: "#111", text: "#eee", link: "#0af" });
  expect(doc.startsWith("<!doctype html>")).toBe(true);
  expect(doc).toContain('<meta charset="utf-8"><meta name="referrer" content="no-referrer">');
  expect(doc).toContain("background: #111");
  expect(doc).toContain("color: #eee");
  expect(doc).toContain("a { color: #0af");
  expect(doc).toContain("img { max-width: 100%");
  expect(doc).toContain("<body><p>Hi</p></body>");
  expect(doc).not.toContain("<script");
});

test("the sandbox allows popups and nothing else", () => {
  expect(READER_SANDBOX).toBe("allow-popups allow-popups-to-escape-sandbox");
  expect(READER_SANDBOX).not.toContain("allow-scripts");
  expect(READER_SANDBOX).not.toContain("allow-same-origin");
});
