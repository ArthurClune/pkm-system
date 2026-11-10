#!/usr/bin/env node
// pattern: Imperative Shell
// Thin CLI shell for `pnpm check:fcis`: walks web/src for runtime .ts/.tsx
// modules, reads each one's text and AST (via the TypeScript compiler API)
// to find its header and its relative import/export/dynamic-import edges,
// then hands plain data to fcis-core.ts's pure policy to decide what (if
// anything) is wrong. All filesystem access, AST parsing, and process exit
// live here; fcis-core.ts never touches the disk or the compiler.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  classifyModule,
  edgeDiagnostic,
  formatDiagnostic,
  headerDiagnostics,
  resolveRelativeSpecifier,
  sortDiagnostics,
  validateExemptions,
} from "./fcis-core.ts";
import type { Classification, Edge } from "./fcis-core.ts";

const TOOLING_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = dirname(TOOLING_DIR);
const SRC_ROOT = join(WEB_ROOT, "src");
const EXEMPTIONS_PATH = join(TOOLING_DIR, "fcis-exemptions.json");

function toPosixRelative(fromRoot: string, full: string): string {
  return relative(fromRoot, full).split(/\\/).join("/");
}

/** Every `.ts`/`.tsx` file under src, relative to the web/ root with posix
 * separators -- the universe resolveRelativeSpecifier resolves against. */
function listSrcFiles(): string[] {
  const files: string[] = [];
  const stack = [SRC_ROOT];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        files.push(toPosixRelative(WEB_ROOT, full));
      }
    }
  }
  return files;
}

function isRuntimeFile(file: string): boolean {
  return !/\.test\.tsx?$/.test(file) && !/\.d\.ts$/.test(file);
}

function importIsTypeOnly(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false; // side-effect import: always runtime
  if (clause.isTypeOnly) return true;
  if (clause.name) return false; // default import binds a value
  const named = clause.namedBindings;
  if (!named) return false;
  if (named.kind === ts.SyntaxKind.NamespaceImport) return false; // `import * as x`
  return named.elements.length > 0 && named.elements.every((el) => el.isTypeOnly);
}

function exportIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (!clause) return false; // `export * from "./x"`
  if (clause.kind === ts.SyntaxKind.NamespaceExport) return false; // `export * as ns from`
  return clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly);
}

/** Recursively collects every relative-import edge in a source file: static
 * imports, re-exports with a module specifier, and dynamic import() calls
 * -- wherever in the file they appear. */
interface RawEdge {
  specifier: string;
  kind: Edge["kind"];
  typeOnly: boolean;
  node: ts.Node;
}

function collectEdges(sourceFile: ts.SourceFile): RawEdge[] {
  const edges: RawEdge[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({
        specifier: node.moduleSpecifier.text,
        kind: "import",
        typeOnly: importIsTypeOnly(node),
        node,
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      edges.push({
        specifier: node.moduleSpecifier.text,
        kind: "export",
        typeOnly: exportIsTypeOnly(node),
        node,
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      edges.push({
        specifier: node.arguments[0].text,
        kind: "dynamic-import",
        typeOnly: false,
        node,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return edges;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function readExemptions(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(EXEMPTIONS_PATH, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${EXEMPTIONS_PATH}: expected an object of file -> reason`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

function main(): void {
  const allFiles = new Set(listSrcFiles());
  const runtimeFiles = [...allFiles].filter(isRuntimeFile).sort();
  const exemptions = readExemptions();

  const diagnostics = [...validateExemptions(exemptions)];

  const classifications = new Map<string, Classification>();
  const texts = new Map<string, string>();
  for (const file of runtimeFiles) {
    const text = readFileSync(join(WEB_ROOT, file), "utf8");
    texts.set(file, text);
    const classification = classifyModule(file, text, exemptions);
    classifications.set(file, classification);
    diagnostics.push(...headerDiagnostics(classification));
  }

  const getClassification = (file: string): Classification =>
    classifications.get(file) ?? {
      file,
      status: "exempt",
      reason: "non-runtime target (e.g. a .d.ts declaration file)",
    };

  for (const file of runtimeFiles) {
    const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
      file, texts.get(file) ?? "", ts.ScriptTarget.Latest, true, scriptKind);
    const sourceClassification = getClassification(file);
    for (const rawEdge of collectEdges(sourceFile)) {
      const target = resolveRelativeSpecifier(file, rawEdge.specifier, allFiles);
      if (!target) continue; // external package or unresolvable: out of scope
      const edge: Edge = {
        source: file, target, kind: rawEdge.kind, typeOnly: rawEdge.typeOnly,
        line: lineOf(sourceFile, rawEdge.node),
      };
      const diagnostic = edgeDiagnostic(edge, sourceClassification, getClassification(target));
      if (diagnostic) diagnostics.push(diagnostic);
    }
  }

  const sorted = sortDiagnostics(diagnostics);
  if (sorted.length > 0) {
    for (const diagnostic of sorted) console.error(formatDiagnostic(diagnostic));
    console.error(`\ncheck:fcis found ${sorted.length} problem(s).`);
    process.exitCode = 1;
    return;
  }
  console.log(`check:fcis: ${runtimeFiles.length} runtime modules, no boundary violations.`);
}

main();
