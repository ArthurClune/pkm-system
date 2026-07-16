// pattern: Imperative Shell
// Build-time shell that measures the REAL Rollup output and the Workbox
// precache manifest, then hands plain size/ownership data to buildBudgets.ts
// (the pure policy) to decide pass/fail. It does no size arithmetic and no
// budget comparison itself -- everything that decides "over budget" lives in
// the functional core. Being over budget is a thrown build error, so a
// material asset/precache regression fails `vite build` and therefore
// `pnpm verify`.
//
// Two independent guards, matching the two size surfaces the plan cares about:
//   * generateBundle (Rollup): the app's own emitted chunks/assets -- eager
//     entry weight, single largest file, total output, and the bytes of
//     chunks WHOLLY owned by the Mermaid module graph (module-graph
//     reachability, never output-file-name substrings).
//   * manifestTransforms (Workbox): the exact final precache URL set -- the
//     cold-install offline-shell weight and entry count.
import type { Plugin } from "vite";
import {
  type OutputChunkInfo,
  type OutputFile,
  type PrecacheEntry,
  evaluateBundleBudgets,
  evaluatePrecacheBudgets,
  formatReport,
} from "./buildBudgets";

/** The slice of a Rollup emitted output the budget policy needs. */
interface EmittedChunk {
  type: "chunk";
  fileName: string;
  code: string;
  isEntry: boolean;
  modules: Record<string, unknown>;
}
interface EmittedAsset {
  type: "asset";
  fileName: string;
  source: string | Uint8Array;
}
type Emitted = EmittedChunk | EmittedAsset;

/** The slice of Rollup's PluginContext used to walk the module graph. */
interface ModuleGraph {
  getModuleIds(): IterableIterator<string>;
  getModuleInfo(id: string): {
    importedIds: readonly string[];
    dynamicallyImportedIds: readonly string[];
    isEntry: boolean;
  } | null;
}

/** One Workbox precache manifest entry (generateSW mode). */
interface ManifestEntry {
  url: string;
  revision: string | null;
  size: number;
}

/** Raw on-disk byte length of an emitted output (pre-gzip), the same number
 * the budgets are expressed in. */
function outputBytes(o: Emitted): number {
  if (o.type === "chunk") return Buffer.byteLength(o.code, "utf8");
  return typeof o.source === "string"
    ? Buffer.byteLength(o.source, "utf8")
    : o.source.byteLength;
}

/**
 * Module ids OWNED by the Mermaid graph: everything reachable from a Mermaid
 * package seed module (following both static and dynamic imports), MINUS
 * anything the eager app entry can reach through static imports. Subtracting
 * the eager-static set is what stops a module shared with the app from being
 * attributed to Mermaid, so the Mermaid raw-byte cap can never launder
 * unrelated application code. Seeds are Mermaid *package* modules under
 * node_modules; the ownership decision is graph reachability, not a match on
 * output chunk file names.
 */
function collectMermaidOwned(graph: ModuleGraph): Set<string> {
  const isSeed = (id: string): boolean =>
    id.includes("node_modules") && /[\\/]mermaid[\\/]/.test(id);

  const reach = (starts: string[], includeDynamic: boolean): Set<string> => {
    const seen = new Set<string>();
    const stack = [...starts];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      const info = graph.getModuleInfo(id);
      if (!info) continue;
      for (const dep of info.importedIds) stack.push(dep);
      if (includeDynamic) {
        for (const dep of info.dynamicallyImportedIds) stack.push(dep);
      }
    }
    return seen;
  };

  const allIds = [...graph.getModuleIds()];
  const entryIds = allIds.filter((id) => graph.getModuleInfo(id)?.isEntry);
  const seedIds = allIds.filter(isSeed);
  const appStatic = reach(entryIds, false);
  const mermaidGraph = reach(seedIds, true);
  const owned = new Set<string>();
  for (const id of mermaidGraph) if (!appStatic.has(id)) owned.add(id);
  return owned;
}

/**
 * Vite/Rollup plugin: enforce the production bundle budgets in generateBundle,
 * once, against the final emitted output.
 */
export function budgetPlugin(): Plugin {
  return {
    name: "pkm-budget-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      const outputs = Object.values(bundle) as unknown as Emitted[];
      const files: OutputFile[] = [];
      const chunks: OutputChunkInfo[] = [];
      for (const o of outputs) {
        const bytes = outputBytes(o);
        files.push({ fileName: o.fileName, bytes });
        if (o.type === "chunk") {
          chunks.push({
            fileName: o.fileName,
            bytes,
            isEntry: o.isEntry,
            moduleIds: Object.keys(o.modules),
          });
        }
      }
      const owned = collectMermaidOwned(this as unknown as ModuleGraph);
      const report = evaluateBundleBudgets(files, chunks, owned);
      const text = formatReport("bundle", report);
      console.log(text);
      if (!report.ok) {
        this.error(`production bundle over budget:\n${text}`);
      }
    },
  };
}

/**
 * Workbox manifestTransform: enforce the precache byte/entry budgets against
 * the exact final URL set Workbox will write into the service worker. Returns
 * the manifest unchanged (this is a guard, not a rewrite); throws to fail the
 * build when over budget.
 */
export function precacheBudgetTransform(entries: ManifestEntry[]): {
  manifest: ManifestEntry[];
  warnings: string[];
} {
  const precache: PrecacheEntry[] = entries.map((e) => ({
    url: e.url,
    bytes: e.size,
  }));
  const report = evaluatePrecacheBudgets(precache);
  const text = formatReport("precache", report);
  console.log(text);
  if (!report.ok) {
    throw new Error(`PWA precache over budget:\n${text}`);
  }
  return { manifest: entries, warnings: [] };
}
