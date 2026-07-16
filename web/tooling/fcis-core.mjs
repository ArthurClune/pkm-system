// pattern: Functional Core
// Pure FCIS policy: header parsing, exemption validation, relative-import
// resolution among a known file set, core->shell/mixed edge legality, and
// deterministic diagnostic sorting/formatting. No filesystem or TypeScript
// compiler I/O lives here -- see fcis.mjs for the imperative shell that
// gathers modules and edges (via the TypeScript compiler API) and calls
// into this module to decide what's wrong.
import { dirname, join, normalize } from "node:path/posix";

// Matches a "// pattern: <text>" (or "/// pattern: <text>") header comment
// line, capturing the text after the colon with surrounding space trimmed.
const HEADER_RE = /^\s*\/\/+\s*pattern:\s*(.+?)\s*$/;

const MIXED_UNAVOIDABLE_RE = /^Mixed \(unavoidable\)(?:\s*--\s*(.*))?$/;

/** Scans every line of a file's text for "// pattern: ..." header comments
 * and classifies what it found: missing (none anywhere), duplicate (more
 * than one anywhere), late (exactly one, but past the first five lines), or
 * the parsed contents of a single header within the first five lines. */
export function parseHeaderLines(lines) {
  const matches = [];
  lines.forEach((line, idx) => {
    const m = HEADER_RE.exec(line);
    if (m) matches.push({ line: idx + 1, raw: m[1] });
  });
  if (matches.length === 0) return { status: "missing" };
  if (matches.length > 1) return { status: "duplicate", lines: matches.map((m) => m.line) };
  const { line, raw } = matches[0];
  if (line > 5) return { status: "late", line, raw };
  return parseHeaderText(raw, line);
}

function parseHeaderText(raw, line) {
  if (raw === "Functional Core") return { status: "ok", kind: "core", line };
  if (raw === "Imperative Shell") return { status: "ok", kind: "shell", line };
  if (raw === "Mixed (needs refactoring)") {
    return { status: "ok", kind: "mixed", variant: "needs-refactoring", line };
  }
  const unavoidable = MIXED_UNAVOIDABLE_RE.exec(raw);
  if (unavoidable) {
    const reason = (unavoidable[1] ?? "").trim();
    if (!reason) return { status: "missing-reason", line };
    return { status: "ok", kind: "mixed", variant: "unavoidable", reason, line };
  }
  return { status: "unknown", raw, line };
}

/** Classifies one runtime module: an exact exemptions-map hit short-circuits
 * to "exempt" (no header required, no edge legality applied to or from it);
 * otherwise the file's own text is scanned for its header. */
export function classifyModule(file, fileText, exemptions) {
  if (Object.prototype.hasOwnProperty.call(exemptions, file)) {
    return { file, status: "exempt", reason: exemptions[file] };
  }
  return { file, ...parseHeaderLines(fileText.split("\n")) };
}

/** Diagnostics for a single module's own header -- independent of any edge
 * it participates in. */
export function headerDiagnostics(classification) {
  const { file, status } = classification;
  switch (status) {
    case "missing":
      return [{
        file, kind: "missing-header",
        message: `${file}: missing a "// pattern: ..." header in the first five lines`,
      }];
    case "late":
      return [{
        file, kind: "late-header", line: classification.line,
        message: `${file}:${classification.line}: "// pattern: ..." header must appear ` +
          "within the first five lines",
      }];
    case "duplicate":
      return [{
        file, kind: "duplicate-header",
        message: `${file}: multiple "// pattern: ..." headers found ` +
          `(lines ${classification.lines.join(", ")})`,
      }];
    case "unknown":
      return [{
        file, kind: "unknown-header", line: classification.line,
        message: `${file}:${classification.line}: unrecognized pattern "${classification.raw}"`,
      }];
    case "missing-reason":
      return [{
        file, kind: "missing-reason", line: classification.line,
        message: `${file}:${classification.line}: "Mixed (unavoidable)" requires a ` +
          'non-empty reason after "--"',
      }];
    case "ok":
    case "exempt":
      return [];
    default:
      return [];
  }
}

/** Every exemption entry must carry a real, non-empty reason -- no bare
 * paths and no globs (callers only ever look up exact file paths). */
export function validateExemptions(exemptions) {
  const diagnostics = [];
  for (const [file, reason] of Object.entries(exemptions)) {
    if (typeof reason !== "string" || reason.trim() === "") {
      diagnostics.push({
        file, kind: "invalid-exemption",
        message: `${file}: exemption reason must be a non-empty string`,
      });
    }
  }
  return diagnostics;
}

const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", ".d.ts", "/index.ts", "/index.tsx"];

/** Resolves a relative import specifier ("./x", "../y") from `fromFile`
 * against a known set of existing project-relative file paths, trying the
 * same .ts/.tsx/index/.d.ts forms TypeScript itself would. Returns the
 * resolved file's key in `existingFiles`, or null if `specifier` isn't
 * relative or nothing matching exists (an external package, most often). */
export function resolveRelativeSpecifier(fromFile, specifier, existingFiles) {
  if (!specifier.startsWith(".")) return null;
  const joined = normalize(join(dirname(fromFile), specifier));
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${joined}${suffix}`;
    if (existingFiles.has(candidate)) return candidate;
  }
  return null;
}

const RESTRICTED_TARGET_KINDS = new Set(["shell", "mixed"]);

/** The only enforced legality rule: a Functional Core module may not import,
 * re-export, or dynamically import an Imperative Shell or Mixed module at
 * runtime. Type-only edges are always permitted (they don't exist once
 * types are erased); every other direction (shell->core, shell->shell,
 * mixed->anything, edges touching an exempt module) is unrestricted. */
export function edgeDiagnostic(edge, sourceClassification, targetClassification) {
  if (edge.typeOnly) return null;
  if (sourceClassification.status !== "ok" || sourceClassification.kind !== "core") return null;
  if (targetClassification.status !== "ok") return null;
  if (!RESTRICTED_TARGET_KINDS.has(targetClassification.kind)) return null;
  const targetLabel = targetClassification.kind === "shell" ? "Imperative Shell" : "Mixed";
  return {
    file: edge.source, target: edge.target, kind: "forbidden-edge", line: edge.line,
    message: `${edge.source}:${edge.line}: Functional Core module ${edge.kind}s ` +
      `${targetLabel} module ${edge.target}`,
  };
}

/** Deterministic ordering: source file, then location, then target, then
 * diagnostic kind -- so a rerun with no code changes prints identically. */
export function sortDiagnostics(diagnostics) {
  return [...diagnostics].sort((a, b) =>
    a.file.localeCompare(b.file) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.target ?? "").localeCompare(b.target ?? "") ||
    a.kind.localeCompare(b.kind));
}

export function formatDiagnostic(diagnostic) {
  return diagnostic.message;
}
