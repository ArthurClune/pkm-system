import { describe, expect, it } from "vitest";
import {
  type BuildBudgets,
  type OutputChunkInfo,
  type OutputFile,
  chunkIsMermaidOwned,
  evaluateBundleBudgets,
  evaluatePrecacheBudgets,
  formatReport,
  mermaidOwnedBytes,
} from "./buildBudgets";

const budgets: BuildBudgets = {
  initialEntryBytes: 700,
  largestAssetBytes: 800,
  totalOutputBytes: 2000,
  precacheBytes: 1500,
  precacheEntries: 3,
  mermaidOwnedBytes: 500,
};

// Baseline bundle: entry 700, largest asset 800 (a wasm), one fully
// mermaid-owned chunk 500. Totals land exactly on every limit.
const owned = new Set(["m1", "m2"]);
function baselineChunks(): OutputChunkInfo[] {
  return [
    { fileName: "index-abc.js", bytes: 700, isEntry: true, moduleIds: ["app"] },
    { fileName: "mermaid-abc.js", bytes: 500, isEntry: false, moduleIds: ["m1", "m2"] },
  ];
}
function baselineFiles(): OutputFile[] {
  return [
    { fileName: "index-abc.js", bytes: 700 },
    { fileName: "sqlite-abc.wasm", bytes: 800 },
    { fileName: "mermaid-abc.js", bytes: 500 },
  ];
}

describe("evaluateBundleBudgets", () => {
  it("passes when every metric is exactly at its limit", () => {
    const report = evaluateBundleBudgets(
      baselineFiles(), baselineChunks(), owned, budgets);
    expect(report.ok).toBe(true);
    for (const c of report.checks) {
      expect(c.delta, c.name).toBeLessThanOrEqual(0);
      expect(c.ok, c.name).toBe(true);
    }
    const entry = report.checks.find((c) => c.name === "initialEntryBytes")!;
    expect(entry.actual).toBe(700);
    expect(entry.delta).toBe(0);
  });

  it("fails when the entry is one byte over", () => {
    const chunks = baselineChunks();
    chunks[0] = { ...chunks[0], bytes: 701 };
    const files = baselineFiles();
    files[0] = { ...files[0], bytes: 701 };
    const report = evaluateBundleBudgets(files, chunks, owned, budgets);
    expect(report.ok).toBe(false);
    const entry = report.checks.find((c) => c.name === "initialEntryBytes")!;
    expect(entry.ok).toBe(false);
    expect(entry.delta).toBe(1);
  });

  it("totals depend only on bytes, not on hashed file names", () => {
    const a = evaluateBundleBudgets(
      baselineFiles(), baselineChunks(), owned, budgets);
    // same bytes, different content hashes in every name
    const rehash = (f: OutputFile): OutputFile =>
      ({ ...f, fileName: f.fileName.replace("abc", "zzz") });
    const b = evaluateBundleBudgets(
      baselineFiles().map(rehash),
      baselineChunks().map((c) => ({ ...c, fileName: c.fileName.replace("abc", "zzz") })),
      owned, budgets);
    const total = (r: typeof a) =>
      r.checks.find((c) => c.name === "totalOutputBytes")!.actual;
    expect(total(a)).toBe(total(b));
    expect(total(a)).toBe(2000);
  });

  it("reports largest contributors, biggest first", () => {
    const report = evaluateBundleBudgets(
      baselineFiles(), baselineChunks(), owned, budgets);
    expect(report.largestContributors[0].fileName).toBe("sqlite-abc.wasm");
    expect(report.largestContributors[0].bytes).toBe(800);
    // descending
    const bytes = report.largestContributors.map((f) => f.bytes);
    expect([...bytes].sort((x, y) => y - x)).toEqual(bytes);
  });
});

describe("mermaid ownership", () => {
  it("a chunk is mermaid-owned only when every module is owned", () => {
    expect(chunkIsMermaidOwned(["m1", "m2"], owned)).toBe(true);
    expect(chunkIsMermaidOwned(["m1", "app"], owned)).toBe(false);
    expect(chunkIsMermaidOwned([], owned)).toBe(false);
  });

  it("the mermaid exception cannot absorb an unrelated chunk", () => {
    // A chunk that mixes one owned module with an unrelated app module must
    // NOT count toward the mermaid budget, however large it is -- otherwise
    // arbitrary code could hide under the mermaid raw-byte cap.
    const chunks: OutputChunkInfo[] = [
      { fileName: "mermaid-pure.js", bytes: 500, isEntry: false, moduleIds: ["m1", "m2"] },
      { fileName: "smuggled.js", bytes: 99999, isEntry: false, moduleIds: ["m1", "app"] },
    ];
    expect(mermaidOwnedBytes(chunks, owned)).toBe(500);
  });

  it("bundle evaluation counts only fully-owned chunks as mermaid", () => {
    const chunks: OutputChunkInfo[] = [
      ...baselineChunks(),
      { fileName: "smuggled.js", bytes: 99999, isEntry: false, moduleIds: ["m1", "app"] },
    ];
    const files: OutputFile[] = [...baselineFiles(), { fileName: "smuggled.js", bytes: 99999 }];
    const report = evaluateBundleBudgets(files, chunks, owned, budgets);
    const mermaid = report.checks.find((c) => c.name === "mermaidOwnedBytes")!;
    expect(mermaid.actual).toBe(500);
    expect(mermaid.ok).toBe(true);
  });
});

describe("evaluatePrecacheBudgets", () => {
  const pbudgets = budgets;
  it("passes at exactly the byte and entry limits", () => {
    const report = evaluatePrecacheBudgets([
      { url: "/a.js", bytes: 500 },
      { url: "/b.js", bytes: 500 },
      { url: "/c.wasm", bytes: 500 },
    ], pbudgets);
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "precacheBytes")!.actual).toBe(1500);
    expect(report.checks.find((c) => c.name === "precacheEntries")!.actual).toBe(3);
  });

  it("fails when one entry over the count limit", () => {
    const report = evaluatePrecacheBudgets([
      { url: "/a.js", bytes: 1 },
      { url: "/b.js", bytes: 1 },
      { url: "/c.js", bytes: 1 },
      { url: "/d.js", bytes: 1 },
    ], pbudgets);
    expect(report.ok).toBe(false);
    const entries = report.checks.find((c) => c.name === "precacheEntries")!;
    expect(entries.ok).toBe(false);
    expect(entries.delta).toBe(1);
  });

  it("fails when one byte over the byte limit", () => {
    const report = evaluatePrecacheBudgets([
      { url: "/a.js", bytes: 1501 },
    ], pbudgets);
    const bytesCheck = report.checks.find((c) => c.name === "precacheBytes")!;
    expect(bytesCheck.ok).toBe(false);
    expect(bytesCheck.delta).toBe(1);
  });
});

describe("formatReport", () => {
  it("names limits, actuals, deltas, over-status and contributors", () => {
    const chunks = baselineChunks();
    chunks[0] = { ...chunks[0], bytes: 701 };
    const files = baselineFiles();
    files[0] = { ...files[0], bytes: 701 };
    const report = evaluateBundleBudgets(files, chunks, owned, budgets);
    const text = formatReport("bundle", report);
    expect(text).toContain("initialEntryBytes");
    expect(text).toContain("701");
    expect(text).toContain("700");
    expect(text.toUpperCase()).toContain("OVER");
    expect(text).toContain("sqlite-abc.wasm");
  });
});
