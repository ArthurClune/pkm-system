// pattern: Imperative Shell
import { readFileSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const toolingDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(toolingDir));
export const registry = JSON.parse(
  readFileSync(`${toolingDir}/brandRegistry.gen.json`, "utf8"),
);

// A registry path: a trailing "/" is a directory prefix, otherwise a glob
// where `**/` is zero or more directories, a bare `**` crosses directories
// and `*` does not (the server lint's `_glob_to_regex` translation).
export function pathMatcher(pattern) {
  if (pattern.endsWith("/")) return (p) => p.startsWith(pattern);
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0001")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0001/g, "(?:.*/)?")
    .replace(/\u0000/g, ".*");
  const re = new RegExp(`^${body}$`);
  return (p) => re.test(p);
}

export const testMintSites = registry.testMintSites.map(pathMatcher);
const testCode = registry.testCode.map(pathMatcher);
export const optOutFiles = registry.optOutFiles.map(pathMatcher);
const mintSites = new Map(
  Object.entries(registry.mintSites).map(
    ([brand, paths]) => [brand, paths.map(pathMatcher)],
  ),
);

// A repo-relative posix path; ESLint hands either an absolute path or one
// relative to the web root.
export function repoPath(filename) {
  const rel = relative(repoRoot, filename);
  return rel.split(sep).join("/");
}

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

// A test by name, or by location in the registry's `testCode`.
export function isTestCode(path) {
  return TEST_FILE.test(path) || testCode.some((m) => m(path));
}

// The web's test files as flat-config globs, relative to the web root, for
// the config block that lets tests import the test mint module.
export const WEB_PREFIX = "web/";
export const testFileGlobs = [
  "**/*.test.{ts,tsx}",
  ...registry.testCode
    .filter((p) => p.startsWith(WEB_PREFIX))
    .map((p) => p.slice(WEB_PREFIX.length))
    .map((p) => (p.endsWith("/") ? `${p}**` : p)),
];

// The test mint module may mint every brand.
export function isMintSite(brand, path) {
  return testMintSites.some((m) => m(path))
    || (mintSites.get(brand) ?? []).some((m) => m(path));
}