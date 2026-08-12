// pattern: Functional Core
import { describe, expect, it } from "vitest";
import type { AssetSearchItem } from "../api/payloads";
import {
  EMPTY_FILTERS, PAGE_SIZE, clipboardToken, deleteConfirm, formatSize,
  mimeCategory, searchQuery, summarizeDeletes,
  MISSING_BLOCK_TEXT, refGroups, refUidChunks,
} from "./filesCore";

const item = (over: Partial<AssetSearchItem>): AssetSearchItem => ({
  sha256: "ab".repeat(32), filename: "pic.png", mime: "image/png",
  size: 1234, created_at: 1753000000000,
  url: `/assets/${"ab".repeat(32)}/pic.png`, description: null,
  status: "pending", describe_error: null, refs: [], ...over,
});

describe("searchQuery", () => {
  it("always carries limit and offset while omitting optional filters", () => {
    expect(searchQuery(EMPTY_FILTERS, 50)).toEqual({
      q: undefined,
      type: undefined,
      from_ms: undefined,
      to_ms: undefined,
      linked: undefined,
      limit: PAGE_SIZE,
      offset: 50,
    });
  });

  it("maps filters to typed query params", () => {
    expect(searchQuery({
      q: " cat ", type: "pdf", fromDate: "2026-07-01",
      toDate: "2026-07-31", linked: "orphan",
    }, 0)).toEqual({
      q: "cat",
      type: "pdf",
      from_ms: new Date(2026, 6, 1).getTime(),
      to_ms: new Date(2026, 6, 31, 23, 59, 59, 999).getTime(),
      linked: "orphan",
      limit: PAGE_SIZE,
      offset: 0,
    });
  });
});

describe("mimeCategory", () => {
  it.each([
    ["image/webp", "image"], ["application/pdf", "pdf"],
    ["text/csv", "document"], ["application/json", "document"],
    ["application/octet-stream", "other"],
  ])("%s -> %s", (mime, cat) => {
    expect(mimeCategory(mime)).toBe(cat);
  });
});

describe("clipboardToken", () => {
  it("uses image syntax for images", () => {
    expect(clipboardToken(item({}))).toBe(
      `![pic.png](/assets/${"ab".repeat(32)}/pic.png)`);
  });
  it("uses link syntax otherwise", () => {
    const i = item({ mime: "application/pdf", filename: "r.pdf" });
    expect(clipboardToken(i)).toBe(`[r.pdf](${i.url})`);
  });
});

describe("deleteConfirm", () => {
  it("is calm when nothing is linked", () => {
    const { message, loud } = deleteConfirm([item({}), item({})]);
    expect(loud).toBe(false);
    expect(message).toBe("Delete 2 files? None are linked from any page.");
  });
  it("singular form for one file", () => {
    expect(deleteConfirm([item({})]).message).toBe(
      "Delete 1 file? None are linked from any page.");
  });
  it("is loud and lists pages when linked", () => {
    const linked = item({
      filename: "used.png",
      refs: [{ uid: "b1", page_title: "AI" },
             { uid: "b2", page_title: "AI" },
             { uid: "b3", page_title: "Paper" }],
    });
    const { message, loud } = deleteConfirm([linked, item({})]);
    expect(loud).toBe(true);
    expect(message).toContain("Delete 2 files? 1 is still linked:");
    expect(message).toContain("used.png — linked from AI, Paper");
    expect(message).toContain(
      "This removes 3 links from 3 blocks; blocks left empty are deleted.");
  });
});

describe("summarizeDeletes", () => {
  it("plain success", () => {
    expect(summarizeDeletes(3, [])).toBe("Deleted 3 files.");
    expect(summarizeDeletes(1, [])).toBe("Deleted 1 file.");
  });
  it("reports failures", () => {
    expect(summarizeDeletes(2, ["a.png", "b.pdf"])).toBe(
      "Deleted 2 of 4 files. Failed: a.png, b.pdf");
  });
});

describe("formatSize", () => {
  it.each([
    [512, "512 B"], [2048, "2.0 KB"], [1536, "1.5 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
  ])("%d -> %s", (bytes, out) => {
    expect(formatSize(bytes)).toBe(out);
  });
});

describe("refUidChunks", () => {
  it("chunks ref uids at the block-refs cap of 50", () => {
    const refs = Array.from({ length: 101 }, (_, i) =>
      ({ uid: `u${i}`, page_title: "P" }));
    const chunks = refUidChunks(refs);
    expect(chunks.map((c) => c.length)).toEqual([50, 50, 1]);
    expect(chunks[0][0]).toBe("u0");
    expect(chunks[2][0]).toBe("u100");
  });

  it("returns no chunks for no refs", () => {
    expect(refUidChunks([])).toEqual([]);
  });
});

describe("refGroups", () => {
  it("groups refs by page in first-seen order with fetched text", () => {
    const refs = [
      { uid: "a1", page_title: "Alpha" },
      { uid: "b1", page_title: "Beta" },
      { uid: "a2", page_title: "Alpha" },
    ];
    const texts = {
      a1: { text: "first", page_title: "Alpha" },
      b1: { text: "second", page_title: "Beta" },
      a2: { text: "third", page_title: "Alpha" },
    };
    expect(refGroups(refs, texts)).toEqual([
      { page_id: 0, page_title: "Alpha", items: [
        { uid: "a1", text: "first", breadcrumbs: [] },
        { uid: "a2", text: "third", breadcrumbs: [] },
      ] },
      { page_id: 1, page_title: "Beta", items: [
        { uid: "b1", text: "second", breadcrumbs: [] },
      ] },
    ]);
  });

  it("falls back to a placeholder for uids the endpoint omitted", () => {
    const groups = refGroups([{ uid: "gone", page_title: "P" }], {});
    expect(groups[0].items[0].text).toBe(MISSING_BLOCK_TEXT);
  });
});
