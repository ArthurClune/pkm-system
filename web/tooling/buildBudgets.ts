// pattern: Functional Core
// Pure production/PWA size policy. Given plain descriptions of the build
// output (file sizes, chunk module ownership) and precache manifest, it
// decides pass/fail against fixed raw-byte/entry budgets and produces
// diagnostics. It reads no files and calls no build APIs -- viteBudgetPlugin.ts
// (the shell) gathers Rollup/Workbox data and hands it here. Budget baselines
// live in budgets.json; a single byte or entry over any limit fails.
import budgetsJson from "./budgets.json";

export interface BuildBudgets {
  /** Raw bytes of the synchronously-loaded entry chunk(s). */
  initialEntryBytes: number;
  /** Raw bytes of the single largest output file. */
  largestAssetBytes: number;
  /** Raw bytes of every emitted output file summed. */
  totalOutputBytes: number;
  /** Raw bytes of the Workbox precache manifest. */
  precacheBytes: number;
  /** Number of Workbox precache manifest entries. */
  precacheEntries: number;
  /** Raw bytes of chunks wholly owned by the Mermaid module graph. */
  mermaidOwnedBytes: number;
  /** Raw bytes of chunks wholly owned by the lazy PDF viewer module graph
   * (PdfViewer.tsx + react-pdf + pdfjs-dist). */
  pdfjsOwnedBytes: number;
}

/** One emitted output file: a chunk or an asset. */
export interface OutputFile {
  fileName: string;
  bytes: number;
}

/** A JavaScript output chunk plus the Rollup module ids it rendered. */
export interface OutputChunkInfo extends OutputFile {
  isEntry: boolean;
  moduleIds: readonly string[];
}

/** A resolved Workbox precache manifest entry. */
export interface PrecacheEntry {
  url: string;
  bytes: number;
}

export interface BudgetCheck {
  name: string;
  limit: number;
  actual: number;
  /** actual - limit; positive means over budget. */
  delta: number;
  ok: boolean;
}

export interface BudgetReport {
  ok: boolean;
  checks: readonly BudgetCheck[];
  /** Biggest output files/URLs first -- what to trim when a check is over. */
  largestContributors: readonly OutputFile[];
}

/** The committed budget baselines. */
export const BUDGETS: BuildBudgets = budgetsJson.limits;

function check(name: string, limit: number, actual: number): BudgetCheck {
  return { name, limit, actual, delta: actual - limit, ok: actual <= limit };
}

function topContributors(
  files: readonly OutputFile[],
  n = 5,
): readonly OutputFile[] {
  return [...files].sort((a, b) => b.bytes - a.bytes).slice(0, n);
}

/**
 * A chunk counts toward an owned budget only when EVERY module it rendered
 * is owned by that graph. This is deliberate: a chunk that mixes one owned
 * module with unrelated application code is not "owned", so a raw owned-bytes
 * cap can never be used to smuggle arbitrary bytes past the other budgets.
 * Ownership is decided from Rollup module ids, never output file names
 * (which a broad substring could over-match).
 */
export function chunkIsWhollyOwned(
  moduleIds: readonly string[],
  ownedModuleIds: ReadonlySet<string>,
): boolean {
  return moduleIds.length > 0 && moduleIds.every((id) => ownedModuleIds.has(id));
}

export function ownedChunkBytes(
  chunks: readonly OutputChunkInfo[],
  ownedModuleIds: ReadonlySet<string>,
): number {
  return chunks.reduce(
    (sum, c) => (chunkIsWhollyOwned(c.moduleIds, ownedModuleIds) ? sum + c.bytes : sum),
    0,
  );
}

/** Module-id sets for each specially-capped dependency graph. */
export interface OwnedModuleSets {
  mermaid: ReadonlySet<string>;
  pdfjs: ReadonlySet<string>;
}

export function evaluateBundleBudgets(
  files: readonly OutputFile[],
  chunks: readonly OutputChunkInfo[],
  owned: OwnedModuleSets,
  budgets: BuildBudgets = BUDGETS,
): BudgetReport {
  const entryBytes = chunks
    .filter((c) => c.isEntry)
    .reduce((sum, c) => sum + c.bytes, 0);
  const largest = files.reduce((max, f) => (f.bytes > max ? f.bytes : max), 0);
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  const checks = [
    check("initialEntryBytes", budgets.initialEntryBytes, entryBytes),
    check("largestAssetBytes", budgets.largestAssetBytes, largest),
    check("totalOutputBytes", budgets.totalOutputBytes, total),
    check("mermaidOwnedBytes", budgets.mermaidOwnedBytes,
      ownedChunkBytes(chunks, owned.mermaid)),
    check("pdfjsOwnedBytes", budgets.pdfjsOwnedBytes,
      ownedChunkBytes(chunks, owned.pdfjs)),
  ];
  return {
    ok: checks.every((c) => c.ok),
    checks,
    largestContributors: topContributors(files),
  };
}

export function evaluatePrecacheBudgets(
  entries: readonly PrecacheEntry[],
  budgets: BuildBudgets = BUDGETS,
): BudgetReport {
  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  const checks = [
    check("precacheBytes", budgets.precacheBytes, totalBytes),
    check("precacheEntries", budgets.precacheEntries, entries.length),
  ];
  const asFiles = entries.map((e) => ({ fileName: e.url, bytes: e.bytes }));
  return {
    ok: checks.every((c) => c.ok),
    checks,
    largestContributors: topContributors(asFiles),
  };
}

export function formatReport(title: string, report: BudgetReport): string {
  const lines = [`${title} budget report: ${report.ok ? "OK" : "OVER BUDGET"}`];
  for (const c of report.checks) {
    const status = c.ok ? "ok" : "OVER";
    const sign = c.delta >= 0 ? "+" : "";
    lines.push(
      `  [${status}] ${c.name}: ${c.actual} / ${c.limit} (${sign}${c.delta})`,
    );
  }
  if (report.largestContributors.length > 0) {
    lines.push("  largest contributors:");
    for (const f of report.largestContributors) {
      lines.push(`    ${f.bytes}  ${f.fileName}`);
    }
  }
  return lines.join("\n");
}
