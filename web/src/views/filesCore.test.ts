// pattern: Functional Core
import { describe, expect, it } from "vitest";
import type { AssetSearchItem } from "../api/payloads";
import {
  EMPTY_FILTERS, PAGE_SIZE, clipboardToken, deleteConfirm, formatSize,
  mimeCategory, searchParams, summarizeDeletes,
} from "./filesCore";

const item = (over: Partial<AssetSearchItem>): AssetSearchItem => ({
  sha256: "ab".repeat(32), filename: "pic.png", mime: "image/png",
  size: 1234, created_at: 1753000000000,
  url: `/assets/${"ab".repeat(32)}/pic.png`, description: null,
  status: "pending", describe_error: null, refs: [], ...over,
});

describe("searchParams", () => {
  it("always carries limit and offset", () => {
    const p = new URLSearchParams(searchParams(EMPTY_FILTERS, 50));
    expect(p.get("limit")).toBe(String(PAGE_SIZE));
    expect(p.get("offset")).toBe("50");
    expect(p.get("q")).toBeNull();
    expect(p.get("linked")).toBeNull();
  });

  it("maps filters to query params", () => {
    const p = new URLSearchParams(searchParams({
      q: " cat ", type: "pdf", fromDate: "2026-07-01",
      toDate: "2026-07-31", linked: "orphan",
    }, 0));
    expect(p.get("q")).toBe("cat");
    expect(p.get("type")).toBe("pdf");
    expect(p.get("linked")).toBe("orphan");
    expect(Number(p.get("from_ms"))).toBe(
      new Date(2026, 6, 1).getTime());
    expect(Number(p.get("to_ms"))).toBe(
      new Date(2026, 6, 31, 23, 59, 59, 999).getTime());
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
